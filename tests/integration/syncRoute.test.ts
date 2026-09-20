/**
 * Route tests for the sync handler - the path that rewrites a whole playlist, where a wrong
 * desired order costs the user their playlist. These pin the order passed to reconcile across the
 * main branches (re-sync unchanged, update with a new track, create, create with no matches).
 *
 * The sync runs inside the SSE stream route (GET /playlist/:id/stream), which
 * streams progress + the final result as `event: message` frames; supertest reads
 * the whole streamed body. reconcilePlaylist is spied (its planner + safety rail
 * are unit-tested separately); everything else is mocked so no real API is hit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { youtubeCircuitBreaker } from '@/lib/circuitBreaker';
import { YoutubeApiError } from '@/youtube/client';
import { findSetCookie } from '@tests/helpers/httpCookies';

const h = vi.hoisted(() => ({
  sleep: vi.fn(() => Promise.resolve()),
  getPlaylist: vi.fn(),
  fetchAllPlaylistItems: vi.fn(),
  searchMusicVideo: vi.fn(),
  playlistsList: vi.fn(),
  playlistsInsert: vi.fn(),
  playlistItemsList: vi.fn(),
  reconcilePlaylist: vi.fn<typeof import('@/sync/playlistReconcile').reconcilePlaylist>(() =>
    Promise.resolve({ inserted: 0, deleted: 0, moved: 0 }),
  ),
}));

vi.mock('@/lib/delay', () => ({ sleep: h.sleep }));
vi.mock('@/spotify/auth', () => ({
  ensureValidSpotifyToken: vi.fn(async () => 'test-access-token'),
}));
vi.mock('@/spotify/client', () => ({ getPlaylist: h.getPlaylist }));
vi.mock('@/spotify/playlistItems', () => ({ fetchAllPlaylistItems: h.fetchAllPlaylistItems }));
vi.mock('@/youtube/scraper', () => ({ searchMusicVideo: h.searchMusicVideo }));

vi.mock('@/youtube/auth', () => ({
  ensureValidYouTubeToken: vi.fn(async () => ({
    client: {
      playlists: { list: h.playlistsList, insert: h.playlistsInsert },
      playlistItems: {
        list: h.playlistItemsList,
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      channels: { list: vi.fn(() => Promise.resolve({ data: { items: [{ id: 'chan' }] } })) },
    },
    accessToken: 'yt-access-token',
    quotaUsed: 1,
  })),
}));

vi.mock('@/sync/playlistReconcile', async (importActual) => {
  const actual = await importActual<typeof import('@/sync/playlistReconcile')>();
  return { ...actual, reconcilePlaylist: h.reconcilePlaylist };
});

import { createApp } from '@/app';
import { testServer } from '@tests/helpers/testServer';

const app = testServer(createApp());

const spotifyCookie = JSON.stringify({ accessToken: 'a', refreshToken: 'b' });
const youtubeCookie = JSON.stringify({
  access_token: 'a',
  refresh_token: 'b',
  scope: 's',
  token_type: 'Bearer',
  channel_id: 'chan',
});

const track = (id: string, name: string) => ({
  track: { id, name, type: 'track', artists: [{ name: 'Artist' }] },
});
const ytItem = (pi: string, videoId: string, title: string) => ({
  id: pi,
  snippet: { title, resourceId: { videoId } },
});
const SYNCED_TITLE = 'My Playlist (from Spotify)';

// Drive the SSE stream route (GET, no CSRF - SameSite=strict cookies protect it).
// supertest buffers the whole event-stream body once the handler ends it.
function stream(batchSize = 'all') {
  return request(app)
    .get(`/api/sync/playlist/1234567890123456789012/stream?batchSize=${batchSize}`)
    .set('Cookie', [`spotify_tokens=${spotifyCookie}`, `youtube_tokens=${youtubeCookie}`]);
}

/** desiredVideoIds passed to the spied reconcile on its most recent call. */
const lastDesired = () => h.reconcilePlaylist.mock.calls.at(-1)?.[2];

describe('GET /api/sync/playlist/:id/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    youtubeCircuitBreaker.close(); // isolate the quota test, which opens the breaker
    h.getPlaylist.mockResolvedValue({
      id: 'p',
      name: 'My Playlist',
      ownerId: 'me',
      trackTotal: 2,
      spotifyUrl: 'u',
    });
    h.reconcilePlaylist.mockResolvedValue({ inserted: 0, deleted: 0, moved: 0 });
    h.searchMusicVideo.mockResolvedValue(null);
  });

  it('re-sync unchanged: reconciles to the existing order, zero deletes', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([track('t1', 'Song One'), track('t2', 'Song Two')]);
    h.playlistsList.mockResolvedValue({
      data: { items: [{ id: 'YT_PL', snippet: { title: SYNCED_TITLE } }] },
    });
    h.playlistItemsList.mockResolvedValue({
      data: { items: [ytItem('pi1', 'v1', 'Song One'), ytItem('pi2', 'v2', 'Song Two')] },
    });

    const res = await stream();

    expect(res.status).toBe(200);
    expect(h.reconcilePlaylist).toHaveBeenCalledTimes(1);
    expect(lastDesired()).toEqual(['v1', 'v2']); // both existing videos present -> no orphan deletes
  });

  it('update with a new track: desired order keeps existing and appends the new video', async () => {
    h.getPlaylist.mockResolvedValue({
      id: 'p',
      name: 'My Playlist',
      ownerId: 'me',
      trackTotal: 3,
      spotifyUrl: 'u',
    });
    h.fetchAllPlaylistItems.mockResolvedValue([
      track('t1', 'Song One'),
      track('t2', 'Song Two'),
      track('t3', 'Song Three'),
    ]);
    h.playlistsList.mockResolvedValue({
      data: { items: [{ id: 'YT_PL', snippet: { title: SYNCED_TITLE } }] },
    });
    h.playlistItemsList.mockResolvedValue({
      data: { items: [ytItem('pi1', 'v1', 'Song One'), ytItem('pi2', 'v2', 'Song Two')] },
    });
    h.searchMusicVideo.mockImplementation((_artist: string, song: string) =>
      Promise.resolve(song === 'Song Three' ? 'v3' : null),
    );

    const res = await stream();

    expect(res.status).toBe(200);
    expect(lastDesired()).toEqual(['v1', 'v2', 'v3']);
  });

  it('create: no existing playlist, builds desired order from found videos', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([track('t1', 'Song One'), track('t2', 'Song Two')]);
    h.playlistsList.mockResolvedValue({ data: { items: [] } }); // none synced yet
    h.playlistsInsert.mockResolvedValue({
      data: { id: 'NEW_PL', snippet: { title: SYNCED_TITLE } },
    });
    h.playlistItemsList.mockResolvedValue({ data: { items: [] } });
    h.searchMusicVideo.mockImplementation((_artist: string, song: string) =>
      Promise.resolve(song === 'Song One' ? 'v1' : song === 'Song Two' ? 'v2' : null),
    );

    const res = await stream();

    expect(res.status).toBe(200);
    expect(h.reconcilePlaylist).toHaveBeenCalledTimes(1);
    expect(lastDesired()).toEqual(['v1', 'v2']);
  });

  // YouTube rejects writes to a playlist it has only just created, and reconcile is what writes.
  it('create: waits after creating the playlist, before writing to it', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([track('t1', 'Song One')]);
    h.playlistsList.mockResolvedValue({ data: { items: [] } });
    h.playlistsInsert.mockResolvedValue({
      data: { id: 'NEW_PL', snippet: { title: SYNCED_TITLE } },
    });
    h.playlistItemsList.mockResolvedValue({ data: { items: [] } });
    h.searchMusicVideo.mockResolvedValue('v1');

    await stream();

    expect(h.sleep).toHaveBeenCalledWith(2000);
    expect(h.playlistsInsert.mock.invocationCallOrder[0]!).toBeLessThan(
      h.sleep.mock.invocationCallOrder[0]!,
    );
    expect(h.sleep.mock.invocationCallOrder[0]!).toBeLessThan(
      h.reconcilePlaylist.mock.invocationCallOrder[0]!,
    );
  });

  it('create with no matches: streams an error and never reconciles (no destructive writes)', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([track('t1', 'Song One'), track('t2', 'Song Two')]);
    h.playlistsList.mockResolvedValue({ data: { items: [] } });
    h.searchMusicVideo.mockResolvedValue(null); // nothing found for any track

    const res = await stream();

    expect(res.status).toBe(200);
    expect(res.text).toContain('No videos found');
    expect(h.reconcilePlaylist).not.toHaveBeenCalled();
    expect(h.playlistsInsert).not.toHaveBeenCalled();
  });

  it('quota exceeded on a write: streams the quota partial, not the generic error', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([track('t1', 'Song One')]);
    h.playlistsList.mockResolvedValue({ data: { items: [] } }); // create mode
    h.searchMusicVideo.mockResolvedValue('v1');
    // Exactly what the client throws for a 403 quota response; youtubeWrite turns it into a
    // YoutubeQuotaError.
    h.playlistsInsert.mockRejectedValue(
      new YoutubeApiError('YouTube API error (403): quota', 403, 'quotaExceeded'),
    );

    const res = await stream();

    expect(res.status).toBe(200);
    expect(res.text).toContain('YouTube is not accepting changes');
    // The body names the actual reason, and says when it lifts. It used to assert the daily quota
    // for every limit, including a breaker opened by unrelated failures.
    expect(res.text).toContain('the daily YouTube API quota is exhausted');
    // When it lifts, taken from what the breaker recorded. It used to append "a daily quota resets
    // at midnight Pacific" to every refusal, asserting that cause even for a breaker opened by
    // unrelated failures - the same wrong claim in the details that the title had already lost.
    expect(res.text).toMatch(/try again in about .+\./);
    expect(res.text).not.toContain('midnight Pacific');
    // The marker the page turns into the event that disables the sync and edit controls. The SSE
    // headers are long gone by here, so the HX-Trigger the other routes use is not available.
    expect(res.text).toContain('data-youtube-blocked');
  });

  /**
   * A rate limit is a refusal on limits, so it takes the same branch as quota - but it does NOT
   * open the breaker, because it passes in seconds rather than lasting the day. With nothing open
   * there is no recorded retry time, and the message has to fall back to saying so vaguely instead
   * of inventing a number.
   */
  it('a rate limit refuses without a retry time, since nothing is open to have recorded one', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([track('t1', 'Song One')]);
    h.playlistsList.mockResolvedValue({ data: { items: [] } }); // create mode
    h.searchMusicVideo.mockResolvedValue('v1');
    h.playlistsInsert.mockRejectedValue(
      new YoutubeApiError('YouTube API error (403): rate limit', 403, 'rateLimitExceeded'),
    );

    const res = await stream();

    expect(res.status).toBe(200);
    expect(res.text).toContain('YouTube is not accepting changes');
    expect(res.text).toContain('Try again shortly.');
    expect(res.text).not.toMatch(/try again in about/);
  });

  it('a non-quota failure streams the generic error, not the quota partial', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([track('t1', 'Song One')]);
    h.playlistsList.mockResolvedValue({ data: { items: [] } }); // create mode
    h.searchMusicVideo.mockResolvedValue('v1');
    // A plain error (not a YouTube quota/rate-limit) must take the generic branch, same write point
    // the quota test uses.
    h.playlistsInsert.mockRejectedValue(new Error('database exploded'));

    const res = await stream();

    expect(res.status).toBe(200);
    expect(res.text).toContain('Error syncing playlist');
    expect(res.text).toContain('Something went wrong');
    expect(res.text).not.toContain('YouTube Quota Exceeded');
  });

  it('opens a no-cache event-stream and greets with a comment frame', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([track('t1', 'Song One')]);

    const res = await stream();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.text).toContain('stream open');
  });

  it('missing auth: 401 before the stream opens', async () => {
    const res = await request(app).get(
      '/api/sync/playlist/1234567890123456789012/stream?batchSize=all',
    );
    expect(res.status).toBe(401);
  });

  /**
   * A sync needs BOTH services. When one is missing the 401 must name the RIGHT one, or it sends the
   * user to reconnect the service that is already connected while the actually-missing one stays
   * missing. Both cookies absent, the existing test above, does not distinguish the two branches.
   */
  const streamWith = (cookies: string[]) =>
    request(app)
      .get('/api/sync/playlist/1234567890123456789012/stream?batchSize=all')
      .set('Cookie', cookies);

  it('names Spotify when only YouTube is connected', async () => {
    const res = await streamWith([`youtube_tokens=${youtubeCookie}`]);

    expect(res.status).toBe(401);
    expect(res.text).toContain('Spotify Authentication Required');
    expect(res.text).toContain('Please connect to Spotify first');
    expect(res.text).not.toContain('YouTube Authentication Required');
  });

  it('names YouTube when only Spotify is connected', async () => {
    const res = await streamWith([`spotify_tokens=${spotifyCookie}`]);

    expect(res.status).toBe(401);
    expect(res.text).toContain('YouTube Authentication Required');
  });

  /**
   * The sync used to demand a cached channel id and refuse the whole run without one. Nothing ever
   * read it - the call site discarded the return value, so it was a presence check on a field with
   * no reader, bought with a quota unit at connect time. Its only real effect was that a connect
   * made while the quota was gone produced a cookie the sync would then reject.
   */
  it('syncs a YouTube token that carries no channel id', async () => {
    const noChannel = JSON.stringify({
      access_token: 'a',
      refresh_token: 'b',
      scope: 's',
      token_type: 'Bearer',
    });

    const res = await streamWith([
      `spotify_tokens=${spotifyCookie}`,
      `youtube_tokens=${noChannel}`,
    ]);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Authentication Error');
  });
});

/**
 * The subscriber endpoint. The POST does not sync - it renders the SSE subscriber, and htmx's sse
 * extension then opens the stream above. Splitting it that way is what lets the sync survive the
 * POST response ending.
 */
describe('POST /api/sync/playlist/:id', () => {
  const csrf = async () => {
    const page = await request(app).get('/');
    const cookie = findSetCookie(page, 'csrf_token')!.split(';')[0]!;
    return { cookie, token: cookie.split('=')[1]!.split('.')[0]! };
  };

  const subscribe = async (
    body: Record<string, string> = {},
    opts: { withCsrf?: boolean } = {},
  ) => {
    const { cookie, token } = await csrf();
    const req = request(app)
      .post('/api/sync/playlist/1234567890123456789012')
      .set('Cookie', [
        `spotify_tokens=${spotifyCookie}`,
        `youtube_tokens=${youtubeCookie}`,
        cookie,
      ]);
    if (opts.withCsrf !== false) req.set('x-csrf-token', token);
    return req.send(body);
  };

  beforeEach(() => vi.clearAllMocks());

  it('renders a subscriber pointed at the stream for this playlist', async () => {
    const response = await subscribe({ batchSize: '5' });

    expect(response.status).toBe(200);
    expect(response.text).toContain('1234567890123456789012');
  });

  it('passes the batch size through to the stream URL', async () => {
    const response = await subscribe({ batchSize: '5' });

    expect(response.text).toContain('batchSize=5');
  });

  it('defaults the batch size to 1', async () => {
    const response = await subscribe({});

    expect(response.text).toContain('batchSize=1');
  });

  // A POST that writes to a playlist has to be CSRF-protected, even though it only renders here -
  // it is what starts the sync.
  it('rejects a request with no CSRF token', async () => {
    const response = await subscribe({ batchSize: '1' }, { withCsrf: false });

    expect(response.status).toBe(403);
  });

  it('rejects an unusable batch size', async () => {
    const response = await subscribe({ batchSize: 'not-a-number' });

    expect(response.status).toBe(400);
  });

  it('rejects a malformed playlist id', async () => {
    const { cookie, token } = await csrf();

    const response = await request(app)
      .post('/api/sync/playlist/nope')
      .set('Cookie', [`spotify_tokens=${spotifyCookie}`, cookie])
      .set('x-csrf-token', token)
      .send({});

    expect(response.status).toBe(400);
  });

  // The subscriber renders without touching Spotify or YouTube; the stream does the work.
  it('does not start syncing', async () => {
    await subscribe({ batchSize: '1' });

    expect(h.getPlaylist).not.toHaveBeenCalled();
    expect(h.fetchAllPlaylistItems).not.toHaveBeenCalled();
  });
});

describe('GET stream: batch size and empty playlists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    youtubeCircuitBreaker.close();
    h.getPlaylist.mockResolvedValue({
      id: 'p',
      name: 'My Playlist',
      ownerId: 'me',
      trackTotal: 2,
      spotifyUrl: 'u',
    });
    h.reconcilePlaylist.mockResolvedValue({ inserted: 0, deleted: 0, moved: 0 });
    h.searchMusicVideo.mockResolvedValue('v1');
    h.playlistsList.mockResolvedValue({ data: { items: [] } });
    h.playlistsInsert.mockResolvedValue({ data: { id: 'NEW_PL' } });
    h.playlistItemsList.mockResolvedValue({ data: { items: [] } });
  });

  it('searches only the first track when the batch size is 1', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([track('t1', 'Song One'), track('t2', 'Song Two')]);

    await stream('1');

    expect(h.searchMusicVideo).toHaveBeenCalledTimes(1);
  });

  it('searches every track when the batch size is all', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([track('t1', 'Song One'), track('t2', 'Song Two')]);

    await stream('all');

    expect(h.searchMusicVideo).toHaveBeenCalledTimes(2);
  });

  it('stops at the batch size when it is smaller than the playlist', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([
      track('t1', 'One'),
      track('t2', 'Two'),
      track('t3', 'Three'),
    ]);

    await stream('2');

    expect(h.searchMusicVideo).toHaveBeenCalledTimes(2);
  });

  it('reports an empty playlist instead of creating an empty YouTube one', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([]);

    const response = await stream('all');

    expect(response.text).toContain('No Tracks Found');
    expect(h.playlistsInsert).not.toHaveBeenCalled();
  });

  // Local files and podcast episodes come back in the items list but cannot be searched for.
  it('reports a playlist of nothing but unplayable items as empty', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([
      { track: { id: 'e1', name: 'An Episode', type: 'episode', artists: [] } },
    ]);

    const response = await stream('all');

    expect(response.text).toContain('No Tracks Found');
    expect(h.searchMusicVideo).not.toHaveBeenCalled();
  });

  it('streams progress before the result', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([track('t1', 'Song One')]);

    const response = await stream('all');

    expect(response.text).toContain('Starting sync');
    expect(response.text).toContain('Finding music videos');
  });

  it('ends the stream with a close frame', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([track('t1', 'Song One')]);

    const response = await stream('all');

    expect(response.text).toContain('event: close');
  });
});

/**
 * What the stream actually tells the user.
 *
 * The tests above pin the desired order handed to reconcile - the part that, if wrong, costs the
 * user their playlist. They say nothing about the frames, which is everything the user sees: the
 * wording, the counts, the progress. All of it ran on every one of these tests and none of it was
 * looked at, so all of it survived.
 */
describe('GET stream: what it reports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    youtubeCircuitBreaker.close();
    h.getPlaylist.mockResolvedValue({
      id: 'p',
      name: 'My Playlist',
      ownerId: 'me',
      trackTotal: 2,
      spotifyUrl: 'u',
    });
    h.reconcilePlaylist.mockResolvedValue({ inserted: 0, deleted: 0, moved: 0 });
    h.fetchAllPlaylistItems.mockResolvedValue([track('t1', 'Song One'), track('t2', 'Song Two')]);
    h.searchMusicVideo.mockImplementation((_a: string, song: string) =>
      Promise.resolve(song === 'Song One' ? 'v1' : 'v2'),
    );
    // Nothing synced yet, so the default here is the CREATE path - which is where the counts mean
    // what they say. In UPDATE mode the route only searches the tracks that are not already
    // matched, so "Found 0 out of 0" is the honest report for a playlist that needed nothing.
    h.playlistsList.mockResolvedValue({ data: { items: [] } });
    h.playlistsInsert.mockResolvedValue({
      data: { id: 'NEW_PL', snippet: { title: SYNCED_TITLE } },
    });
    h.playlistItemsList.mockResolvedValue({ data: { items: [] } });
  });

  /** Switch to a playlist that has already been synced. */
  const alreadySynced = () => {
    h.playlistsList.mockResolvedValue({
      data: { items: [{ id: 'YT_PL', snippet: { title: SYNCED_TITLE } }] },
    });
    h.playlistItemsList.mockResolvedValue({ data: { items: [] } });
  };

  /** Every frame's payload, in order. */
  const frames = (body: string) =>
    body
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6));

  it('says created for a playlist it had to make', async () => {
    const response = await stream();

    expect(response.text).toContain('created successfully');
    expect(response.text).not.toContain('updated successfully');
  });

  it('says updated for a playlist that was already there', async () => {
    alreadySynced();

    const response = await stream();

    expect(response.text).toContain('updated successfully');
    expect(response.text).not.toContain('created successfully');
  });

  it('reports how many of the tracks it found', async () => {
    const response = await stream();

    expect(response.text).toContain('Found 2 out of 2 tracks');
  });

  it('reports the ones it could not find', async () => {
    h.searchMusicVideo.mockImplementation((_a: string, song: string) =>
      Promise.resolve(song === 'Song One' ? 'v1' : null),
    );

    const response = await stream();

    expect(response.text).toContain('Found 1 out of 2 tracks');
  });

  // The batch size is a promise about how much of the playlist gets touched; saying nothing about
  // having honoured it leaves the user to work out why 2 of 50 tracks synced.
  it('says so when the batch size held it back', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([
      track('t1', 'Song One'),
      track('t2', 'Song Two'),
      track('t3', 'Song Three'),
    ]);

    const response = await stream('1');

    expect(response.text).toContain('(limited from 3 total)');
  });

  it('does not claim a limit when it synced everything', async () => {
    const response = await stream('all');

    expect(response.text).not.toContain('limited from');
  });

  // The bar is what the user watches; finishing a sync while it reads 70% reads as a hang.
  it('finishes the progress bar', async () => {
    const response = await stream();

    const completion = frames(response.text).find((f) => f.includes('successfully'));
    expect(completion).toBeDefined();
    expect(completion).toContain('100');
  });

  it('ends with a close frame, whatever happened', async () => {
    const response = await stream();

    expect(response.text).toContain('event: close');
  });
});

/**
 * The stream is opened only after the tokens are resolved, so an auth failure here is a plain HTTP
 * response rather than a frame - and it has to say which service, or the user cannot act on it.
 */
describe('GET stream: authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    youtubeCircuitBreaker.close();
  });

  it.each([
    ['Spotify', 'SPOTIFY_AUTH_REQUIRED', '/auth/spotify/login'],
    ['YouTube', 'YOUTUBE_AUTH_REQUIRED', '/auth/youtube/login'],
  ])('asks the user to reconnect %s, naming it', async (service, code, loginUrl) => {
    const { ensureValidSpotifyToken } = await import('@/spotify/auth');
    vi.mocked(ensureValidSpotifyToken).mockRejectedValueOnce(new Error(code));

    const response = await stream();

    expect(response.status).toBe(401);
    expect(response.text).toContain(service);
    expect(response.text).toContain(loginUrl);
  });

  // Anything else is not the user's fault and must not send them off to reconnect a working account.
  it('reports an unexpected auth failure as an error, not a reconnect', async () => {
    const { ensureValidSpotifyToken } = await import('@/spotify/auth');
    vi.mocked(ensureValidSpotifyToken).mockRejectedValueOnce(new Error('socket hang up'));

    const response = await stream();

    expect(response.status).toBe(500);
    expect(response.text).toContain('Authentication Error');
    expect(response.text).toContain('Failed to verify your connection');
    expect(response.text).not.toContain('/auth/spotify/login');
  });
});

/**
 * The result frame: the tracks it could not link, and the details it swaps back in.
 *
 * The unlinked list is the only place a user is told which songs did not make it - without it a
 * sync that found 18 of 20 looks the same as one that found 20. And the details are delivered
 * out-of-band here, which is what stops the row above them going stale (PR #85/#86).
 */
describe('GET stream: the result frame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    youtubeCircuitBreaker.close();
    h.getPlaylist.mockResolvedValue({
      id: 'p',
      name: 'My Playlist',
      ownerId: 'me',
      trackTotal: 3,
      spotifyUrl: 'u',
    });
    h.reconcilePlaylist.mockResolvedValue({ inserted: 0, deleted: 0, moved: 0 });
    h.playlistsList.mockResolvedValue({ data: { items: [] } });
    h.playlistsInsert.mockResolvedValue({
      data: { id: 'NEW_PL', snippet: { title: SYNCED_TITLE } },
    });
    h.playlistItemsList.mockResolvedValue({ data: { items: [] } });
    h.fetchAllPlaylistItems.mockResolvedValue([
      track('t1', 'Song One'),
      track('t2', 'Song Two'),
      track('t3', 'Song Three'),
    ]);
  });

  /** Nothing found for the named songs. */
  const cannotFind = (...missing: string[]) =>
    h.searchMusicVideo.mockImplementation((_a: string, song: string) =>
      Promise.resolve(missing.includes(song) ? null : 'v' + song),
    );

  it('names the track it could not link', async () => {
    cannotFind('Song Two');

    const response = await stream();

    expect(response.text).toContain('could not be linked');
    expect(response.text).toContain('Song Two');
  });

  it('counts them, and says track or tracks', async () => {
    cannotFind('Song Two');
    expect((await stream()).text).toContain('1 track could not be linked');

    vi.clearAllMocks();
    h.getPlaylist.mockResolvedValue({
      id: 'p',
      name: 'My Playlist',
      ownerId: 'me',
      trackTotal: 3,
      spotifyUrl: 'u',
    });
    h.reconcilePlaylist.mockResolvedValue({ inserted: 0, deleted: 0, moved: 0 });
    h.playlistsList.mockResolvedValue({ data: { items: [] } });
    h.playlistsInsert.mockResolvedValue({
      data: { id: 'NEW_PL', snippet: { title: SYNCED_TITLE } },
    });
    h.playlistItemsList.mockResolvedValue({ data: { items: [] } });
    h.fetchAllPlaylistItems.mockResolvedValue([
      track('t1', 'Song One'),
      track('t2', 'Song Two'),
      track('t3', 'Song Three'),
    ]);
    cannotFind('Song Two', 'Song Three');

    expect((await stream()).text).toContain('2 tracks could not be linked');
  });

  it('says nothing about unlinked tracks when it found them all', async () => {
    cannotFind();

    const response = await stream();

    expect(response.text).not.toContain('could not be linked');
  });

  // Delivered out-of-band, into #details-<id>, which is what keeps the collapsed row honest.
  it('swaps the refreshed details back in', async () => {
    cannotFind();

    const response = await stream();

    expect(response.text).toContain('details-1234567890123456789012');
  });

  it('leaves the button saying the playlist can be updated now', async () => {
    cannotFind();

    const response = await stream();

    expect(response.text).toContain('Update YouTube Playlist');
  });
});
