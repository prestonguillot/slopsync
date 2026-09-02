import { Router, Request } from 'express';
import { YoutubeApiError, YtPlaylist } from '../youtube/client';
import { ensureValidYouTubeToken } from '../youtube/auth';
import { authExpired, signalAuthExpired } from '../auth/authExpired';
import { Logger } from '../lib/logger';
import { getSecureCookieOptions } from '../auth/cookieParser';
import { validate, schemas, ValidatedRequest } from '../lib/validation';
import { formatRetryAfter } from '../lib/errorFormatter';
import { CacheDuration, setCache } from '../lib/cache';
import { youtubeCircuitBreaker } from '../lib/circuitBreaker';
import { describeRetryWait, youtubeWritesBlocked } from '../youtube/writes';
import {
  parseSpotifyTokenCookie,
  parseYouTubeTokenCookie,
  validateAndSerializeSpotifyTokens,
} from '../auth/cookieParser';
import { issueOAuthState, verifyOAuthState, canonicalLoginUrl } from '../auth/oauthState';
import {
  getAuthorizeUrl,
  exchangeCodeForTokens,
  getCurrentUser,
  getUserPlaylists,
  getPlaylist,
  SpotifyApiError,
  SpotifyIncompleteResponseError,
} from '../spotify/client';
import { ensureValidSpotifyToken } from '../spotify/auth';
import {
  fetchAllYoutubePlaylists,
  findSyncedYoutubePlaylist,
  syncedPlaylistTitle,
} from '../youtube/playlist';
import { z } from 'zod';
import ejs from 'ejs';
import path from 'path';

const router = Router();

// Cookie name for the one-time OAuth state value used for CSRF protection.
const SPOTIFY_OAUTH_STATE_COOKIE = 'spotify_oauth_state';

// Spotify login
router.get('/login', (req, res) => {
  Logger.requestStart('Spotify Login Request', {
    requestUrl: req.originalUrl,
  });

  // Before the cookie exists, not after: minting it on a host the callback will not be sent to
  // guarantees a state mismatch.
  const canonical = canonicalLoginUrl(req, process.env.SPOTIFY_REDIRECT_URI);
  if (canonical) {
    Logger.auth('Spotify', 'moving the login to the callback host', { canonical });
    return res.redirect(canonical);
  }

  const scopes = ['playlist-read-private', 'playlist-read-collaborative'];

  // A non-empty state is required for the flow to work at all (Spotify's authorize endpoint
  // renders a generic error page for an authenticated user when `state=` is present but empty),
  // as well as for the CSRF check in the callback.
  const state = issueOAuthState(res, SPOTIFY_OAUTH_STATE_COOKIE);

  const authorizeURL = getAuthorizeUrl(scopes, state);
  Logger.auth('Spotify', 'redirecting to authorization', { authorizeURL });

  res.redirect(authorizeURL);
});

// Spotify callback
router.get(
  '/callback',
  validate({
    query: z.object({
      code: schemas.oauthCode,
      state: z.string().optional(),
    }),
  }),
  async (req: ValidatedRequest<Record<string, string>, { code: string; state?: string }>, res) => {
    Logger.requestStart('Spotify Callback Request', {
      requestUrl: req.originalUrl,
      authCodePresent: !!req.query.code,
    });

    const { code, state } = req.query;

    // Reject a callback that didn't originate from our /login (CSRF / account fixation).
    if (!verifyOAuthState(req, res, SPOTIFY_OAUTH_STATE_COOKIE, state, 'Spotify')) {
      return res.redirect('/?error=spotify&reason=state_mismatch');
    }

    try {
      const tokens = await exchangeCodeForTokens(code as string);

      // Validate tokens before storing in cookie
      const serializedTokens = validateAndSerializeSpotifyTokens({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });

      res.cookie('spotify_tokens', serializedTokens, getSecureCookieOptions());

      Logger.auth('Spotify', 'tokens stored in cookie');

      // Redirect back to main page - status endpoint will detect connection
      res.redirect('/');
    } catch (error) {
      Logger.error('Error getting Spotify tokens', {}, error);
      // Redirect back to home with error indicator in query params
      let errorReason = 'failed';
      if (error instanceof SpotifyApiError) {
        if (error.status === 429) {
          errorReason = 'rate_limited';
        } else if (error.status === 401) {
          errorReason = 'auth_error';
        } else if (error.status === 503 || error.status === 502) {
          errorReason = 'service_unavailable';
        }
      }
      res.redirect(`/?error=spotify&reason=${errorReason}`);
    }
  },
);

// Get user's playlists with improved layout - testing hot reload
router.get(
  '/playlists',
  validate({
    query: z.object({
      ownOnly: schemas.booleanFlag.optional(),
    }),
  }),
  async (req: ValidatedRequest<Record<string, string>, { ownOnly?: boolean }>, res) => {
    Logger.requestStart('Spotify Playlists Request', {
      requestUrl: req.originalUrl,
      queryParams: req.query,
    });

    const spotifyTokens = parseSpotifyTokenCookie(req.cookies.spotify_tokens, res);
    if (!spotifyTokens) {
      return res.status(401).render('partials/error-message', {
        message: 'Please connect to Spotify first',
        type: 'warning',
      });
    }

    try {
      const accessToken = await ensureValidSpotifyToken(req as Request, res);

      // Get current user info for ownership filtering
      const user = await getCurrentUser(accessToken);
      const currentUserId = user.id;

      // Set up the YouTube client to check for existing playlists (when connected).
      //
      // Through ensureValidYouTubeToken, not the cookie's access token directly: that token lasts
      // about an hour, and this page is the first thing loaded after the app has been left alone
      // for longer than that. A dead token fails the playlist read below, which is caught and
      // treated as "no YouTube playlists exist" - so every playlist renders as unsynced while the
      // connection button, which only looks for the cookie, still says connected.
      let youtubeTokens = parseYouTubeTokenCookie(req.cookies.youtube_tokens, res);
      let youtube = null;
      if (youtubeTokens) {
        try {
          youtube = (await ensureValidYouTubeToken(req as Request, res)).client;
        } catch (error) {
          // The refresh itself failed, so the connection really is gone. Say so rather than
          // reporting a synced library as unsynced.
          Logger.warn('YouTube token could not be refreshed for the playlist list', {}, error);
          res.clearCookie('youtube_tokens');
          youtubeTokens = null;
        }
      }

      // Get Spotify playlists (paginated, null-filtered and typed by the client)
      let spotifyPlaylists = await getUserPlaylists(accessToken);

      // Filter for own playlists only if requested
      // Note: Zod transforms the string 'true'/'false' to boolean true/false
      const ownOnly = req.query.ownOnly === true;
      Logger.debug('Playlist filtering', {
        ownOnly,
        currentUserId,
        totalPlaylists: spotifyPlaylists.length,
        rawQueryParam: req.query.ownOnly,
      });

      if (ownOnly) {
        const beforeFilter = spotifyPlaylists.length;
        spotifyPlaylists = spotifyPlaylists.filter(
          (playlist) => playlist.ownerId === currentUserId,
        );
        Logger.debug('Applied ownOnly filter', {
          before: beforeFilter,
          after: spotifyPlaylists.length,
          currentUserId,
        });
      }

      // Get ALL YouTube playlists to check which Spotify playlists have been synced (with pagination)
      const youtubePlaylistNames = new Set<string>();
      const youtubePlaylistsMap = new Map<string, YtPlaylist>();

      if (youtubeTokens) {
        // Check circuit breaker before making API calls
        if (!youtubeCircuitBreaker.canProceed()) {
          Logger.warn('YouTube API circuit breaker is OPEN, clearing YouTube tokens', {
            state: youtubeCircuitBreaker.getState(),
          });
          // Clear YouTube tokens so user sees disconnected state
          res.clearCookie('youtube_tokens');
          youtubeTokens = null;
        } else {
          try {
            const allYoutubePlaylists = await fetchAllYoutubePlaylists(youtube!);
            allYoutubePlaylists.forEach((playlist) => {
              const title = playlist.snippet?.title || '';
              youtubePlaylistNames.add(title);
              youtubePlaylistsMap.set(title, playlist);
            });

            // Success - record it
            youtubeCircuitBreaker.recordSuccess();
          } catch (error: unknown) {
            const errorCode = error instanceof YoutubeApiError ? error.code : undefined;
            if (errorCode === 403) {
              Logger.warn('YouTube API quota exceeded when fetching playlists, clearing tokens', {
                errorCode,
              });
              // Open circuit breaker for quota errors
              youtubeCircuitBreaker.open('the daily YouTube API quota is exhausted');
              // Clear YouTube tokens
              res.clearCookie('youtube_tokens');
              // This list is loaded via htmx, so a 302 would be swapped into the
              // container. Use HX-Redirect to trigger a real navigation to the home
              // page (which shows the quota modal), matching the OAuth-failure UX.
              res.set('HX-Redirect', '/?error=youtube&reason=quota_exceeded');
              return res.status(403).send('');
            }

            // Anything else is not something this knows how to answer, so it must not answer.
            //
            // This used to be swallowed and the read treated as "no YouTube playlists exist", which
            // renders every playlist as unsynced - beside a connection button that still says
            // connected, because it only looks for the cookie. A user acting on that re-syncs a
            // playlist that was already synced and pays YouTube quota to do it. The outer handler
            // renders a real error instead: nothing to check is not the same as nothing synced.
            Logger.warn('Could not fetch YouTube playlists for sorting', {}, error);
            youtubeCircuitBreaker.recordFailure(error);
            throw error;
          }
        }
      }

      // Categorize and sort playlists
      // Check if a Spotify playlist has been synced by looking for a YouTube playlist with " (from Spotify)" suffix
      const syncedPlaylists = spotifyPlaylists
        .filter((playlist) => youtubePlaylistNames.has(syncedPlaylistTitle(playlist.name)))
        .sort((a, b) => a.name.localeCompare(b.name));

      const unsyncedPlaylists = spotifyPlaylists
        .filter((playlist) => !youtubePlaylistNames.has(syncedPlaylistTitle(playlist.name)))
        .sort((a, b) => a.name.localeCompare(b.name));

      // Combine with synced playlists first
      const sortedPlaylists = [...syncedPlaylists, ...unsyncedPlaylists];

      const viewsPath = path.join(__dirname, '../../views');

      const playlistsHtml = await Promise.all(
        sortedPlaylists.map(async (playlist) => {
          const isSynced = youtubePlaylistNames.has(syncedPlaylistTitle(playlist.name));
          const syncIcon = isSynced ? '' : '';
          const buttonText = isSynced ? 'Update YouTube Playlist' : 'Sync to YouTube';
          const buttonClass = isSynced ? 'btn-outline-success' : 'btn-primary';

          // Get YouTube playlist info if it exists
          const youtubePlaylist = youtubePlaylistsMap.get(syncedPlaylistTitle(playlist.name));
          const youtubePlaylistUrl = youtubePlaylist
            ? `https://www.youtube.com/playlist?list=${youtubePlaylist.id}`
            : undefined;
          const youtubeTracksTotal = youtubePlaylist?.contentDetails?.itemCount || 0;

          // Spotify's dev-mode /me/playlists may omit the per-playlist count; the
          // client maps that to null and the template omits it. The real count shows
          // in the details view, which fetches the items.
          return await ejs.renderFile(path.join(viewsPath, 'partials/playlist-item.ejs'), {
            id: playlist.id,
            name: playlist.name,
            tracksTotal: playlist.trackTotal,
            youtubeTracksTotal,
            coverImage: playlist.coverImage,
            spotifyUrl: playlist.spotifyUrl,
            youtubeUrl: youtubePlaylistUrl,
            isSynced,
            syncIcon,
            buttonText,
            buttonClass,
            isYouTubeConnected: !!youtubeTokens,
            isDisabled: false,
          });
        }),
      ).then((items) => items.join(''));

      // Create summary text - different messages based on YouTube connection and sync status
      // Just a count: each playlist row already shows its own synced/track counts, so a
      // sync breakdown here would only duplicate them.
      const totalCount = spotifyPlaylists.length;
      let summaryText: string;
      if (!youtubeTokens) {
        summaryText = `${totalCount} playlists`;
      } else {
        summaryText = `${totalCount} playlists · ${syncedPlaylists.length} synced`;
      }

      // Cache for 30 minutes (LONG): this response lists ALL YouTube playlists to
      // determine sync status, so caching it protects the scarce YouTube quota.
      // The refresh button sends Cache-Control: no-cache to get fresh data on demand.
      //
      // An empty list is never cached. Spotify hands back an empty library now and then, and
      // caching that answer turns a blip into half an hour of a library that is not there - a
      // reload cannot clear it, only the refresh button can. There is nothing to protect either
      // way: no Spotify playlists means no YouTube quota was spent working out their sync status.
      const cacheDuration = totalCount === 0 ? CacheDuration.NO_CACHE : CacheDuration.LONG;
      setCache(res, cacheDuration);
      Logger.info('Setting cache header for playlists response', { cacheDuration });
      res.render('partials/playlist-list-container', { summaryText, playlistsHtml });
    } catch (error) {
      Logger.error('Error fetching playlists', {}, error);

      // An expired session reported as "something went wrong" is a reconnect the user is never
      // offered. Either service can be the one that ran out here.
      const expired = authExpired(error);
      if (expired) {
        signalAuthExpired(res, expired);
        return res.status(401).render('partials/auth-expired', { ...expired });
      }

      // Check if it's a Spotify API server error (502/503)
      const statusCode = error instanceof SpotifyApiError ? error.status : undefined;
      if (statusCode === 502 || statusCode === 503) {
        Logger.warn('Spotify API temporary error', { statusCode });
        return res.status(503).render('partials/error-message', {
          message: 'Spotify is temporarily unavailable',
          type: 'warning',
          details: "Spotify's servers are experiencing issues. Please try again in a few moments.",
        });
      }

      // A 200 whose body contradicts itself. Named explicitly, because the alternative rendering -
      // an empty playlist list - tells someone with sixty-three playlists that they have none.
      if (error instanceof SpotifyIncompleteResponseError) {
        return res.status(502).render('partials/error-message', {
          message: 'Spotify did not return your playlists',
          type: 'warning',
          details: `Spotify says you have ${error.reportedTotal}, but sent none of them. Nothing has changed on your account - try again in a moment.`,
        });
      }

      // Check for rate limiting (429)
      if (statusCode === 429) {
        const retryAfter = error instanceof SpotifyApiError ? error.retryAfter : undefined;
        Logger.warn('Spotify API rate limit exceeded', {
          statusCode,
          retryAfterSeconds: retryAfter ?? null,
        });
        return res.status(429).render('partials/error-message', {
          message: 'Too many requests to Spotify',
          type: 'warning',
          details:
            retryAfter != null
              ? `Spotify is rate-limiting this app. Try again in about ${formatRetryAfter(retryAfter)}.`
              : 'Please wait a moment before trying again.',
        });
      }

      res
        .status(500)
        .render('partials/error-message', { message: 'Error fetching playlists', type: 'danger' });
    }
  },
);

// Get sync button for a playlist (for refresh after sync)
router.get(
  '/playlist-button/:playlistId',
  validate({
    params: z.object({
      playlistId: schemas.spotifyPlaylistId,
    }),
  }),
  async (req: ValidatedRequest<{ playlistId: string }>, res) => {
    Logger.requestStart('Spotify Playlist Button Request', {
      playlistId: req.params.playlistId,
    });

    const spotifyTokens = parseSpotifyTokenCookie(req.cookies.spotify_tokens, res);
    const youtubeTokens = parseYouTubeTokenCookie(req.cookies.youtube_tokens, res);

    if (!spotifyTokens) {
      const html = await ejs.renderFile(
        path.join(__dirname, '../../views/partials/sync-button-disabled.ejs'),
        {
          message: 'Connect to Spotify First',
        },
      );
      return res.status(401).send(html);
    }

    // A sync is nothing but YouTube writes, so while they are refused the button can only produce
    // an error. Offering it anyway is how a limit reads as the app being broken.
    const blocked = youtubeWritesBlocked();
    if (blocked) {
      const html = await ejs.renderFile(
        path.join(__dirname, '../../views/partials/sync-button-disabled.ejs'),
        {
          message: 'YouTube unavailable',
          title: `Syncing is paused because ${blocked.reason}. Try again ${describeRetryWait(blocked.retryAt)}.`,
        },
      );
      return res.status(503).send(html);
    }

    if (!youtubeTokens) {
      const html = await ejs.renderFile(
        path.join(__dirname, '../../views/partials/sync-button-disabled.ejs'),
        {
          message: 'Connect to YouTube to Sync',
          title: 'Connect to YouTube first',
        },
      );
      return res.send(html);
    }

    try {
      const accessToken = await ensureValidSpotifyToken(req as Request, res);
      const { playlistId } = req.params;

      // Get this specific playlist
      const playlist = await getPlaylist(accessToken, playlistId);

      // Set up the YouTube client to check if this playlist has been synced. Through
      // ensureValidYouTubeToken: an hour-old access token would fail the check below, and this
      // button is rendered on a page the user may have left open far longer than that.
      const youtube = (await ensureValidYouTubeToken(req as Request, res)).client;

      // Check if a YouTube playlist exists for this Spotify playlist.
      //
      // Not caught: a failure here is not "not synced". The button is the only thing telling the
      // user which of the two this is, and getting it wrong sends them to re-sync a playlist that
      // was already synced - a full sync's worth of quota to discover nothing needed doing. The
      // outer handler renders an error instead.
      const foundPlaylist = await findSyncedYoutubePlaylist(youtube, playlist.name);
      const isSynced = !!foundPlaylist;

      const buttonText = isSynced ? 'Update YouTube Playlist' : 'Sync to YouTube';
      const buttonClass = isSynced ? 'btn-outline-success' : 'btn-primary';

      // Render button from template
      const buttonHtml = await ejs.renderFile(
        path.join(__dirname, '../../views/partials/sync-button.ejs'),
        {
          buttonClass,
          playlistId,
          playlistName: playlist.name,
          trackCount: playlist.trackTotal ?? 0,
          buttonText,
        },
      );

      return res.send(buttonHtml);
    } catch (error) {
      Logger.error('Error fetching playlist button', {}, error);

      // Either service can be the one that ran out - the button needs BOTH to know what to say.
      // This slot is a button, so it says so as a button rather than as the alert other routes use.
      const expired = authExpired(error);
      if (expired) {
        const html = await ejs.renderFile(
          path.join(__dirname, '../../views/partials/sync-button-disabled.ejs'),
          {
            message: `Reconnect to ${expired.service}`,
          },
        );
        return res.status(401).send(html);
      }

      const html = await ejs.renderFile(
        path.join(__dirname, '../../views/partials/sync-button-disabled.ejs'),
        {
          message: 'Error',
        },
      );
      return res.status(500).send(html);
    }
  },
);

export { router as spotifyRouter };
