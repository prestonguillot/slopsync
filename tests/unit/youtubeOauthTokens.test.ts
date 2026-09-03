/**
 * Unit tests for the YouTube OAuth token responses (src/youtube/client.ts).
 *
 * These coerced blindly: String(data.access_token) turned a missing field into the literal string
 * "undefined" (stored as a plausible-looking token, failing later as a confusing 401), and
 * Number(data.expires_in ?? 0) made expiry_date === Date.now() so the token was born expired.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  exchangeYoutubeCode,
  refreshYoutubeAccessToken,
  YoutubeApiError,
} from '../../src/youtube/client';

const mockFetch = vi.fn();
const okJson = (data: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(data) }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  process.env.YOUTUBE_CLIENT_ID = 'cid';
  process.env.YOUTUBE_CLIENT_SECRET = 'secret';
  process.env.YOUTUBE_REDIRECT_URI = 'http://127.0.0.1:3000/auth/youtube/callback';
});

/** The form body of the most recent fetch, parsed back into fields. */
const sentForm = () => new URLSearchParams(mockFetch.mock.calls.at(-1)![1].body as string);
/** The URL of the most recent fetch. */
const sentUrl = () => mockFetch.mock.calls.at(-1)![0] as string;

/**
 * What goes TO Google, which the response-mapping tests below never look at. grant_type is the
 * field that says whether this is a code exchange or a refresh - blank it and both calls malform
 * into an OAuth error the user can do nothing about, and no test of the mapping would notice.
 */
describe('the OAuth request each call sends', () => {
  beforeEach(() => mockFetch.mockResolvedValue(okJson({ access_token: 'AT', expires_in: 3600 })));

  it('exchanges a code as grant_type=authorization_code, with the code and redirect uri', async () => {
    await exchangeYoutubeCode('the-code');

    const form = sentForm();
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('redirect_uri')).toBe('http://127.0.0.1:3000/auth/youtube/callback');
  });

  it('refreshes as grant_type=refresh_token, with the refresh token', async () => {
    await refreshYoutubeAccessToken('the-refresh-token');

    const form = sentForm();
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('the-refresh-token');
  });

  it('sends the client credentials on both', async () => {
    await exchangeYoutubeCode('c');
    expect(sentForm().get('client_id')).toBe('cid');
    expect(sentForm().get('client_secret')).toBe('secret');

    await refreshYoutubeAccessToken('r');
    expect(sentForm().get('client_id')).toBe('cid');
    expect(sentForm().get('client_secret')).toBe('secret');
  });

  it('posts to the Google OAuth token endpoint', async () => {
    await exchangeYoutubeCode('c');

    expect(sentUrl()).toBe('https://oauth2.googleapis.com/token');
    expect(mockFetch.mock.calls.at(-1)![1].method).toBe('POST');
  });
});

describe('exchangeYoutubeCode', () => {
  it('maps a well-formed token response', async () => {
    mockFetch.mockResolvedValue(
      okJson({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 's' }),
    );

    const tokens = await exchangeYoutubeCode('code');

    expect(tokens.access_token).toBe('AT');
    expect(tokens.refresh_token).toBe('RT');
    expect(tokens.expiry_date).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it('rejects a response with no access_token instead of storing "undefined"', async () => {
    mockFetch.mockResolvedValue(okJson({ expires_in: 3600 }));

    await expect(exchangeYoutubeCode('code')).rejects.toBeInstanceOf(YoutubeApiError);
  });

  it('rejects a non-string access_token', async () => {
    mockFetch.mockResolvedValue(okJson({ access_token: 12345, expires_in: 3600 }));

    await expect(exchangeYoutubeCode('code')).rejects.toBeInstanceOf(YoutubeApiError);
  });

  it('assumes the default lifetime when expires_in is missing, rather than expiring instantly', async () => {
    mockFetch.mockResolvedValue(okJson({ access_token: 'AT' }));

    const tokens = await exchangeYoutubeCode('code');

    // Previously expiry_date === Date.now(): born expired, so every request tried to refresh.
    expect(tokens.expiry_date).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it('assumes the default lifetime when expires_in is garbage', async () => {
    mockFetch.mockResolvedValue(okJson({ access_token: 'AT', expires_in: 'soon' }));

    const tokens = await exchangeYoutubeCode('code');

    expect(tokens.expiry_date).toBeGreaterThan(Date.now() + 3_500_000);
  });

  // Zero and negative are not garbage - they parse as finite numbers - but a token that expires
  // now or in the past is born dead. Both take the default rather than the number Google sent.
  it.each([[0], [-100]])('assumes the default when expires_in is %i', async (expiresIn) => {
    mockFetch.mockResolvedValue(okJson({ access_token: 'AT', expires_in: expiresIn }));

    const tokens = await exchangeYoutubeCode('code');

    expect(tokens.expiry_date).toBeGreaterThan(Date.now() + 3_500_000);
  });

  // token_type defaults to Bearer and scope to empty when Google omits them - the cookie schema
  // requires both non-empty, so a token that dropped them would be rejected at storage rather than
  // stored and mysteriously unusable.
  it('defaults token_type to Bearer and scope to empty when they are absent', async () => {
    mockFetch.mockResolvedValue(okJson({ access_token: 'AT', expires_in: 3600 }));

    const tokens = await exchangeYoutubeCode('code');

    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.scope).toBe('');
  });

  it('keeps the token_type and scope Google did send', async () => {
    mockFetch.mockResolvedValue(
      okJson({ access_token: 'AT', expires_in: 3600, token_type: 'MAC', scope: 'a b' }),
    );

    const tokens = await exchangeYoutubeCode('code');

    expect(tokens.token_type).toBe('MAC');
    expect(tokens.scope).toBe('a b');
  });
});

describe('refreshYoutubeAccessToken', () => {
  it('rejects a refresh response with no access_token', async () => {
    mockFetch.mockResolvedValue(okJson({ expires_in: 3600 }));

    await expect(refreshYoutubeAccessToken('RT')).rejects.toBeInstanceOf(YoutubeApiError);
  });

  it('assumes the default lifetime when a refresh omits expires_in', async () => {
    mockFetch.mockResolvedValue(okJson({ access_token: 'AT2' }));

    const tokens = await refreshYoutubeAccessToken('RT');

    expect(tokens.access_token).toBe('AT2');
    expect(tokens.expiry_date).toBeGreaterThan(Date.now() + 3_500_000);
  });

  // Same defaults as the exchange path: a refresh that drops token_type/scope must still produce a
  // token the cookie schema will accept, not one rejected at storage.
  it('defaults token_type and scope on a refresh too', async () => {
    mockFetch.mockResolvedValue(okJson({ access_token: 'AT2', expires_in: 3600 }));

    const tokens = await refreshYoutubeAccessToken('RT');

    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.scope).toBe('');
  });
});

/**
 * The authorize URL. Every parameter here is load-bearing, not decoration:
 *
 * - `access_type=offline` alone gets a refresh_token on the FIRST consent and none on reconnect,
 *   leaving the access token to die at its 1h expiry with nothing to refresh it. `prompt=consent`
 *   is what makes Google re-issue one every time.
 * - `prompt=select_account` keeps the account off the browser's existing session. Resolved
 *   implicitly, a profile signed in to an account that cannot authorize the app fails generically
 *   from a URL that is otherwise perfectly valid.
 */
describe('getYoutubeAuthUrl', () => {
  const params = (url: string) => new URL(url).searchParams;

  it('asks for offline access and forces the consent screen every time', async () => {
    const { getYoutubeAuthUrl } = await import('../../src/youtube/client');
    const p = params(getYoutubeAuthUrl(['https://www.googleapis.com/auth/youtube']));

    expect(p.get('access_type')).toBe('offline');
    // Space-delimited, so assert membership rather than the whole string: what matters is that
    // both prompts are asked for, not the order Google happens to be sent them in.
    expect(p.get('prompt')?.split(' ')).toEqual(
      expect.arrayContaining(['select_account', 'consent']),
    );
    expect(p.get('response_type')).toBe('code');
  });

  // The account is never left to the browser's existing session to resolve: a profile signed in to
  // an account that cannot authorize the app fails there, generically, from a valid URL.
  it('makes the user pick the account rather than inheriting the browser session', async () => {
    const { getYoutubeAuthUrl } = await import('../../src/youtube/client');
    const p = params(getYoutubeAuthUrl(['https://www.googleapis.com/auth/youtube']));

    expect(p.get('prompt')?.split(' ')).toContain('select_account');
  });

  // Scopes are space-separated in one param; join them with anything else and Google reads one
  // unknown scope and refuses the lot.
  it('space-joins the scopes', async () => {
    const { getYoutubeAuthUrl } = await import('../../src/youtube/client');
    const p = params(getYoutubeAuthUrl(['scope.a', 'scope.b']));

    expect(p.get('scope')).toBe('scope.a scope.b');
  });

  it('includes the state when given one, and omits it when not', async () => {
    const { getYoutubeAuthUrl } = await import('../../src/youtube/client');

    expect(params(getYoutubeAuthUrl(['s'], 'the-state')).get('state')).toBe('the-state');
    expect(params(getYoutubeAuthUrl(['s'])).has('state')).toBe(false);
  });

  it('carries the configured redirect uri', async () => {
    const { getYoutubeAuthUrl } = await import('../../src/youtube/client');

    expect(params(getYoutubeAuthUrl(['s'])).get('redirect_uri')).toBe(
      'http://127.0.0.1:3000/auth/youtube/callback',
    );
  });
});

/**
 * The failure paths the mapping tests above never took: a token endpoint that answers with an
 * error, credentials that are not configured, an access_token that is empty rather than absent, and
 * the warning emitted when a lifetime has to be assumed.
 */
describe('the OAuth failure paths', () => {
  beforeEach(() => mockFetch.mockResolvedValue(okJson({ access_token: 'AT', expires_in: 3600 })));

  it('surfaces a failed token request as a YoutubeApiError with the error description', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code' }),
    } as never);

    await expect(exchangeYoutubeCode('code')).rejects.toMatchObject({
      code: 400,
      message: expect.stringContaining('Bad code'),
    });
  });

  it('falls back to the status when the OAuth error body is not JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '<html>gateway</html>',
    } as never);

    await expect(refreshYoutubeAccessToken('RT')).rejects.toMatchObject({ code: 503 });
  });

  it('throws when the YouTube client credentials are not configured', async () => {
    delete process.env.YOUTUBE_CLIENT_SECRET;

    await expect(exchangeYoutubeCode('code')).rejects.toThrow(/Missing YOUTUBE/);
  });

  it('rejects an EMPTY access_token, naming the operation and the reason', async () => {
    mockFetch.mockResolvedValue(okJson({ access_token: '', expires_in: 3600 }));

    await expect(exchangeYoutubeCode('code')).rejects.toMatchObject({
      code: 502,
      reason: 'invalidTokenResponse',
      message: expect.stringContaining('code exchange'),
    });
  });

  it('warns when it has to assume the default token lifetime', async () => {
    const { Logger } = await import('../../src/lib/logger');
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    mockFetch.mockResolvedValue(okJson({ access_token: 'AT' })); // no expires_in

    await exchangeYoutubeCode('code');

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no usable expires_in'),
      expect.objectContaining({ assumedSeconds: 3600 }),
    );
    warn.mockRestore();
  });
});
