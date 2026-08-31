import * as cheerio from 'cheerio';
import { Logger } from '../lib/logger';
import { sleep } from '../lib/delay';
import { calculateMatchScore } from '../sync/trackMatching';

export interface SearchResult {
  videoId: string;
  title: string;
  duration: string;
  views: string;
  channel: string;
  description?: string;
  matchScore?: {
    score: number;
    breakdown: ReturnType<typeof calculateMatchScore>['breakdown'];
  };
}

/**
 * Parse a scraped YouTube view-count string ("1.5M views", "500K views",
 * "1,234,567 views") into a number. Returns 0 for unknown/unparseable values.
 */
export function parseViewCount(views: string | undefined): number {
  if (!views) return 0;
  const match = views.replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return 0;
  const num = parseFloat(match[1] ?? '');
  if (isNaN(num)) return 0;
  const unit = (match[2] || '').toUpperCase();
  const multiplier = unit === 'B' ? 1e9 : unit === 'M' ? 1e6 : unit === 'K' ? 1e3 : 1;
  return Math.round(num * multiplier);
}

/**
 * YouTube's scraped video data structure (partial)
 * Note: This is an incomplete type definition - YouTube's actual structure is much larger
 */
interface YouTubeScrapedVideoData {
  videoRenderer?: {
    videoId?: string;
    title?: {
      runs?: Array<{ text?: string }>;
      simpleText?: string;
    };
    lengthText?: { simpleText?: string };
    viewCountText?: { simpleText?: string };
    ownerText?: { runs?: Array<{ text?: string }> };
    longBylineText?: { runs?: Array<{ text?: string }> };
  };
}

/**
 * ⚠️ **LEGAL DISCLAIMER** ⚠️
 *
 * This module scrapes YouTube search results to avoid the expensive YouTube Data API search endpoint,
 * which costs 100 quota units per search (10,000 daily quota = only 100 searches per day).
 *
 * **IMPORTANT CONSIDERATIONS:**
 *
 * 1. **Terms of Service**: This scraping approach may violate YouTube's Terms of Service.
 *    Use at your own risk and consider the legal implications for your jurisdiction.
 *
 * 2. **Rate Limiting**: YouTube may detect and block scraping attempts. This implementation includes:
 *    - Realistic browser user-agent headers
 *    - Delays between requests (1 second)
 *    - Limited number of results per query
 *
 * 3. **Fragility**: YouTube's HTML structure may change at any time, breaking this scraper.
 *    Regular maintenance may be required.
 *
 * 4. **Alternative**: For production use or commercial applications, use the official YouTube Data API
 *    despite the quota costs, or apply for quota increases at:
 *    https://support.google.com/youtube/contact/yt_api_form
 *
 * 5. **Recommended Use Cases**:
 *    - Personal/hobby projects with low traffic
 *    - Development/testing environments
 *    - Proof-of-concept implementations
 *
 * For production deployments, strongly consider either:
 * - Purchasing additional YouTube API quota
 * - Implementing a caching layer to reduce API calls
 * - Using the official API search with selective caching
 * - Implementing user-driven search (users manually select videos)
 */

/**
 * Scrape YouTube search results for a given query
 * This avoids the expensive YouTube API search which costs 100 quota units per search
 *
 * @param query - Search query string
 * @param maxResults - Maximum number of results to return (default: 3)
 * @returns Array of search results with video IDs, titles, durations, views, and channels
 * @throws Error if scraping fails or is blocked by YouTube
 */
const SCRAPE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Cookie jar shared across scrapes, because `fetch` is stateless and Google's bot gate is
 * cookie-based.
 *
 * When YouTube flags the request it 302s to google.com/sorry/, which (without any CAPTCHA)
 * redirects BACK carrying `?google_abuse=GOOGLE_ABUSE_EXEMPTION=...` - a Set-Cookie payload
 * smuggled in the query string. YouTube consumes it, sets the exemption as a cookie, and
 * redirects to the clean URL. A stateless fetch drops that cookie, so the clean URL is
 * un-exempted and bounces straight back to /sorry/ - an infinite loop (the "redirect count
 * exceeded" failure). Persisting cookies lets the exemption stick; it is valid ~1h, so one
 * grant covers the rest of the sync.
 *
 * Seeded with SOCS, which separately opts out of the cookie-consent redirect flow.
 */
const SOCS_CONSENT_COOKIE =
  'CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwMTA5LjA1X3AwGgJlbiACGgYIgL3vrwY';

const cookieJar = new Map<string, string>([['SOCS', SOCS_CONSENT_COOKIE]]);

/**
 * Empty the jar back to its seeded state. Exported for tests only: the jar is module scope and
 * lives for the process, so a test that absorbs GOOGLE_ABUSE_EXEMPTION would change the Cookie
 * header every later test sees.
 */
export function __resetCookieJar(): void {
  cookieJar.clear();
  cookieJar.set('SOCS', SOCS_CONSENT_COOKIE);
}

function jarCookieHeader(): string {
  return [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Absorbs Set-Cookie headers from a response into the jar (name=value only; scoping is not
 *  modelled - every host we touch here is a Google property). */
function absorbSetCookies(response: Response): void {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookies) {
    const pair = raw.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    if (!cookieJar.has(name) || cookieJar.get(name) !== value) {
      Logger.debug('Scraper stored cookie', { name });
    }
    cookieJar.set(name, value);
  }
}

/**
 * Fetch that follows redirects BY HAND so a bounce is visible.
 *
 * With the default `redirect: 'follow'`, undici silently chases up to 20 hops and then throws
 * "redirect count exceeded" having discarded every URL it visited - which tells you nothing about
 * WHERE it was being sent (consent gate? /sorry/ bot check? something else?). Following manually
 * logs each hop's Location and puts the whole chain in the thrown error.
 */
async function fetchShowingRedirects(
  startUrl: string,
  signal: AbortSignal,
  maxRedirects = 5,
): Promise<Response> {
  let currentUrl = startUrl;
  const chain: string[] = [];

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetch(currentUrl, {
      signal,
      redirect: 'manual',
      headers: { ...SCRAPE_HEADERS, Cookie: jarCookieHeader() },
    });

    // Keep any cookies the hop hands back - notably GOOGLE_ABUSE_EXEMPTION from the /sorry/
    // bounce, which is what actually clears the gate on the next request.
    absorbSetCookies(response);

    // Not a redirect - this is the real response.
    if (response.status < 300 || response.status > 399) return response;

    const location = response.headers.get('location');
    chain.push(`${response.status} ${currentUrl} -> ${location ?? '(no Location header)'}`);
    Logger.warn('YouTube search redirected', {
      hop: hop + 1,
      status: response.status,
      from: currentUrl,
      to: location,
    });

    // A redirect with no Location is not followable - hand it back and let the caller report it.
    if (!location) return response;
    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error(
    `YouTube redirected more than ${maxRedirects} times (likely a consent or bot gate). Chain: ${chain.join(' | ')}`,
  );
}

/**
 * Pull the search results out of a YouTube results page.
 *
 * Exported and kept pure so it can be tested without a network at all: this is where the scrape is
 * most fragile (YouTube's markup is not a contract) and it was entirely unexecuted by any test.
 * Anything unreadable yields fewer results rather than throwing - a search that finds nothing is
 * recoverable, a sync that dies is not.
 */
const YT_INITIAL_DATA = 'var ytInitialData = ';

/**
 * The index of the `}` closing the object that opens at `from`, or -1 if it never closes.
 *
 * Needed because the object cannot be matched with a regex. `{.*?}` is lazy and stops at the first
 * `};`, and a YouTube search page carries that sequence inside string values often enough that the
 * capture is truncated on most searches - the JSON is then invalid, parsing throws, and the page
 * reads as "no results". `{.*}` is no better: greedy, it runs past the object to the last `};` on
 * the line. Depth counting is the only way to find the real end, and it has to ignore braces inside
 * strings and anything escaped.
 */
export function findObjectEnd(source: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = from; i < source.length; i++) {
    const char = source[i];

    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
    } else if (!inString) {
      if (char === '{') depth++;
      else if (char === '}' && --depth === 0) return i;
    }
  }
  return -1;
}

export function parseSearchResultsHtml(html: string, maxResults: number): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  // YouTube embeds the results as JSON in a script tag.
  let videoData: YouTubeScrapedVideoData[] = [];
  let sawInitialData = false;

  $('script').each((_i, elem) => {
    const scriptContent = $(elem).html();
    if (!scriptContent?.includes(YT_INITIAL_DATA)) return;
    sawInitialData = true;

    const start = scriptContent.indexOf(YT_INITIAL_DATA) + YT_INITIAL_DATA.length;
    const end = findObjectEnd(scriptContent, start);
    if (end === -1) return;

    try {
      const data = JSON.parse(scriptContent.slice(start, end + 1));
      const contents =
        data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer
          ?.contents;

      if (contents && contents[0]?.itemSectionRenderer?.contents) {
        videoData = contents[0].itemSectionRenderer.contents;
      }
    } catch {
      // A script tag we cannot parse is not fatal - keep looking at the others.
    }
  });

  // A page that carried the data and still yielded nothing is a parser that has stopped
  // understanding YouTube, not a search with no results. Those are indistinguishable to the caller
  // - both return an empty list - so the difference has to be said out loud here or the next time
  // YouTube changes its markup it will look like an artist nobody has uploaded.
  if (sawInitialData && videoData.length === 0) {
    Logger.warn('YouTube search page carried ytInitialData but no video items could be read', {
      htmlLength: html.length,
    });
  }

  Logger.debug(`🔍 Found ${videoData.length} potential video items`);

  for (const item of videoData) {
    if (item.videoRenderer && results.length < maxResults) {
      const video = item.videoRenderer;

      const videoId = video.videoId;
      const title = video.title?.runs?.[0]?.text || video.title?.simpleText || 'Unknown Title';
      const duration = video.lengthText?.simpleText || 'Unknown Duration';
      const views = video.viewCountText?.simpleText || 'Unknown Views';
      // longBylineText carries the real channel name; ownerText is the fallback.
      let channel = 'Unknown Channel';
      if (video.longBylineText?.runs?.[0]?.text) {
        channel = video.longBylineText.runs[0].text;
      } else if (video.ownerText?.runs?.[0]?.text) {
        channel = video.ownerText.runs[0].text;
      }

      // An item with no videoId is unusable - skip it WITHOUT counting it against maxResults.
      if (videoId) {
        results.push({ videoId, title, duration, views, channel });
        Logger.debug(`✅ Found video: ${title} (${videoId}) by ${channel}`);
      }
    }
  }

  return results;
}

export async function scrapeYouTubeSearch(
  query: string,
  maxResults: number = 3,
): Promise<SearchResult[]> {
  const startTime = Date.now();
  Logger.debug(`🕷️ Scraping YouTube search for: "${query}"`);

  try {
    // Construct YouTube search URL
    const searchQuery = encodeURIComponent(query);
    const url = `https://www.youtube.com/results?search_query=${searchQuery}`;

    Logger.debug(`📡 Fetching: ${url}`);

    // Fetch the search results page.
    // - The SOCS consent cookie stops YouTube from bouncing the request into its
    //   cookie-consent redirect flow, which otherwise loops until fetch throws
    //   "redirect count exceeded" (the real cause of search failures under load).
    // - The timeout guards against YouTube holding a connection open, which would
    //   hang the whole sync on one track. A timed-out/failed search is caught and
    //   the track is skipped (searchTracksForVideos), so the sync keeps going.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let response: Response;
    try {
      response = await fetchShowingRedirects(url, controller.signal);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      // Log the ACTUAL response, not just the status - if YouTube served a bot/consent gate or a
      // rate-limit page, the body is the only thing that says so.
      const body = await response.text().catch(() => '(body unreadable)');
      Logger.warn('YouTube search returned an unexpected response', {
        status: response.status,
        statusText: response.statusText,
        url: response.url || url,
        contentType: response.headers.get('content-type'),
        bodySnippet: body.slice(0, 500),
      });
      throw new Error(
        `HTTP ${response.status}: ${response.statusText} (url: ${response.url || url})`,
      );
    }

    const html = await response.text();
    Logger.debug(`📄 Received HTML page (${html.length} chars)`);

    const results = parseSearchResultsHtml(html, maxResults);

    Logger.debug(
      `🕷️ Scraping completed in ${Date.now() - startTime}ms, found ${results.length} videos`,
    );
    return results;
  } catch (error) {
    Logger.error('YouTube scraping failed', {}, error);
    throw new Error(
      `Failed to scrape YouTube search: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { cause: error },
    );
  }
}

/**
 * Search and score YouTube videos for a track
 * Uses the same calculateMatchScore function as the modal for consistent scoring
 * Returns all results with scores so both modal and sync can use it
 */
export async function searchAndScoreVideos(
  artist: string,
  songName: string,
  maxResults: number = 5,
): Promise<Array<SearchResult>> {
  const queries = [
    `"${artist}" "${songName}" official music video`,
    `"${artist}" "${songName}" official video`,
    `"${artist}" "${songName}" music video`,
    `${artist} ${songName} official`,
    `${artist} ${songName}`,
  ];

  const scoredResults: Array<SearchResult> = [];

  for (const query of queries) {
    try {
      Logger.debug(`🎵 Searching for music video: ${query}`);
      const results = await scrapeYouTubeSearch(query, maxResults);

      if (results.length > 0) {
        // Score all results using the same calculateMatchScore function as the modal
        for (const result of results) {
          const spotifyTrack = {
            id: '',
            name: songName,
            artist: artist,
          };

          const youtubeVideo = {
            id: result.videoId,
            title: result.title,
            description: '',
            channelTitle: result.channel,
            viewCount: parseViewCount(result.views),
          };

          const { score, breakdown } = calculateMatchScore(spotifyTrack, youtubeVideo);

          Logger.debug(
            `📊 Video "${result.title}" by ${result.channel} scored ${(score * 100).toFixed(0)}%`,
          );

          if (score >= 0.4) {
            scoredResults.push({
              ...result,
              matchScore: { score, breakdown },
            });
          }
        }

        // If we found good matches, return them (sorted by score)
        if (scoredResults.length > 0) {
          Logger.debug(`🎯 Found ${scoredResults.length} videos matching ${artist} - ${songName}`);
          return scoredResults;
        }
      }
    } catch (error) {
      Logger.warn('Search failed for query', { query }, error);
      continue;
    }

    // Add a small delay between searches to be respectful
    await sleep(1000);
  }

  Logger.debug(`❌ No suitable videos found for ${artist} - ${songName}`);
  return [];
}

/**
 * Search for a music video and return the best match
 * Uses searchAndScoreVideos internally for consistent scoring
 */
export async function searchMusicVideo(artist: string, songName: string): Promise<string | null> {
  const results = await searchAndScoreVideos(artist, songName, 5);

  if (results.length === 0) {
    return null;
  }

  // Find the best match (highest normalized score from the algorithm)
  let bestMatch = results[0]!;
  if (!bestMatch.matchScore) {
    return null;
  }

  for (const result of results) {
    if (!result.matchScore) continue;

    // Use the actual normalized score from calculateMatchScore, not a reconstruction
    if (result.matchScore.score > bestMatch.matchScore!.score) {
      bestMatch = result;
    }
  }

  Logger.debug(
    `🎯 Selected best match: "${bestMatch.title}" by ${bestMatch.channel} (${(bestMatch.matchScore!.score * 100).toFixed(0)}%)`,
  );
  return bestMatch.videoId;
}
