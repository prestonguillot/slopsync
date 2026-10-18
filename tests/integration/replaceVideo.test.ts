/**
 * Tests for POST /api/playlistDetails/replace/:trackId - the manual "use this video instead" write.
 *
 * This is the only place the app writes to a YouTube playlist outside a sync, and every write costs
 * 50 of a 10,000-unit daily budget - so what these pin most closely is how many it makes.
 *
 * The wait before placing an added video is stubbed and asserted on rather than served: a test that
 * really waits is slow, and starves under load until it fails on a timeout having tested nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const h = vi.hoisted(() => ({
  sleep: vi.fn(() => Promise.resolve()),
  getPlaylist: vi.fn(),
  fetchAllPlaylistItems: vi.fn(),
  playlistsList: vi.fn(),
  playlistItemsList: vi.fn(),
  playlistItemsInsert: vi.fn(),
  playlistItemsDelete: vi.fn(),
  playlistItemsUpdate: vi.fn(),
  refreshYoutubeAccessToken: vi.fn(),
  getCurrentUser: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

vi.mock('@/lib/delay', () => ({ sleep: h.sleep }));
// The real Spotify token path runs too: getCurrentUser is the /me probe ensureValidSpotifyToken uses
// to validate the cookie's token, and refreshAccessToken is the refresh - only those network edges
// are faked, so an expired Spotify cookie really is refreshed and rewritten the way it would be live.
vi.mock('@/spotify/client', async (importActual) => ({
  ...(await importActual<typeof import('@/spotify/client')>()),
  getPlaylist: h.getPlaylist,
  getCurrentUser: h.getCurrentUser,
  refreshAccessToken: h.refreshAccessToken,
}));
vi.mock('@/spotify/playlistItems', () => ({ fetchAllPlaylistItems: h.fetchAllPlaylistItems }));
// The real token path runs: only the network edges are faked, so an expired cookie really is
// refreshed and rewritten the way it would be in front of a user.
vi.mock('@/youtube/client', async (importActual) => ({
  ...(await importActual<typeof import('@/youtube/client')>()),
  refreshYoutubeAccessToken: h.refreshYoutubeAccessToken,
  createYoutubeClient: () => ({
    playlists: { list: h.playlistsList },
    playlistItems: {
      list: h.playlistItemsList,
      insert: h.playlistItemsInsert,
      delete: h.playlistItemsDelete,
      update: h.playlistItemsUpdate,
    },
  }),
}));

import { createApp } from '@/app';
import { SpotifyApiError } from '@/spotify/client';
import { YoutubeApiError } from '@/youtube/client';
import { youtubeCircuitBreaker } from '@/lib/circuitBreaker';
import { testServer } from '@tests/helpers/testServer';
import { findSetCookie } from '@tests/helpers/httpCookies';
import { youtubeTokenCookie } from '@tests/helpers/tokenCookies';

const app = testServer(createApp());

const SPOTIFY_COOKIE = 'spotify_tokens={"accessToken":"sp-token","refreshToken":"sp-refresh"}';
// expiry_date is on every real cookie - it is written on the code exchange and on every refresh -
// and it is what the auth path reads to decide whether the token can be used as-is. A fixture
// without it describes a cookie this app never writes.
const YOUTUBE_COOKIE = `youtube_tokens=${JSON.stringify({
  access_token: 'yt-token',
  refresh_token: 'yt-refresh',
  scope: 's',
  token_type: 'Bearer',
  expiry_date: Date.now() + 3_600_000,
})}`;

const TRACK_ID = '4iV5W9uYEdYUVa79Axb7Rh';
const PLAYLIST_ID = '37i9dQZF1DXcBWIGoYBM5M';
const NEW_VIDEO = 'dQw4w9WgXcQ';
const OLD_VIDEO = 'oldVideo123';

/** A real CSRF token pair, minted by the app's own cookie middleware. */
async function csrf() {
  const page = await request(app).get('/');
  const cookie = findSetCookie(page, 'csrf_token')!.split(';')[0]!;
  const token = cookie.split('=')[1]!.split('.')[0]!;
  return { cookie, token };
}

async function replace(
  body: Record<string, string>,
  opts: { cookies?: string[]; withCsrf?: boolean } = {},
) {
  const { cookie, token } = await csrf();
  const cookies = opts.cookies ?? [SPOTIFY_COOKIE, YOUTUBE_COOKIE];
  const req = request(app)
    .post(`/api/playlistDetails/replace/${TRACK_ID}`)
    .set('Cookie', [...cookies, cookie]);
  if (opts.withCsrf !== false) req.set('x-csrf-token', token);
  return req.send(body);
}

const syncedPlaylist = { id: 'PL-yt', snippet: { title: 'My Playlist (from Spotify)' } };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the /me probe accepts the cookie's token, so ensureValidSpotifyToken returns it as-is.
  h.getCurrentUser.mockResolvedValue({ id: 'me', display_name: 'Me' });
  h.getPlaylist.mockResolvedValue({
    id: PLAYLIST_ID,
    name: 'My Playlist',
    ownerId: 'me',
    trackTotal: 1,
    spotifyUrl: 'https://open.spotify.com/playlist/x',
  });
  h.playlistsList.mockResolvedValue({ data: { items: [syncedPlaylist] } });
  h.playlistItemsList.mockResolvedValue({
    data: {
      items: [{ id: 'item-old', snippet: { position: 3, resourceId: { videoId: OLD_VIDEO } } }],
    },
  });
  h.playlistItemsInsert.mockResolvedValue({ data: {} });
  h.playlistItemsDelete.mockResolvedValue({ data: undefined });
  h.playlistItemsUpdate.mockResolvedValue({ data: {} });
  h.fetchAllPlaylistItems.mockResolvedValue([]);
});

describe('POST /replace: refusing the request', () => {
  it('rejects a request with no CSRF token', async () => {
    const response = await replace(
      { newVideoId: NEW_VIDEO, currentVideoId: OLD_VIDEO, playlistId: PLAYLIST_ID },
      { withCsrf: false },
    );

    expect(response.status).toBe(403);
    // It must refuse BEFORE writing anything to YouTube.
    expect(h.playlistItemsInsert).not.toHaveBeenCalled();
  });

  it('requires YouTube to be connected', async () => {
    const response = await replace(
      { newVideoId: NEW_VIDEO, currentVideoId: OLD_VIDEO, playlistId: PLAYLIST_ID },
      { cookies: [SPOTIFY_COOKIE] },
    );

    expect(response.status).toBe(401);
    expect(response.text).toContain('YouTube Authentication Required');
  });

  it('requires Spotify to be connected', async () => {
    const response = await replace(
      { newVideoId: NEW_VIDEO, currentVideoId: OLD_VIDEO, playlistId: PLAYLIST_ID },
      { cookies: [YOUTUBE_COOKIE] },
    );

    expect(response.status).toBe(401);
    expect(response.text).toContain('Spotify Authentication Required');
  });

  it.each([
    ['a missing newVideoId', { currentVideoId: OLD_VIDEO, playlistId: PLAYLIST_ID }],
    ['a malformed newVideoId', { newVideoId: 'not a video id!', playlistId: PLAYLIST_ID }],
    ['a missing playlistId', { newVideoId: NEW_VIDEO }],
  ])('rejects %s', async (_label, body) => {
    expect((await replace(body as Record<string, string>)).status).toBe(400);
  });

  it('reports when the synced YouTube playlist does not exist', async () => {
    h.playlistsList.mockResolvedValue({ data: { items: [] } });

    const response = await replace({
      newVideoId: NEW_VIDEO,
      currentVideoId: OLD_VIDEO,
      playlistId: PLAYLIST_ID,
    });

    expect(response.status).toBe(404);
    expect(response.text).toContain('Playlist not found');
    expect(h.playlistItemsInsert).not.toHaveBeenCalled();
  });

  it('reports when the video being replaced is not in the playlist', async () => {
    h.playlistItemsList.mockResolvedValue({ data: { items: [] } });

    const response = await replace({
      newVideoId: NEW_VIDEO,
      currentVideoId: OLD_VIDEO,
      playlistId: PLAYLIST_ID,
    });

    expect(response.status).toBe(404);
    expect(response.text).toContain('Video not found');
    // Nothing was written - it did not add the new video and leave the old one behind.
    expect(h.playlistItemsInsert).not.toHaveBeenCalled();
    expect(h.playlistItemsDelete).not.toHaveBeenCalled();
  });
});

/**
 * A replace is reached from a modal on a page that may have been open for hours, and a YouTube
 * access token lasts about one. Reading with the cookie's token directly failed the write for a
 * reason the user could do nothing about - "Video replacement failed. Please try again" - and
 * trying again did not help, because the token was no fresher the second time.
 */
describe('POST /replace: when the page has been open longer than the token lives', () => {
  it('refreshes the token and does the write', async () => {
    h.refreshYoutubeAccessToken.mockResolvedValue({
      access_token: 'fresh-token',
      expiry_date: Date.now() + 3_600_000,
    });

    const response = await replace(
      { newVideoId: NEW_VIDEO, currentVideoId: OLD_VIDEO, playlistId: PLAYLIST_ID },
      { cookies: [SPOTIFY_COOKIE, youtubeTokenCookie({ expiresInMs: -1000 })] },
    );

    expect(h.refreshYoutubeAccessToken).toHaveBeenCalledWith('yt-refresh');
    expect(response.status).toBe(200);
    expect(h.playlistItemsInsert).toHaveBeenCalled();
  });

  // The refreshed token is written back, or the next request pays to refresh again.
  it('stores the refreshed token', async () => {
    h.refreshYoutubeAccessToken.mockResolvedValue({
      access_token: 'fresh-token',
      expiry_date: Date.now() + 3_600_000,
    });

    const response = await replace(
      { newVideoId: NEW_VIDEO, currentVideoId: OLD_VIDEO, playlistId: PLAYLIST_ID },
      { cookies: [SPOTIFY_COOKIE, youtubeTokenCookie({ expiresInMs: -1000 })] },
    );

    expect(findSetCookie(response, 'youtube_tokens')).toContain('fresh-token');
  });

  /**
   * The connection is genuinely gone. "Unable to update the playlist. Please try again" is wrong
   * twice over: trying again fails the same way, and the one action that fixes it is not offered.
   */
  it('offers a reconnect when the refresh fails, and writes nothing', async () => {
    h.refreshYoutubeAccessToken.mockRejectedValue(new Error('invalid_grant'));

    const response = await replace(
      { newVideoId: NEW_VIDEO, currentVideoId: OLD_VIDEO, playlistId: PLAYLIST_ID },
      { cookies: [SPOTIFY_COOKIE, youtubeTokenCookie({ expiresInMs: -1000 })] },
    );

    expect(response.status).toBe(401);
    expect(response.text).toContain('Reconnect to YouTube');
    expect(response.text).toContain('/auth/youtube/login');
    expect(h.playlistItemsInsert).not.toHaveBeenCalled();
    expect(h.playlistItemsDelete).not.toHaveBeenCalled();
  });
});

/**
 * The same page-open-longer-than-the-token problem, on the Spotify side: this write reads the
 * Spotify playlist, and its access token lasts about an hour. Reading with the cookie's token
 * directly 401'd the write with "Video replacement failed. Please try again" - advice that could
 * never work. The route must refresh through ensureValidSpotifyToken, or offer a reconnect.
 */
describe('POST /replace: when the Spotify access token has expired', () => {
  const expired = () => new SpotifyApiError('The access token expired', 401);

  it('refreshes the Spotify token and does the write', async () => {
    h.getCurrentUser.mockRejectedValue(expired());
    h.refreshAccessToken.mockResolvedValue({
      accessToken: 'fresh-sp-access',
      refreshToken: 'sp-refresh',
    });

    const response = await replace({
      newVideoId: NEW_VIDEO,
      currentVideoId: OLD_VIDEO,
      playlistId: PLAYLIST_ID,
    });

    expect(h.refreshAccessToken).toHaveBeenCalledWith('sp-refresh');
    expect(response.status).toBe(200);
    expect(h.playlistItemsInsert).toHaveBeenCalled();
    // The rewritten cookie must carry the refreshed token, or the next request pays to refresh again.
    expect(findSetCookie(response, 'spotify_tokens')).toContain('fresh-sp-access');
  });

  // The refresh token is dead too: the connection is over, so offer a reconnect and write nothing.
  it('offers a reconnect when the refresh fails, and writes nothing', async () => {
    h.getCurrentUser.mockRejectedValue(expired());
    h.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));

    const response = await replace({
      newVideoId: NEW_VIDEO,
      currentVideoId: OLD_VIDEO,
      playlistId: PLAYLIST_ID,
    });

    expect(response.status).toBe(401);
    expect(response.text).toContain('Reconnect to Spotify');
    expect(response.text).toContain('/auth/spotify/login');
    expect(response.text).not.toContain('Please try again');
    expect(h.playlistItemsInsert).not.toHaveBeenCalled();
    expect(h.playlistItemsDelete).not.toHaveBeenCalled();
  });
});

describe('POST /replace: replacing an existing video', () => {
  it('inserts the new video at the old one position, then deletes the old', async () => {
    const response = await replace({
      newVideoId: NEW_VIDEO,
      currentVideoId: OLD_VIDEO,
      playlistId: PLAYLIST_ID,
    });

    expect(response.status).toBe(200);
    // Position is the point: the replacement must land where the old video sat, not at the end.
    expect(h.playlistItemsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          snippet: expect.objectContaining({
            playlistId: 'PL-yt',
            position: 3,
            resourceId: { kind: 'youtube#video', videoId: NEW_VIDEO },
          }),
        }),
      }),
    );
    expect(h.playlistItemsDelete).toHaveBeenCalledWith({ id: 'item-old' });
  });

  it('inserts before deleting, so the slot is never empty', async () => {
    await replace({ newVideoId: NEW_VIDEO, currentVideoId: OLD_VIDEO, playlistId: PLAYLIST_ID });

    expect(h.playlistItemsInsert.mock.invocationCallOrder[0]).toBeLessThan(
      h.playlistItemsDelete.mock.invocationCallOrder[0]!,
    );
  });

  it('tells the user it worked', async () => {
    const response = await replace({
      newVideoId: NEW_VIDEO,
      currentVideoId: OLD_VIDEO,
      playlistId: PLAYLIST_ID,
    });

    expect(response.text).toContain('Video replaced successfully');
  });
});

describe('POST /replace: adding a video to an unlinked track', () => {
  it('appends the video when there is no current video', async () => {
    const response = await replace({ newVideoId: NEW_VIDEO, playlistId: PLAYLIST_ID });

    expect(response.status).toBe(200);
    expect(response.text).toContain('Video linked successfully');
    expect(h.playlistItemsInsert).toHaveBeenCalled();
    // Add mode must not delete anything - there is nothing to replace.
    expect(h.playlistItemsDelete).not.toHaveBeenCalled();
  });

  it('treats an empty currentVideoId as adding, not replacing', async () => {
    const response = await replace({
      newVideoId: NEW_VIDEO,
      currentVideoId: '',
      playlistId: PLAYLIST_ID,
    });

    expect(response.status).toBe(200);
    expect(h.playlistItemsDelete).not.toHaveBeenCalled();
  });
});

describe('POST /replace: waiting for YouTube to propagate', () => {
  // An added video cannot be moved until YouTube has finished registering it.
  it('waits after an addition, before moving the video', async () => {
    await replace({ newVideoId: NEW_VIDEO, playlistId: PLAYLIST_ID });

    expect(h.sleep).toHaveBeenCalledWith(3000);
    expect(h.sleep.mock.invocationCallOrder[0]!).toBeLessThan(
      h.fetchAllPlaylistItems.mock.invocationCallOrder[0]!,
    );
  });

  // A replace reads nothing back, so it has nothing to wait for. The second of waiting was pure
  // cost on the request the user is sitting in front of.
  it('does not wait at all on a replacement', async () => {
    await replace({ newVideoId: NEW_VIDEO, currentVideoId: OLD_VIDEO, playlistId: PLAYLIST_ID });

    expect(h.sleep).not.toHaveBeenCalled();
  });
});

/**
 * What a manual edit is allowed to cost.
 *
 * Every playlist write costs 50 of a 10,000-unit daily budget. Re-planning the whole playlist
 * after a one-video edit spent 84 of them on a single swap, could not finish (YouTube aborts with
 * a 409 partway), and left the order worse than it started - so the next edit had more to undo.
 */
describe('POST /replace: the rest of the playlist is left alone', () => {
  const writeCount = () =>
    h.playlistItemsInsert.mock.calls.length +
    h.playlistItemsDelete.mock.calls.length +
    h.playlistItemsUpdate.mock.calls.length;

  it('costs exactly two writes to replace a video: the insert and the delete', async () => {
    await replace({ newVideoId: NEW_VIDEO, currentVideoId: OLD_VIDEO, playlistId: PLAYLIST_ID });

    expect(writeCount()).toBe(2);
    expect(h.playlistItemsUpdate).not.toHaveBeenCalled();
  });

  // The insert went in at the old video's position, so the order is already what it was.
  it('reads nothing back after a replacement', async () => {
    await replace({ newVideoId: NEW_VIDEO, currentVideoId: OLD_VIDEO, playlistId: PLAYLIST_ID });

    expect(h.fetchAllPlaylistItems).not.toHaveBeenCalled();
  });

  it('costs one further write to place an added video: the move', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([
      { track: { id: TRACK_ID, name: 'Creep', type: 'track', artists: [{ name: 'Radiohead' }] } },
    ]);
    h.playlistItemsList.mockResolvedValue({
      data: {
        items: [
          {
            id: 'item-new',
            snippet: {
              position: 0,
              resourceId: { videoId: NEW_VIDEO },
              title: 'Radiohead - Creep',
            },
          },
        ],
      },
    });

    await replace({ newVideoId: NEW_VIDEO, playlistId: PLAYLIST_ID });

    expect(h.playlistItemsInsert).toHaveBeenCalledTimes(1);
    expect(h.playlistItemsUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('POST /replace: placing an added video', () => {
  /** Spotify order: three tracks, the added one in the middle. */
  const threeTracks = () => {
    h.fetchAllPlaylistItems.mockResolvedValue([
      { track: { id: 'track-first', name: 'First', type: 'track', artists: [{ name: 'A' }] } },
      { track: { id: TRACK_ID, name: 'Creep', type: 'track', artists: [{ name: 'Radiohead' }] } },
      { track: { id: 'track-last', name: 'Last', type: 'track', artists: [{ name: 'Z' }] } },
    ]);
    h.playlistItemsList.mockResolvedValue({
      data: {
        items: [
          {
            id: 'item-first',
            snippet: { position: 0, resourceId: { videoId: 'vFirst' }, title: 'A - First' },
          },
          {
            id: 'item-last',
            snippet: { position: 1, resourceId: { videoId: 'vLast' }, title: 'Z - Last' },
          },
          {
            id: 'item-new',
            snippet: {
              position: 2,
              resourceId: { videoId: NEW_VIDEO },
              title: 'Radiohead - Creep',
            },
          },
        ],
      },
    });
  };

  it('moves it to the slot its track occupies in Spotify order', async () => {
    threeTracks();

    await replace({ newVideoId: NEW_VIDEO, playlistId: PLAYLIST_ID });

    // One video ahead of it in Spotify order, so position 1 - not 2, where it was appended.
    expect(h.playlistItemsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          id: 'item-new',
          snippet: expect.objectContaining({
            position: 1,
            resourceId: { kind: 'youtube#video', videoId: NEW_VIDEO },
          }),
        }),
      }),
    );
  });

  // The write landed - the video is linked and in the playlist - so this is not an error. It is
  // not what was asked for either: saying "linked successfully" is how a playlist ends up in an
  // order nobody chose with nothing on screen having said so.
  it('says the position could not be set when the move fails, rather than reporting success', async () => {
    threeTracks();
    h.playlistItemsUpdate.mockRejectedValue(new Error('the operation was aborted'));

    const response = await replace({ newVideoId: NEW_VIDEO, playlistId: PLAYLIST_ID });

    expect(response.status).toBe(200);
    expect(h.playlistItemsUpdate).toHaveBeenCalled();
    expect(response.text).toContain('could not be moved into position');
    expect(response.text).not.toContain('Video linked successfully');
  });

  it('leaves it where it is when its track is no longer in the Spotify playlist', async () => {
    h.fetchAllPlaylistItems.mockResolvedValue([
      { track: { id: 'someone-else', name: 'Other', type: 'track', artists: [{ name: 'B' }] } },
    ]);

    const response = await replace({ newVideoId: NEW_VIDEO, playlistId: PLAYLIST_ID });

    expect(response.status).toBe(200);
    expect(h.playlistItemsUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /replace: failures', () => {
  it('reports a 500 when the write itself fails', async () => {
    h.playlistItemsInsert.mockRejectedValue(new Error('youtube exploded'));

    const response = await replace({
      newVideoId: NEW_VIDEO,
      currentVideoId: OLD_VIDEO,
      playlistId: PLAYLIST_ID,
    });

    expect(response.status).toBe(500);
    expect(response.text).toContain('Video replacement failed');
  });

  // "Please try again" is wrong advice when the next attempt is refused before it reaches YouTube,
  // so a limit is told apart from a failure: what is blocking, when it lifts, and a 503.
  it('says the daily quota is spent, and when it comes back, when the write hits it', async () => {
    h.playlistItemsInsert.mockRejectedValue(new YoutubeApiError('quota', 403, 'quotaExceeded'));

    const response = await replace({
      newVideoId: NEW_VIDEO,
      currentVideoId: OLD_VIDEO,
      playlistId: PLAYLIST_ID,
    });

    expect(response.status).toBe(503);
    expect(response.text).toContain('YouTube is not accepting changes');
    expect(response.text).toContain(
      'Nothing was changed, because the daily YouTube API quota is exhausted.',
    );
    expect(response.text).toMatch(/retry in about (an hour|\d+ hours|\d+ minutes|a minute)\./);
    expect(response.text).toContain('A daily quota resets at midnight Pacific.');
  });

  it('tells the page to disable its other edit controls when the quota is spent', async () => {
    h.playlistItemsInsert.mockRejectedValue(new YoutubeApiError('quota', 403, 'quotaExceeded'));

    const response = await replace({
      newVideoId: NEW_VIDEO,
      currentVideoId: OLD_VIDEO,
      playlistId: PLAYLIST_ID,
    });

    expect(response.headers['hx-trigger']).toBe('youtube-blocked');
  });

  it('refuses without writing when YouTube is already known to be refusing', async () => {
    youtubeCircuitBreaker.open('the daily YouTube API quota is exhausted');

    const response = await replace({
      newVideoId: NEW_VIDEO,
      currentVideoId: OLD_VIDEO,
      playlistId: PLAYLIST_ID,
    });

    expect(response.status).toBe(503);
    expect(response.text).toContain('because the daily YouTube API quota is exhausted.');
    expect(h.playlistItemsInsert).not.toHaveBeenCalled();
  });

  it('says YouTube refused, and to retry shortly, on a throttle that has not shut writes off', async () => {
    h.playlistItemsInsert.mockRejectedValue(new YoutubeApiError('rate', 403, 'rateLimitExceeded'));

    const response = await replace({
      newVideoId: NEW_VIDEO,
      currentVideoId: OLD_VIDEO,
      playlistId: PLAYLIST_ID,
    });

    expect(response.status).toBe(503);
    expect(response.text).toContain('Nothing was changed, because YouTube refused the request.');
    expect(response.text).toContain('retry shortly.');
  });

  it('reports a 500 when Spotify cannot be reached', async () => {
    h.getPlaylist.mockRejectedValue(new Error('spotify down'));

    const response = await replace({
      newVideoId: NEW_VIDEO,
      currentVideoId: OLD_VIDEO,
      playlistId: PLAYLIST_ID,
    });

    expect(response.status).toBe(500);
  });
});
