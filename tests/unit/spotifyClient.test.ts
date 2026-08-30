/**
 * Unit tests for the hand-written Spotify client: request construction (auth
 * headers, body encoding, URLs), response -> typed domain mapping, the Dev Mode
 * `items`/`tracks` count fallback, optional refresh_token handling, pagination,
 * and HTTP-status -> SpotifyApiError mapping.
 *
 * fetch is mocked, so these run every cycle. The mock response shapes here are
 * the contract the gated live harness (tests/live/spotify.live.test.ts) verifies
 * against the real API.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  getAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getCurrentUser,
  getUserPlaylists,
  SpotifyIncompleteResponseError,
  isSpotifyUpstreamFailure,
  getPlaylist,
  SpotifyApiError,
} from '../../src/spotify/client';
import { Logger } from '../../src/lib/logger';

// The client uses Node's global fetch; stub it (see beforeEach).
const mockFetch = vi.fn();

// Minimal node-fetch Response stand-ins.
const okJson = (data: unknown) =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => data,
    text: async () => JSON.stringify(data),
  }) as never;
const errResp = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({
    ok: false,
    status,
    statusText: 'Error',
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as never;

const lastCall = () =>
  mockFetch.mock.calls.at(-1) as [
    string,
    { method?: string; headers?: Record<string, string>; body?: string },
  ];
const EXPECTED_BASIC = `Basic ${Buffer.from('cid:secret').toString('base64')}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  process.env.SPOTIFY_CLIENT_ID = 'cid';
  process.env.SPOTIFY_CLIENT_SECRET = 'secret';
  process.env.SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:3000/auth/spotify/callback';
});

describe('getAuthorizeUrl', () => {
  it('builds the authorize URL with client_id, code response type, scopes and state', () => {
    const url = new URL(
      getAuthorizeUrl(['playlist-read-private', 'playlist-read-collaborative'], 'st8'),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:3000/auth/spotify/callback',
    );
    expect(url.searchParams.get('state')).toBe('st8');
    expect(url.searchParams.get('scope')).toBe('playlist-read-private playlist-read-collaborative');
    expect(url.searchParams.get('show_dialog')).toBeNull();
  });

  it('adds show_dialog=true when requested', () => {
    const url = new URL(getAuthorizeUrl([], 's', true));
    expect(url.searchParams.get('show_dialog')).toBe('true');
  });
});

describe('exchangeCodeForTokens', () => {
  it('POSTs form-urlencoded with Basic auth and maps the token response', async () => {
    mockFetch.mockResolvedValue(
      okJson({
        access_token: 'AT',
        token_type: 'Bearer',
        scope: 'playlist-read-private',
        expires_in: 3600,
        refresh_token: 'RT',
      }),
    );

    const tokens = await exchangeCodeForTokens('auth-code');

    const [url, opts] = lastCall();
    expect(url).toBe('https://accounts.spotify.com/api/token');
    expect(opts.method).toBe('POST');
    expect(opts.headers?.Authorization).toBe(EXPECTED_BASIC);
    expect(opts.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(opts.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:3000/auth/spotify/callback');

    expect(tokens).toEqual({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresIn: 3600,
      scope: 'playlist-read-private',
      tokenType: 'Bearer',
    });
  });

  it('throws SpotifyApiError with the account error_description', async () => {
    mockFetch.mockResolvedValue(
      errResp(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' }),
    );
    await expect(exchangeCodeForTokens('bad')).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Invalid authorization code'),
    });
  });
});

describe('refreshAccessToken', () => {
  it('sends grant_type=refresh_token and the refresh token', async () => {
    mockFetch.mockResolvedValue(
      okJson({ access_token: 'AT2', token_type: 'Bearer', expires_in: 3600, scope: '' }),
    );
    await refreshAccessToken('stored-rt');
    const body = new URLSearchParams(lastCall()[1].body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('stored-rt');
  });

  it('leaves refreshToken undefined when the response omits it (caller reuses old)', async () => {
    mockFetch.mockResolvedValue(
      okJson({ access_token: 'AT2', token_type: 'Bearer', expires_in: 3600, scope: '' }),
    );
    const tokens = await refreshAccessToken('stored-rt');
    expect(tokens.accessToken).toBe('AT2');
    expect(tokens.refreshToken).toBeUndefined();
  });

  it('returns the new refresh token when the response includes one', async () => {
    mockFetch.mockResolvedValue(
      okJson({
        access_token: 'AT2',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: '',
        refresh_token: 'RT2',
      }),
    );
    const tokens = await refreshAccessToken('stored-rt');
    expect(tokens.refreshToken).toBe('RT2');
  });
});

describe('getCurrentUser', () => {
  it('sends a Bearer token and maps id + display name', async () => {
    mockFetch.mockResolvedValue(okJson({ id: 'user42', display_name: 'Jane' }));
    const user = await getCurrentUser('AT');
    expect(lastCall()[0]).toBe('https://api.spotify.com/v1/me');
    expect(lastCall()[1].headers?.Authorization).toBe('Bearer AT');
    expect(user).toEqual({ id: 'user42', displayName: 'Jane' });
  });

  it('maps an absent display_name to null', async () => {
    mockFetch.mockResolvedValue(okJson({ id: 'user42' }));
    expect((await getCurrentUser('AT')).displayName).toBeNull();
  });
});

/**
 * A dropped playlist is invisible: the list just comes back shorter, or empty, and looks like the
 * truth. These pin the logging that tells an empty account apart from a response that lost them.
 */
describe('getUserPlaylists: when playlists go missing', () => {
  it('reports what it dropped and what Spotify said it held', async () => {
    const warn = vi.spyOn(Logger, 'warn');
    mockFetch.mockResolvedValue(
      okJson({
        next: null,
        total: 3,
        items: [{ id: 'p1', name: 'Kept', owner: { id: 'me' } }, null],
      }),
    );

    await getUserPlaylists('AT');

    expect(warn).toHaveBeenCalledWith('Spotify returned null playlist entries', {
      offset: 0,
      reportedTotal: 3,
      returned: 2,
      usable: 1,
    });
  });

  // The reported failure: every entry null, so the page filters to nothing and the user saw an
  // empty library with no error anywhere - which reads as an emptied account, not a bad response.
  it('fails rather than reporting an empty account when Spotify hands back none', async () => {
    const warn = vi.spyOn(Logger, 'warn');
    mockFetch.mockResolvedValue(okJson({ next: null, total: 47, items: [null, null] }));

    await expect(getUserPlaylists('AT')).rejects.toBeInstanceOf(SpotifyIncompleteResponseError);
    expect(warn).toHaveBeenCalledWith('Spotify reports playlists but returned none', {
      reportedTotal: 47,
    });
  });

  it('carries the total it was promised, so the caller can say how many are missing', async () => {
    mockFetch.mockResolvedValue(okJson({ next: null, total: 63, items: [] }));

    await expect(getUserPlaylists('AT')).rejects.toMatchObject({ reportedTotal: 63 });
  });

  it('returns an empty list, quietly, for an account that genuinely has none', async () => {
    // The distinction the error exists for: no total means nothing is missing, so this is a fact
    // about the account rather than a failure, and must neither warn nor throw.
    const warn = vi.spyOn(Logger, 'warn');
    mockFetch.mockResolvedValue(okJson({ next: null, total: 0, items: [] }));

    await expect(getUserPlaylists('AT')).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet when every playlist comes back intact', async () => {
    const warn = vi.spyOn(Logger, 'warn');
    mockFetch.mockResolvedValue(
      okJson({ next: null, total: 1, items: [{ id: 'p1', name: 'Fine', owner: { id: 'me' } }] }),
    );

    await getUserPlaylists('AT');

    expect(warn).not.toHaveBeenCalled();
  });

  it('records the total Spotify reported alongside the count it kept', async () => {
    const debug = vi.spyOn(Logger, 'debug');
    mockFetch.mockResolvedValue(
      okJson({ next: null, total: 9, items: [{ id: 'p1', name: 'One', owner: { id: 'me' } }] }),
    );

    await getUserPlaylists('AT');

    expect(debug).toHaveBeenCalledWith('Fetched Spotify user playlists', {
      count: 1,
      reportedTotal: 9,
    });
  });
});

describe('getUserPlaylists', () => {
  it('keeps paginating past a page whose entries are all null/unavailable', async () => {
    // A full page of deleted/unavailable playlists filters to empty. Terminating on that filtered
    // length silently truncated the list, dropping every playlist on later pages.
    mockFetch
      .mockResolvedValueOnce(
        okJson({ next: 'https://api.spotify.com/v1/me/playlists?offset=50', items: [null, null] }),
      )
      .mockResolvedValueOnce(
        okJson({ next: null, items: [{ id: 'p9', name: 'Survivor', owner: { id: 'me' } }] }),
      );

    const playlists = await getUserPlaylists('AT');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(playlists.map((p) => p.id)).toEqual(['p9']);
  });

  it('stops when a page is genuinely empty even if next is set', async () => {
    mockFetch.mockResolvedValue(
      okJson({ next: 'https://api.spotify.com/v1/me/playlists?offset=50', items: [] }),
    );

    await getUserPlaylists('AT');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reads the count from the new items.total or legacy tracks.total, drops nulls', async () => {
    mockFetch.mockResolvedValue(
      okJson({
        next: null,
        items: [
          {
            id: 'p1',
            name: 'New mode',
            owner: { id: 'me' },
            items: { total: 12 },
            external_urls: { spotify: 'u1' },
          },
          { id: 'p2', name: 'Legacy mode', owner: { id: 'other' }, tracks: { total: 7 } },
          null,
          { id: 'p3', name: 'No count', owner: { id: 'me' } },
        ],
      }),
    );

    const playlists = await getUserPlaylists('AT');

    expect(playlists).toEqual([
      { id: 'p1', name: 'New mode', ownerId: 'me', trackTotal: 12, spotifyUrl: 'u1' },
      {
        id: 'p2',
        name: 'Legacy mode',
        ownerId: 'other',
        trackTotal: 7,
        spotifyUrl: 'https://open.spotify.com/playlist/p2',
      },
      {
        id: 'p3',
        name: 'No count',
        ownerId: 'me',
        trackTotal: null,
        spotifyUrl: 'https://open.spotify.com/playlist/p3',
      },
    ]);
  });

  it('paginates while next is present', async () => {
    mockFetch
      .mockResolvedValueOnce(
        okJson({ next: 'page2', items: [{ id: 'p1', name: 'A', owner: { id: 'me' } }] }),
      )
      .mockResolvedValueOnce(
        okJson({ next: null, items: [{ id: 'p2', name: 'B', owner: { id: 'me' } }] }),
      );

    const playlists = await getUserPlaylists('AT');

    expect(playlists.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0]![0]).toContain('offset=0');
    expect(mockFetch.mock.calls[1]![0]).toContain('offset=50');
  });
});

describe('getPlaylist', () => {
  it('maps a single playlist, preferring items.total over tracks.total', async () => {
    mockFetch.mockResolvedValue(
      okJson({
        id: 'pid',
        name: 'My List',
        owner: { id: 'me' },
        items: { total: 30 },
        tracks: { total: 99 },
        external_urls: { spotify: 'spotify:url' },
      }),
    );
    const playlist = await getPlaylist('AT', 'pid');
    expect(lastCall()[0]).toBe('https://api.spotify.com/v1/playlists/pid');
    expect(playlist).toEqual({
      id: 'pid',
      name: 'My List',
      ownerId: 'me',
      trackTotal: 30,
      spotifyUrl: 'spotify:url',
    });
  });

  it('falls back to a constructed URL and null count when fields are absent', async () => {
    mockFetch.mockResolvedValue(okJson({ id: 'pid', name: 'Bare' }));
    const playlist = await getPlaylist('AT', 'pid');
    expect(playlist).toEqual({
      id: 'pid',
      name: 'Bare',
      ownerId: null,
      trackTotal: null,
      spotifyUrl: 'https://open.spotify.com/playlist/pid',
    });
  });
});

describe('error mapping', () => {
  it('maps a 401 to SpotifyApiError with status 401', async () => {
    mockFetch.mockResolvedValue(
      errResp(401, { error: { status: 401, message: 'The access token expired' } }),
    );
    await expect(getCurrentUser('AT')).rejects.toMatchObject({
      status: 401,
      name: 'SpotifyApiError',
    });
  });

  it('maps a 429 and preserves the Web API error message', async () => {
    mockFetch.mockResolvedValue(errResp(429, { error: { status: 429, message: 'rate limited' } }));
    await expect(getPlaylist('AT', 'p')).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining('rate limited'),
    });
  });

  it('captures the Retry-After header (seconds) on a 429', async () => {
    mockFetch.mockResolvedValue(
      errResp(429, { error: { status: 429, message: 'rate limited' } }, { 'retry-after': '43200' }),
    );
    const err = await getUserPlaylists('AT').catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyApiError);
    expect(err.retryAfter).toBe(43200);
  });

  it('parses a Retry-After HTTP-date into seconds from now', async () => {
    const tenMinutes = new Date(Date.now() + 600_000).toUTCString();
    mockFetch.mockResolvedValue(errResp(503, 'unavailable', { 'retry-after': tenMinutes }));
    const err = await getCurrentUser('AT').catch((e) => e);
    // Allow a small delta for clock/rounding between building the date and parsing it.
    expect(err.retryAfter).toBeGreaterThan(590);
    expect(err.retryAfter).toBeLessThanOrEqual(600);
  });

  it('leaves retryAfter undefined when the header is absent', async () => {
    mockFetch.mockResolvedValue(errResp(429, { error: { status: 429, message: 'rate limited' } }));
    const err = await getPlaylist('AT', 'p').catch((e) => e);
    expect(err.retryAfter).toBeUndefined();
  });

  it('SpotifyApiError is the thrown type with the raw body attached', async () => {
    mockFetch.mockResolvedValue(errResp(403, 'forbidden text'));
    const err = await getPlaylist('AT', 'p').catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyApiError);
    expect(err.status).toBe(403);
    expect(err.body).toBe('forbidden text');
  });
});

describe('isSpotifyUpstreamFailure', () => {
  // RFC 6749 §5.2: these mean the authorization server is overloaded or down. Read as auth
  // failures they send the user to re-authorize an account that is fine, during the one window
  // where re-authorizing cannot work either.
  it.each([
    ['a 503', new SpotifyApiError('temporarily_unavailable', 503)],
    ['a 500', new SpotifyApiError('boom', 500)],
    ['a 502', new SpotifyApiError('bad gateway', 502)],
  ])('treats %s as Spotify being down', (_label, error) => {
    expect(isSpotifyUpstreamFailure(error)).toBe(true);
  });

  it.each([
    ['temporarily_unavailable', '{"error":"temporarily_unavailable"}'],
    ['server_error', '{"error":"server_error"}'],
  ])('reads %s from the body even on a 4xx', (_label, body) => {
    // Spotify has answered 400 with an outage code; the body is the authoritative signal.
    expect(isSpotifyUpstreamFailure(new SpotifyApiError('x', 400, body))).toBe(true);
  });

  it.each([
    [
      'a dead refresh token',
      new SpotifyApiError('invalid_grant', 400, '{"error":"invalid_grant"}'),
    ],
    ['a rejected token', new SpotifyApiError('unauthorized', 401)],
    ['a non-Spotify error', new Error('socket hang up')],
  ])('does not mistake %s for an outage', (_label, error) => {
    expect(isSpotifyUpstreamFailure(error)).toBe(false);
  });

  it('does not match an error code that merely contains one of the words', () => {
    // Substring matching would classify "not_temporarily_unavailable_at_all" as an outage.
    expect(
      isSpotifyUpstreamFailure(new SpotifyApiError('x', 400, '{"error":"invalid_grant_error"}')),
    ).toBe(false);
  });
});
