/**
 * Tests for src/spotify/auth.ts - the single Spotify token validate/refresh/rewrite path.
 *
 * Nothing tested this directly either (see youtubeAuth.test.ts, which mirrors it). The shape is the
 * same and so is the distinction that matters: a 401 means the access token expired and is fixed by
 * refreshing, while anything else is about Spotify and must not be reported as expired - that sends
 * the user off to reconnect an account that is fine.
 *
 * The one real difference from YouTube: Spotify MAY return a new refresh token on a refresh, and may
 * not. Google never does.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ getCurrentUser: vi.fn(), refresh: vi.fn() }));

vi.mock('../../src/spotify/client', async (importActual) => ({
  ...(await importActual<typeof import('../../src/spotify/client')>()),
  getCurrentUser: h.getCurrentUser,
  refreshAccessToken: h.refresh,
}));

import { resolveSpotifyToken, ensureValidSpotifyToken } from '../../src/spotify/auth';
import { SpotifyApiError } from '../../src/spotify/client';
import type { Response, Request } from 'express';

const TOKENS = { accessToken: 'sp-access', refreshToken: 'sp-refresh' };

const res = () => ({ cookie: vi.fn(), clearCookie: vi.fn() }) as unknown as Response;
const req = (cookie?: string) =>
  ({ cookies: cookie === undefined ? {} : { spotify_tokens: cookie } }) as unknown as Request;
const storedCookie = (response: Response) =>
  JSON.parse(String(vi.mocked(response.cookie).mock.calls[0]?.[1]));

beforeEach(() => {
  vi.clearAllMocks();
  h.getCurrentUser.mockResolvedValue({ id: 'user', displayName: null });
});

describe('resolveSpotifyToken', () => {
  it('reports a working token as valid, without refreshing it', async () => {
    const outcome = await resolveSpotifyToken(TOKENS, res());

    expect(outcome).toEqual({ status: 'valid', accessToken: 'sp-access' });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  describe('when the access token has expired (401)', () => {
    beforeEach(() => {
      h.getCurrentUser.mockRejectedValue(new SpotifyApiError('expired', 401));
    });

    it('refreshes it and reports the new one', async () => {
      h.refresh.mockResolvedValue({ accessToken: 'fresh-access' });

      const outcome = await resolveSpotifyToken(TOKENS, res());

      expect(h.refresh).toHaveBeenCalledWith('sp-refresh');
      expect(outcome).toEqual({ status: 'refreshed', accessToken: 'fresh-access' });
    });

    it('writes the refreshed token back to the cookie', async () => {
      h.refresh.mockResolvedValue({ accessToken: 'fresh-access' });
      const response = res();

      await resolveSpotifyToken(TOKENS, response);

      expect(vi.mocked(response.cookie).mock.calls[0]?.[0]).toBe('spotify_tokens');
      expect(storedCookie(response).accessToken).toBe('fresh-access');
    });

    // Spotify may or may not issue a new refresh token. Dropping the old one when it does not is
    // dropping the connection.
    it('keeps the stored refresh token when the response omits one', async () => {
      h.refresh.mockResolvedValue({ accessToken: 'fresh-access' });
      const response = res();

      await resolveSpotifyToken(TOKENS, response);

      expect(storedCookie(response).refreshToken).toBe('sp-refresh');
    });

    it('takes the new refresh token when the response has one', async () => {
      h.refresh.mockResolvedValue({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' });
      const response = res();

      await resolveSpotifyToken(TOKENS, response);

      expect(storedCookie(response).refreshToken).toBe('fresh-refresh');
    });

    it('refuses to store a refresh response that is not a usable token', async () => {
      h.refresh.mockResolvedValue({ accessToken: '' });
      const response = res();

      const outcome = await resolveSpotifyToken(TOKENS, response);

      expect(response.cookie).not.toHaveBeenCalled();
      expect(outcome.status).toBe('expired');
    });

    it('reports expired, not error, when there is no refresh token to use', async () => {
      const outcome = await resolveSpotifyToken({ ...TOKENS, refreshToken: '' }, res());

      expect(outcome.status).toBe('expired');
      expect(h.refresh).not.toHaveBeenCalled();
    });

    it('reports expired when the refresh itself is rejected', async () => {
      h.refresh.mockRejectedValue(new SpotifyApiError('invalid_grant', 400));

      const outcome = await resolveSpotifyToken(TOKENS, res());

      expect(outcome.status).toBe('expired');
    });
  });

  /**
   * Anything that is not a 401 is about Spotify, not this token - including the 429 that took the
   * app off the air for twelve hours. Reporting it as expired hides a rate limit behind a login
   * prompt.
   */
  describe('when Spotify itself is the problem', () => {
    it.each([
      ['a rate limit', new SpotifyApiError('slow down', 429), 429],
      ['a server error', new SpotifyApiError('boom', 500), 500],
      ['a refusal', new SpotifyApiError('forbidden', 403), 403],
    ])('reports %s as an error, carrying the status', async (_label, error, status) => {
      h.getCurrentUser.mockRejectedValue(error);

      const outcome = await resolveSpotifyToken(TOKENS, res());

      expect(outcome).toMatchObject({ status: 'error', statusCode: status });
      expect(h.refresh).not.toHaveBeenCalled();
    });

    it('reports something that is not a Spotify error at all as an error with no status', async () => {
      h.getCurrentUser.mockRejectedValue(new Error('socket hang up'));

      const outcome = await resolveSpotifyToken(TOKENS, res());

      expect(outcome).toMatchObject({ status: 'error', statusCode: undefined });
    });
  });
});

describe('ensureValidSpotifyToken', () => {
  const cookie = JSON.stringify(TOKENS);

  it('hands back the working token', async () => {
    expect(await ensureValidSpotifyToken(req(cookie), res())).toBe('sp-access');
  });

  it('hands back the refreshed token, not the expired one', async () => {
    h.getCurrentUser.mockRejectedValue(new SpotifyApiError('expired', 401));
    h.refresh.mockResolvedValue({ accessToken: 'fresh-access' });

    expect(await ensureValidSpotifyToken(req(cookie), res())).toBe('fresh-access');
  });

  it('asks the user to reconnect when there is no cookie', async () => {
    await expect(ensureValidSpotifyToken(req(), res())).rejects.toThrow('SPOTIFY_AUTH_REQUIRED');
  });

  it('asks the user to reconnect when the cookie is not a token', async () => {
    await expect(ensureValidSpotifyToken(req('not json'), res())).rejects.toThrow(
      'SPOTIFY_AUTH_REQUIRED',
    );
  });

  it('asks the user to reconnect when the token cannot be refreshed', async () => {
    h.getCurrentUser.mockRejectedValue(new SpotifyApiError('expired', 401));
    h.refresh.mockRejectedValue(new Error('invalid_grant'));

    await expect(ensureValidSpotifyToken(req(cookie), res())).rejects.toThrow(
      'SPOTIFY_AUTH_REQUIRED',
    );
  });

  // "Reconnect" with no cause is unfixable from a log - a dead token has to name what killed it.
  it('carries what went wrong as the cause when the session really is gone', async () => {
    const cause = new SpotifyApiError('invalid_grant', 400);
    h.getCurrentUser.mockRejectedValue(new SpotifyApiError('expired', 401));
    h.refresh.mockRejectedValue(cause);

    await expect(ensureValidSpotifyToken(req(cookie), res())).rejects.toMatchObject({ cause });
  });

  it.each([
    ['a rate limit', new SpotifyApiError('slow down', 429)],
    ['an outage', new SpotifyApiError('temporarily_unavailable', 503)],
  ])('propagates %s as itself, not as a reconnect prompt', async (_label, upstream) => {
    // Spotify being throttled or down says nothing about the session. Reporting it as
    // SPOTIFY_AUTH_REQUIRED sends the user to re-authorize an account that is fine.
    h.getCurrentUser.mockRejectedValue(upstream);

    await expect(ensureValidSpotifyToken(req(cookie), res())).rejects.toBe(upstream);
  });

  it('does not call a failed refresh "expired" when Spotify is the thing that is down', async () => {
    // The 2026-07-16 outage exactly: a valid token, a 401 that triggers a refresh, and a token
    // endpoint returning 503 temporarily_unavailable. Nothing was wrong with the account.
    const outage = new SpotifyApiError(
      'Spotify token request failed: temporarily_unavailable',
      503,
      '{"error":"temporarily_unavailable"}',
    );
    h.getCurrentUser.mockRejectedValue(new SpotifyApiError('expired', 401));
    h.refresh.mockRejectedValue(outage);

    await expect(ensureValidSpotifyToken(req(cookie), res())).rejects.toBe(outage);
  });
});
