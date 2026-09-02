/**
 * Integration tests for Spotify routes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { findSetCookie } from '@tests/helpers/httpCookies';
import { youtubeCircuitBreaker } from '@/lib/circuitBreaker';
import { createApp } from '@/app';
import { testServer } from '@tests/helpers/testServer';
import {
  getAuthorizeUrl,
  getCurrentUser,
  getUserPlaylists,
  SpotifyIncompleteResponseError,
} from '@/spotify/client';
import { YoutubeApiError } from '@/youtube/client';

// Helper to create valid YouTube token cookies (with all required Zod fields)
const createMockYouTubeToken = (overrides?: Partial<any>) =>
  JSON.stringify({
    access_token: 'test-youtube-token',
    refresh_token: 'test-youtube-refresh',
    scope: 'https://www.googleapis.com/auth/youtube',
    token_type: 'Bearer',
    ...overrides,
  });

// Mock the hand-written Spotify client. The real SpotifyApiError class is kept so
// the route's status-based error branching works; the code-exchange default
// rejects (as the old authorizationCodeGrant mock did) so the callback redirects
// home with an error.
vi.mock('@/spotify/client', async (importActual) => {
  const actual = await importActual<typeof import('@/spotify/client')>();
  return {
    ...actual,
    getAuthorizeUrl: vi.fn(() => 'https://accounts.spotify.com/authorize?client_id=test'),
    exchangeCodeForTokens: vi.fn(() =>
      Promise.reject(new actual.SpotifyApiError('Invalid client', 400)),
    ),
    getCurrentUser: vi.fn(async () => ({ id: 'test-user', displayName: null })),
    getUserPlaylists: vi.fn(async () => []),
  };
});

// The /playlists route resolves a valid access token via ensureValidSpotifyToken.
vi.mock('@/spotify/auth', () => ({
  ensureValidSpotifyToken: vi.fn(async () => 'test-access-token'),
}));

/**
 * The playlist list resolves its YouTube client through ensureValidYouTubeToken rather than the
 * cookie's access token, so that a token which expired while the app sat unused is refreshed rather
 * than failing the read - see the "when the YouTube token has expired" tests below.
 */
const ytAuth = vi.hoisted(() => ({ ensureValidYouTubeToken: vi.fn() }));
vi.mock('@/youtube/auth', async (importActual) => ({
  ...(await importActual<typeof import('@/youtube/auth')>()),
  ensureValidYouTubeToken: ytAuth.ensureValidYouTubeToken,
}));

const mockedGetCurrentUser = vi.mocked(getCurrentUser);
const mockedGetUserPlaylists = vi.mocked(getUserPlaylists);

// Maps the old spotify-web-api-node playlist fixture shape to the clean
// SpotifyPlaylistSummary the new client returns.
const playlistSummary = (id: string, name: string, trackTotal: number, ownerId = 'test-user') => ({
  id,
  name,
  ownerId,
  trackTotal,
  spotifyUrl: `https://open.spotify.com/playlist/${id}`,
});

/**
 * What playlists.list resolves to. Named, because an inline `items: []` infers never[] and then no
 * test can hand it a playlist without a type error.
 */
type YtPlaylistList = Promise<{ data: { items: Array<{ snippet?: { title?: string } }> } }>;

// Mock the YouTube client. createYoutubeClient returns a shared client object so
// per-test overrides of `ytClient.client.playlists.list` take effect.
const ytClient = vi.hoisted(() => ({
  client: {
    playlists: { list: vi.fn((): YtPlaylistList => Promise.resolve({ data: { items: [] } })) },
  },
}));
vi.mock('@/youtube/client', async (importActual) => {
  const actual = await importActual<typeof import('@/youtube/client')>();
  return { ...actual, createYoutubeClient: vi.fn(() => ytClient.client) };
});

const app = testServer(createApp());

/**
 * The breaker is a module singleton and the YouTube client is shared, so a test that trips one or
 * swaps the other hands that state to whatever runs next. The quota test at the bottom of this file
 * does both, and is harmless only for as long as it stays last.
 */
beforeEach(() => {
  youtubeCircuitBreaker.close();
  ytClient.client.playlists.list = vi.fn(() => Promise.resolve({ data: { items: [] } }));
  ytAuth.ensureValidYouTubeToken.mockResolvedValue({
    client: ytClient.client,
    accessToken: 'test-youtube-token',
    quotaUsed: 1,
  });
});

describe('Spotify Playlists', () => {
  /**
   * Spotify hands back an empty library now and then - it did so in the wild, once, and the next
   * request got all 63 back. Caching that answer for half an hour is what turns a blip into an
   * outage: the page reloads straight out of the browser cache, still empty, and only the refresh
   * button (which sends no-cache) can clear it.
   */
  describe('GET /auth/spotify/playlists: caching', () => {
    const spotifyCookie = `spotify_tokens=${JSON.stringify({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
    })}`;

    const fetchWith = async (playlists: ReturnType<typeof playlistSummary>[]) => {
      mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue(playlists);
      return request(app).get('/auth/spotify/playlists').set('Cookie', [spotifyCookie]);
    };

    it('does not cache an empty library, so the next reload can recover', async () => {
      const response = await fetchWith([]);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-cache');
    });

    // The long cache is here to protect YouTube quota, which is only spent when there are
    // playlists to check the sync status of.
    it('caches a real library for 30 minutes', async () => {
      const response = await fetchWith([playlistSummary('1234567890123456789012', 'Real', 10)]);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('private, max-age=1800');
    });
  });

  /**
   * The scopes are the whole point of the redirect: ask for too few and every later call 403s, ask
   * for more than the app uses and the user is handed a consent screen for permissions nothing
   * needs. getAuthorizeUrl is mocked with a fixed URL, so the only way to see what was asked for is
   * to assert the call - nothing else in this file looked, and the scopes could be emptied without
   * a test noticing.
   */
  describe('GET /auth/spotify/login', () => {
    it('asks for exactly the playlist scopes the app reads', async () => {
      await request(app).get('/auth/spotify/login');

      expect(vi.mocked(getAuthorizeUrl)).toHaveBeenCalledWith(
        ['playlist-read-private', 'playlist-read-collaborative'],
        expect.any(String),
      );
    });

    // Spotify renders a generic error page for an authenticated user when `state=` is present but
    // empty, so an empty state does not fail the CSRF check - it breaks the flow outright.
    it('sends a state that is actually there', async () => {
      await request(app).get('/auth/spotify/login');

      const [, state] = vi.mocked(getAuthorizeUrl).mock.calls.at(-1)!;
      expect(state).toBeTruthy();
    });
  });

  describe('GET /auth/spotify/playlists', () => {
    it('should return 401 when not authenticated', async () => {
      const response = await request(app).get('/auth/spotify/playlists').expect(401);

      expect(response.text).toContain('Please connect to Spotify first');
    });

    /**
     * A YouTube access token lasts about an hour, and this page is the first thing loaded after the
     * app has been left alone for longer than that. Reported by Preston on 2026-07-15: "youtube
     * shows connected but nothing showed up as actually synced".
     *
     * The read that decides what is synced used to go out on the cookie's access token directly. A
     * dead token failed it, the failure was caught and treated as "no YouTube playlists exist", and
     * every playlist rendered as unsynced - while the connection button, which only looks for the
     * cookie, still said connected. Nothing on screen said anything had gone wrong.
     */
    describe('when the YouTube token has expired while the app sat unused', () => {
      const spotifyCookie = `spotify_tokens=${JSON.stringify({
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
      })}`;

      const load = () =>
        request(app)
          .get('/auth/spotify/playlists')
          .set('Cookie', [spotifyCookie, `youtube_tokens=${createMockYouTubeToken()}`]);

      beforeEach(() => {
        mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
        mockedGetUserPlaylists.mockResolvedValue([playlistSummary('1', 'Banana', 1)]);
        ytClient.client.playlists.list = vi.fn(() =>
          Promise.resolve({ data: { items: [{ snippet: { title: 'Banana (from Spotify)' } }] } }),
        );
      });

      it('refreshes it rather than reading with a dead one', async () => {
        await load();

        expect(ytAuth.ensureValidYouTubeToken).toHaveBeenCalled();
      });

      it('still shows the playlist as synced', async () => {
        const response = await load();

        expect(response.text).toContain('Update YouTube Playlist');
      });

      // The refresh failing means the connection really is gone. Saying so is honest; reporting a
      // synced library as unsynced is not.
      it('disconnects YouTube when the token cannot be refreshed', async () => {
        ytAuth.ensureValidYouTubeToken.mockRejectedValue(new Error('YOUTUBE_AUTH_REQUIRED'));

        const response = await load();

        expect(response.status).toBe(200);
        expect(findSetCookie(response, 'youtube_tokens')).toContain('Expires=Thu, 01 Jan 1970');
      });

      it('does not claim the playlist is unsynced when it cannot check', async () => {
        ytAuth.ensureValidYouTubeToken.mockRejectedValue(new Error('YOUTUBE_AUTH_REQUIRED'));

        const response = await load();

        // Not connected, so it offers a connect rather than a sync-state it cannot know.
        expect(response.text).not.toContain('Update YouTube Playlist');
      });
    });

    /**
     * "Could not check" is not "nothing is synced".
     *
     * A failure this route does not understand used to be swallowed, and the read treated as "no
     * YouTube playlists exist" - so every playlist rendered as unsynced, beside a connection button
     * that still said connected. A user acting on that re-syncs a playlist that was already synced
     * and pays YouTube quota for it. Only 403 (quota) has an answer here; 401 is handled by the
     * refresh before the read. Anything else has to reach the error handler.
     */
    describe('when YouTube cannot be read for a reason this route does not understand', () => {
      const spotifyCookie = `spotify_tokens=${JSON.stringify({
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
      })}`;

      const load = () =>
        request(app)
          .get('/auth/spotify/playlists')
          .set('Cookie', [spotifyCookie, `youtube_tokens=${createMockYouTubeToken()}`]);

      beforeEach(() => {
        mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
        mockedGetUserPlaylists.mockResolvedValue([playlistSummary('1', 'Banana', 1)]);
      });

      it.each([
        ['a 500 from YouTube', new YoutubeApiError('boom', 500)],
        ['a network failure', new Error('ECONNRESET')],
      ])('reports an error rather than a library, on %s', async (_label, error) => {
        ytClient.client.playlists.list = vi.fn(() => Promise.reject(error));

        const response = await load();

        expect(response.status).toBe(500);
        expect(response.text).toContain('Error fetching playlists');
      });

      // The lie it must not tell: the playlist IS synced, and saying otherwise invites a resync
      // that costs quota to do nothing.
      it('does not render a synced playlist as unsynced', async () => {
        ytClient.client.playlists.list = vi.fn(() => Promise.reject(new Error('ECONNRESET')));

        const response = await load();

        expect(response.text).not.toContain('Sync to YouTube');
      });

      // Quota is the one failure it does understand, and it has its own answer.
      it('still redirects on a quota 403 rather than erroring', async () => {
        ytClient.client.playlists.list = vi.fn(() =>
          Promise.reject(new YoutubeApiError('quota', 403, 'quotaExceeded')),
        );

        const response = await load();

        expect(response.status).toBe(403);
        expect(response.headers['hx-redirect']).toBe('/?error=youtube&reason=quota_exceeded');
      });
    });

    /**
     * The order of the list is the only thing telling the user what is already synced. It is two
     * sorts and a concat, and nothing asserted either: the sorts could be removed entirely and the
     * page would still render, in whatever order Spotify happened to return.
     */
    it('lists synced playlists first, each group alphabetical', async () => {
      mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('4', 'Zebra', 1),
        playlistSummary('1', 'Banana', 1),
        playlistSummary('2', 'Apple', 1),
        playlistSummary('3', 'Cherry', 1),
      ]);
      // Banana and Zebra already have a YouTube playlist mirroring them.
      ytClient.client.playlists.list = vi.fn(() =>
        Promise.resolve({
          data: {
            items: [
              { snippet: { title: 'Banana (from Spotify)' } },
              { snippet: { title: 'Zebra (from Spotify)' } },
            ],
          },
        }),
      );

      const response = await request(app)
        .get('/auth/spotify/playlists')
        .set('Cookie', [
          `spotify_tokens=${JSON.stringify({
            accessToken: 'test-access-token',
            refreshToken: 'test-refresh-token',
          })}`,
        ])
        .set('Cookie', [
          `spotify_tokens=${JSON.stringify({
            accessToken: 'test-access-token',
            refreshToken: 'test-refresh-token',
          })}`,
          `youtube_tokens=${createMockYouTubeToken()}`,
        ]);

      const order = ['Banana', 'Zebra', 'Apple', 'Cherry'].map((name) =>
        response.text.indexOf(`>${name}<`),
      );
      expect(order.every((i) => i !== -1)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('should accept ownOnly=true parameter', async () => {
      const response = await request(app).get('/auth/spotify/playlists').query({ ownOnly: 'true' });

      // Should return 401 (no auth), but parameter should be validated successfully
      expect(response.status).toBe(401);
    });

    it('should accept ownOnly=false parameter', async () => {
      const response = await request(app)
        .get('/auth/spotify/playlists')
        .query({ ownOnly: 'false' });

      // Should return 401 (no auth), but parameter should be validated successfully
      expect(response.status).toBe(401);
    });

    it('should reject invalid ownOnly parameter', async () => {
      const response = await request(app)
        .get('/auth/spotify/playlists')
        .query({ ownOnly: 'invalid' });

      // Validation middleware returns 400 with error template
      expect(response.status).toBe(400);
      // Just verify it's HTML with error indication
      expect(response.text).toBeTruthy();
      expect(response.headers['content-type']).toMatch(/html/);
    });

    it('should handle missing ownOnly parameter (optional)', async () => {
      const response = await request(app).get('/auth/spotify/playlists');

      // Should return 401 (no auth), but parameter validation should pass
      expect(response.status).toBe(401);
    });
  });

  describe('GET /auth/spotify/login', () => {
    it('should redirect to Spotify authorization', async () => {
      const response = await request(app).get('/auth/spotify/login').expect(302);

      expect(response.headers.location).toContain('accounts.spotify.com');
      expect(response.headers.location).toContain('authorize');
    });
  });

  describe('GET /auth/spotify/callback', () => {
    it('should reject requests without code parameter', async () => {
      const response = await request(app).get('/auth/spotify/callback');

      // Validation middleware returns 400 with error template
      expect(response.status).toBe(400);
      // Just verify it's HTML with error indication
      expect(response.text).toBeTruthy();
      expect(response.headers['content-type']).toMatch(/html/);
    });

    it('should accept valid code with matching OAuth state', async () => {
      // A valid flow presents both the state query param and the matching
      // state cookie set during /login. Validation + state check pass, then the
      // mocked Spotify API rejects the code exchange, so the route redirects
      // home with error params.
      const response = await request(app)
        .get('/auth/spotify/callback')
        .set('Cookie', 'spotify_oauth_state=matching-state-value')
        .query({ code: 'test-authorization-code-from-spotify', state: 'matching-state-value' });

      expect(response.status).toBe(302);
      expect(response.headers['location']).toMatch(/^\/\?error=spotify&reason=/);
    });

    /**
     * The reason in the redirect is a contract with indexPage.js, which turns each one into a
     * specific message ("Rate limited by Spotify", "temporarily unavailable"). Nothing on the
     * server side pinned which status produces which reason: rename one here and the page silently
     * falls back to "Connection failed. Please try again" for an error it has a real message for.
     */
    describe('the failure reason it reports', () => {
      const callbackFailing = async (error: unknown) => {
        const { exchangeCodeForTokens } = await import('@/spotify/client');
        vi.mocked(exchangeCodeForTokens).mockRejectedValueOnce(error);
        return request(app)
          .get('/auth/spotify/callback')
          .set('Cookie', 'spotify_oauth_state=s')
          .query({ code: 'a-code', state: 's' });
      };

      it.each([
        [429, 'rate_limited'],
        [401, 'auth_error'],
        [502, 'service_unavailable'],
        [503, 'service_unavailable'],
      ])('reports %i as reason=%s', async (status, reason) => {
        const { SpotifyApiError } = await import('@/spotify/client');
        const response = await callbackFailing(new SpotifyApiError('nope', status));

        expect(response.headers['location']).toBe(`/?error=spotify&reason=${reason}`);
      });

      // A status with no specific message, and a failure that is not a Spotify error at all, both
      // fall to the generic reason rather than throwing or leaking a status into the URL.
      it.each([
        ['a 500 SpotifyApiError', 500],
        ['a 400 SpotifyApiError', 400],
      ])('reports %s as reason=failed', async (_label, status) => {
        const { SpotifyApiError } = await import('@/spotify/client');
        const response = await callbackFailing(new SpotifyApiError('nope', status));

        expect(response.headers['location']).toBe('/?error=spotify&reason=failed');
      });

      it('reports a non-Spotify error as reason=failed', async () => {
        const response = await callbackFailing(new Error('socket hang up'));

        expect(response.headers['location']).toBe('/?error=spotify&reason=failed');
      });
    });

    it('should reject callback when OAuth state does not match the cookie', async () => {
      const response = await request(app)
        .get('/auth/spotify/callback')
        .set('Cookie', 'spotify_oauth_state=expected-state')
        .query({ code: 'test-authorization-code-from-spotify', state: 'attacker-supplied-state' });

      expect(response.status).toBe(302);
      expect(response.headers['location']).toBe('/?error=spotify&reason=state_mismatch');
    });

    it('should reject callback when OAuth state cookie is missing', async () => {
      const response = await request(app)
        .get('/auth/spotify/callback')
        .query({ code: 'test-authorization-code-from-spotify', state: 'some-state' });

      expect(response.status).toBe(302);
      expect(response.headers['location']).toBe('/?error=spotify&reason=state_mismatch');
    });

    // The happy path: nothing exercised the exchange SUCCEEDING - storing the tokens and going home.
    it('stores the tokens and returns home on a successful exchange', async () => {
      const { exchangeCodeForTokens } = await import('@/spotify/client');
      vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce({
        accessToken: 'the-access-token',
        refreshToken: 'the-refresh-token',
      } as Awaited<ReturnType<typeof exchangeCodeForTokens>>);

      const response = await request(app)
        .get('/auth/spotify/callback')
        .set('Cookie', 'spotify_oauth_state=s')
        .query({ code: 'a-code', state: 's' });

      expect(response.status).toBe(302);
      expect(response.headers['location']).toBe('/');
      const cookie = findSetCookie(response, 'spotify_tokens');
      expect(cookie).toBeDefined();
      expect(cookie).not.toMatch(/^spotify_tokens=;/); // a real value, not a clear
    });
  });

  /**
   * Branches of the playlist list that its own thorough suite left unpinned: the ownership filter
   * actually filtering, the summary line, and the Spotify-side 503/429 error partials.
   */
  describe('GET /auth/spotify/playlists: filtering, summary, and Spotify errors', () => {
    const spotifyCookie = `spotify_tokens=${JSON.stringify({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
    })}`;
    const list = (cookies: string[]) =>
      request(app).get('/auth/spotify/playlists').set('Cookie', cookies);

    it('says the fetch failed when Spotify promises playlists and sends none', async () => {
      // The 2026-07-16 outage: a 200 carrying {items: [], total: 63}. Rendering the ordinary empty
      // state tells someone with 63 playlists that they have none, which reads as data loss.
      mockedGetCurrentUser.mockResolvedValue({ id: 'me', displayName: null });
      mockedGetUserPlaylists.mockRejectedValue(new SpotifyIncompleteResponseError(63));

      const response = await list([spotifyCookie]);

      expect(response.status).toBe(502);
      expect(response.text).toContain('Spotify did not return your playlists');
      expect(response.text).toContain('63');
      expect(response.text).not.toMatch(/no playlists|Showing 0/i);
    });

    it('keeps only the current user’s playlists when ownOnly is set', async () => {
      mockedGetCurrentUser.mockResolvedValue({ id: 'me', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1', 'Mine', 1, 'me'),
        playlistSummary('2', 'Theirs', 1, 'someone-else'),
      ]);

      const response = await list([spotifyCookie]).query({ ownOnly: 'true' });

      expect(response.status).toBe(200);
      expect(response.text).toContain('>Mine<');
      expect(response.text).not.toContain('>Theirs<');
    });

    it('keeps every playlist when ownOnly is not set', async () => {
      mockedGetCurrentUser.mockResolvedValue({ id: 'me', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1', 'Mine', 1, 'me'),
        playlistSummary('2', 'Theirs', 1, 'someone-else'),
      ]);

      const response = await list([spotifyCookie]);

      expect(response.text).toContain('>Mine<');
      expect(response.text).toContain('>Theirs<');
    });

    it('summarizes the count alone when YouTube is not connected', async () => {
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1', 'A', 1),
        playlistSummary('2', 'B', 1),
      ]);

      const response = await list([spotifyCookie]);

      expect(response.text).toContain('2 playlists');
      expect(response.text).not.toContain(' · '); // the "· N synced" middot only appears when connected
    });

    it('summarizes count and synced when YouTube is connected', async () => {
      mockedGetUserPlaylists.mockResolvedValue([playlistSummary('1', 'A', 1)]);
      ytClient.client.playlists.list = vi.fn(() =>
        Promise.resolve({ data: { items: [{ snippet: { title: 'A (from Spotify)' } }] } }),
      );

      const response = await list([spotifyCookie, `youtube_tokens=${createMockYouTubeToken()}`]);

      expect(response.text).toContain('1 playlists · 1 synced');
    });

    it('renders a 503 partial when Spotify is temporarily unavailable', async () => {
      const { SpotifyApiError } = await import('@/spotify/client');
      mockedGetUserPlaylists.mockRejectedValueOnce(new SpotifyApiError('down', 503));

      const response = await list([spotifyCookie]);

      expect(response.status).toBe(503);
      expect(response.text).toContain('Spotify is temporarily unavailable');
    });

    it('renders a 429 partial when Spotify rate-limits the request', async () => {
      const { SpotifyApiError } = await import('@/spotify/client');
      const err = new SpotifyApiError('slow down', 429);
      (err as Error & { retryAfter?: number }).retryAfter = 30;
      mockedGetUserPlaylists.mockRejectedValueOnce(err);

      const response = await list([spotifyCookie]);

      expect(response.status).toBe(429);
      expect(response.text).toContain('Too many requests');
    });

    it('drops the YouTube connection when the circuit breaker is open', async () => {
      youtubeCircuitBreaker.open('the daily YouTube API quota is exhausted');
      mockedGetUserPlaylists.mockResolvedValue([playlistSummary('1', 'A', 1)]);

      const response = await list([spotifyCookie, `youtube_tokens=${createMockYouTubeToken()}`]);

      expect(response.status).toBe(200);
      // The breaker refused the sync-status check, so the stale YouTube cookie is cleared.
      expect(findSetCookie(response, 'youtube_tokens')).toMatch(/^youtube_tokens=;/);
    });
  });

  describe('GET /auth/spotify/login - OAuth state', () => {
    it('should set a non-empty spotify_oauth_state cookie', async () => {
      const response = await request(app).get('/auth/spotify/login').expect(302);

      const stateCookie = findSetCookie(response, 'spotify_oauth_state');
      expect(stateCookie).toBeDefined();
      // Cookie must carry an actual value and use SameSite=Lax so it survives
      // the cross-site redirect back from Spotify.
      expect(stateCookie).not.toMatch(/^spotify_oauth_state=;/);
      expect(stateCookie).toMatch(/SameSite=Lax/i);
    });
  });

  describe('Sync Button Visibility (YouTube Connection)', () => {
    it('should show disabled button when YouTube is not connected', async () => {
      // Mock Spotify API to return playlists
      mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1234567890123456789012', 'Test Playlist', 10),
      ]);

      // Set Spotify cookie but NOT YouTube cookie
      const spotifyTokens = JSON.stringify({
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
      });

      const response = await request(app)
        .get('/auth/spotify/playlists')
        .set('Cookie', [`spotify_tokens=${spotifyTokens}`])
        .expect(200);

      // Should render playlists with disabled sync button
      expect(response.text).toContain('Connect to YouTube to Sync');
      expect(response.text).toContain('disabled');
      // Should NOT contain the enabled sync button text
      expect(response.text).not.toContain('Sync to YouTube');
    });

    it('should show enabled sync button when both Spotify and YouTube are connected', async () => {
      // Mock Spotify API
      mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1234567890123456789012', 'Test Playlist', 10),
      ]);

      // Set both Spotify AND YouTube cookies
      const spotifyTokens = JSON.stringify({
        accessToken: 'test-spotify-token',
        refreshToken: 'test-spotify-refresh',
      });
      const youtubeTokens = createMockYouTubeToken();

      const response = await request(app)
        .get('/auth/spotify/playlists')
        .set('Cookie', [`spotify_tokens=${spotifyTokens}`, `youtube_tokens=${youtubeTokens}`])
        .expect(200);

      // Should render playlists with enabled sync button
      expect(response.text).toContain('Sync to YouTube');
      // Should NOT contain the disabled button text
      expect(response.text).not.toContain('Connect to YouTube to Sync');
    });

    it('should show "Update YouTube Playlist" for synced playlists when YouTube is connected', async () => {
      // Mock Spotify API
      mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1234567890123456789012', 'Synced Playlist', 10),
      ]);

      // Set both cookies
      const spotifyTokens = JSON.stringify({
        accessToken: 'test-spotify-token',
        refreshToken: 'test-spotify-refresh',
      });
      const youtubeTokens = createMockYouTubeToken();

      const response = await request(app)
        .get('/auth/spotify/playlists')
        .set('Cookie', [`spotify_tokens=${spotifyTokens}`, `youtube_tokens=${youtubeTokens}`])
        .expect(200);

      // For unsynced playlists, should show "Sync to YouTube"
      expect(response.text).toContain('Sync to YouTube');
    });
  });

  describe('Playlist Summary Text Based on YouTube Connection', () => {
    it('should show playlist count when YouTube is not connected', async () => {
      // Mock Spotify API
      mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1234567890123456789012', 'Test Playlist 1', 10),
        playlistSummary('2234567890123456789012', 'Test Playlist 2', 5),
      ]);

      // Set only Spotify cookie (no YouTube)
      const spotifyTokens = JSON.stringify({
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
      });

      const response = await request(app)
        .get('/auth/spotify/playlists')
        .set('Cookie', [`spotify_tokens=${spotifyTokens}`])
        .expect(200);

      // Shows a plain playlist count; sync status can't be determined without YouTube
      expect(response.text).toContain('2 playlists');
      expect(response.text).not.toContain('connect YouTube to check sync status');
    });

    it('should show 0 synced when YouTube is connected but no playlists are synced', async () => {
      // Mock Spotify API
      mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1234567890123456789012', 'Unsynced Playlist', 10),
      ]);

      // Set both Spotify and YouTube cookies
      const spotifyTokens = JSON.stringify({
        accessToken: 'test-spotify-token',
        refreshToken: 'test-spotify-refresh',
      });
      const youtubeTokens = createMockYouTubeToken();

      const response = await request(app)
        .get('/auth/spotify/playlists')
        .set('Cookie', [`spotify_tokens=${spotifyTokens}`, `youtube_tokens=${youtubeTokens}`])
        .expect(200);

      // YouTube is connected but nothing matches, so the count shows 0 synced
      expect(response.text).toContain('1 playlists · 0 synced');
      // Should NOT show "connect YouTube" message
      expect(response.text).not.toContain('connect YouTube to check sync status');
    });

    it('should show the synced count when YouTube is connected and playlists are synced', async () => {
      // Mock Spotify API
      mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1234567890123456789012', 'Synced Playlist', 10),
        playlistSummary('2234567890123456789012', 'Unsynced Playlist', 5),
      ]);

      // Mock YouTube API to return a synced playlist
      ytClient.client.playlists.list = vi.fn(() =>
        Promise.resolve({
          data: {
            items: [
              {
                id: 'yt_playlist_id',
                snippet: {
                  title: 'Synced Playlist (from Spotify)', // This matches "Synced Playlist" + " (from Spotify)"
                },
              },
            ],
          },
        }),
      ) as any;

      // Set both cookies
      const spotifyTokens = JSON.stringify({
        accessToken: 'test-spotify-token',
        refreshToken: 'test-spotify-refresh',
      });
      const youtubeTokens = createMockYouTubeToken();

      const response = await request(app)
        .get('/auth/spotify/playlists')
        .set('Cookie', [`spotify_tokens=${spotifyTokens}`, `youtube_tokens=${youtubeTokens}`])
        .expect(200);

      // One of the two matches on YouTube, so the count shows 1 synced
      // ("Synced Playlist" matches "Synced Playlist (from Spotify)")
      expect(response.text).toContain('2 playlists · 1 synced');
    });

    it('should include "your playlists only" when ownOnly=true and YouTube not connected', async () => {
      // Mock Spotify API
      mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1234567890123456789012', 'My Playlist', 10),
      ]);

      // Set only Spotify cookie
      const spotifyTokens = JSON.stringify({
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
      });

      const response = await request(app)
        .get('/auth/spotify/playlists')
        .query({ ownOnly: 'true' })
        .set('Cookie', [`spotify_tokens=${spotifyTokens}`])
        .expect(200);

      // Should NOT show the "connect YouTube" message (removed per user feedback)
      expect(response.text).not.toContain('connect YouTube to check sync status');
    });
  });

  describe('Playlist Expand Functionality', () => {
    it('should show expand button when YouTube is not connected', async () => {
      // Mock Spotify API
      mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1234567890123456789012', 'Test Playlist', 10),
      ]);

      // Set only Spotify cookie (no YouTube)
      const spotifyTokens = JSON.stringify({
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
      });

      const response = await request(app)
        .get('/auth/spotify/playlists')
        .set('Cookie', [`spotify_tokens=${spotifyTokens}`])
        .expect(200);

      // Should show expand functionality
      expect(response.text).toContain('expand-1234567890123456789012');
      expect(response.text).toContain('playlist-expand-toggle');
      expect(response.text).toContain('playlist-expand-area');
      expect(response.text).toContain('expand-indicator');
    });

    it('should show expand button for unsynced playlists when YouTube is connected', async () => {
      // Mock Spotify API
      mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1234567890123456789012', 'Unsynced Playlist', 10),
      ]);

      // Set both Spotify and YouTube cookies
      const spotifyTokens = JSON.stringify({
        accessToken: 'test-spotify-token',
        refreshToken: 'test-spotify-refresh',
      });
      const youtubeTokens = createMockYouTubeToken();

      const response = await request(app)
        .get('/auth/spotify/playlists')
        .set('Cookie', [`spotify_tokens=${spotifyTokens}`, `youtube_tokens=${youtubeTokens}`])
        .expect(200);

      // Should show expand functionality even for unsynced playlist
      expect(response.text).toContain('expand-1234567890123456789012');
      expect(response.text).toContain('playlist-expand-toggle');
      expect(response.text).toContain('playlist-expand-area');
      expect(response.text).toContain('expand-indicator');
    });

    it('should show expand button for synced playlists when YouTube is connected', async () => {
      // Mock Spotify API
      mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1234567890123456789012', 'Synced Playlist', 10),
      ]);

      // Mock YouTube API to return a synced playlist
      ytClient.client.playlists.list = vi.fn(() =>
        Promise.resolve({
          data: {
            items: [
              {
                id: 'yt_playlist_id',
                snippet: {
                  title: 'Synced Playlist (from Spotify)',
                },
              },
            ],
          },
        }),
      ) as any;

      // Set both cookies
      const spotifyTokens = JSON.stringify({
        accessToken: 'test-spotify-token',
        refreshToken: 'test-spotify-refresh',
      });
      const youtubeTokens = createMockYouTubeToken();

      const response = await request(app)
        .get('/auth/spotify/playlists')
        .set('Cookie', [`spotify_tokens=${spotifyTokens}`, `youtube_tokens=${youtubeTokens}`])
        .expect(200);

      // Should show expand functionality for synced playlist
      expect(response.text).toContain('expand-1234567890123456789012');
      expect(response.text).toContain('playlist-expand-toggle');
      expect(response.text).toContain('playlist-expand-area');
      expect(response.text).toContain('expand-indicator');
    });
  });

  describe('YouTube Quota Error Handling During Playlist Fetch', () => {
    it('should redirect with error modal when YouTube quota is exceeded during playlist fetch', async () => {
      // Mock Spotify API to return playlists
      mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1234567890123456789012', 'Test Playlist', 10),
      ]);

      // Mock YouTube API to fail with 403 quota exceeded
      ytClient.client.playlists.list = vi.fn(() =>
        Promise.reject(
          new YoutubeApiError(
            'The request cannot be completed because you have exceeded your quota.',
            403,
            'quotaExceeded',
          ),
        ),
      );

      // Set both Spotify and YouTube tokens
      const spotifyTokens = JSON.stringify({
        accessToken: 'test-spotify-token',
        refreshToken: 'test-spotify-refresh',
      });
      const youtubeTokens = createMockYouTubeToken();

      const response = await request(app)
        .get('/auth/spotify/playlists')
        .set('Cookie', [`spotify_tokens=${spotifyTokens}`, `youtube_tokens=${youtubeTokens}`]);

      // htmx-loaded route: use HX-Redirect (real navigation to the quota modal),
      // not a 302 that would get swapped into the container.
      expect(response.status).toBe(403);
      expect(response.headers['hx-redirect']).toMatch(/^\/\?error=youtube&reason=quota_exceeded/);
    });

    it('should open circuit breaker when YouTube quota is exceeded during playlist fetch', async () => {
      // Mock Spotify API
      mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
      mockedGetUserPlaylists.mockResolvedValue([
        playlistSummary('1234567890123456789012', 'Test Playlist', 10),
      ]);

      // Mock YouTube API to fail with 403
      ytClient.client.playlists.list = vi.fn(() =>
        Promise.reject(new YoutubeApiError('Quota exceeded', 403, 'quotaExceeded')),
      );

      // Import circuit breaker to check its state
      const { youtubeCircuitBreaker } = await import('../../src/lib/circuitBreaker');
      youtubeCircuitBreaker.close(); // Start fresh

      const spotifyTokens = JSON.stringify({
        accessToken: 'test-spotify-token',
        refreshToken: 'test-spotify-refresh',
      });
      const youtubeTokens = createMockYouTubeToken();

      const response = await request(app)
        .get('/auth/spotify/playlists')
        .set('Cookie', [`spotify_tokens=${spotifyTokens}`, `youtube_tokens=${youtubeTokens}`]);

      // Should signal the client to navigate to the quota modal via HX-Redirect
      expect(response.status).toBe(403);
      expect(response.headers['hx-redirect']).toMatch(/^\/\?error=youtube&reason=quota_exceeded/);

      // Circuit breaker should now be open
      expect(youtubeCircuitBreaker.isOpen()).toBe(true);
    });
  });
});

/**
 * What the playlist list does when Spotify says no.
 *
 * Each of these is a different problem with a different answer, and telling them apart is the whole
 * point: a rate limit is not a dead token, and a Spotify outage is not the user's fault. Reporting
 * any of them as "reconnect" sends someone off to re-authorise an account that is working - and the
 * 429 is not hypothetical, it took this app off the air for twelve hours.
 */
describe('GET /auth/spotify/playlists: when Spotify says no', () => {
  const spotifyCookie = `spotify_tokens=${JSON.stringify({
    accessToken: 'sp',
    refreshToken: 're',
  })}`;

  const fetchWith = async (error: unknown) => {
    mockedGetCurrentUser.mockResolvedValue({ id: 'test-user', displayName: null });
    mockedGetUserPlaylists.mockRejectedValue(error);
    return request(app).get('/auth/spotify/playlists').set('Cookie', [spotifyCookie]);
  };

  // The template links the login, so rendering it without a loginUrl throws and express turns that
  // into a 500 - an expired session reported as "something went wrong", with no way back. This
  // asked for a 401 and got a 500 the first time it ran.
  it('asks the user to reconnect when the token is gone, and says where', async () => {
    const response = await fetchWith(new Error('SPOTIFY_AUTH_REQUIRED'));

    expect(response.status).toBe(401);
    expect(response.text).toContain('session has expired');
    expect(response.text).toContain('/auth/spotify/login');
  });

  // Spotify's problem, not the user's: 503 says "come back", which a 401 does not.
  it.each([[502], [503]])('reports a Spotify outage (%i) as temporary', async (status) => {
    const { SpotifyApiError } = await import('@/spotify/client');

    const response = await fetchWith(new SpotifyApiError('down', status));

    expect(response.status).toBe(503);
    expect(response.text).toContain('temporarily unavailable');
  });

  it('reports a rate limit as a rate limit', async () => {
    const { SpotifyApiError } = await import('@/spotify/client');

    const response = await fetchWith(new SpotifyApiError('slow down', 429));

    expect(response.status).toBe(429);
    expect(response.text).toContain('Too many requests');
  });

  // Retry-After is the only thing that turns "try later" into something actionable.
  it.each([
    [30, 'about 30 seconds'],
    [1, 'about 1 second'],
    [90, 'about 2 minutes'],
    [3600, 'about 1 hour'],
    [43200, 'about 12 hours'],
  ])(
    'tells the user how long to wait when Spotify says %i seconds',
    async (retryAfter, expected) => {
      const { SpotifyApiError } = await import('@/spotify/client');

      const response = await fetchWith(
        new SpotifyApiError('slow down', 429, undefined, retryAfter),
      );

      expect(response.text).toContain(expected);
    },
  );

  it('says to wait a moment when Spotify does not say how long', async () => {
    const { SpotifyApiError } = await import('@/spotify/client');

    const response = await fetchWith(new SpotifyApiError('slow down', 429));

    expect(response.text).toContain('wait a moment');
  });

  // Anything else is a bug here, and must not be dressed up as one of Spotify's.
  it('reports anything else as an error of ours', async () => {
    const response = await fetchWith(new Error('something unexpected'));

    expect(response.status).toBe(500);
    expect(response.text).toContain('Error fetching playlists');
  });

  it.each([[400], [404], [418]])(
    'does not mistake a %i for an outage or a rate limit',
    async (status) => {
      const { SpotifyApiError } = await import('@/spotify/client');

      const response = await fetchWith(new SpotifyApiError('nope', status));

      expect(response.status).toBe(500);
    },
  );
});
