/**
 * Tests for the YouTube OAuth callback's success path.
 *
 * This is the only place that knows a connect just happened. It says so with ?connected=youtube,
 * which is the client's cue to refetch the playlist list past the cache - the copy the browser
 * holds was fetched before the connect and shows every playlist as unsynced.
 *
 * The invariant these hold shut is that connecting spends no quota. `channelsList` stays mocked
 * for exactly that: it is asserted never to be called, and made to fail in the way a spent quota
 * fails, so a connect that reaches for the API again is caught here rather than on the one day of
 * the month the quota is actually gone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const h = vi.hoisted(() => ({ exchangeYoutubeCode: vi.fn(), channelsList: vi.fn() }));

vi.mock('@/youtube/client', async (importActual) => ({
  ...(await importActual<typeof import('@/youtube/client')>()),
  exchangeYoutubeCode: h.exchangeYoutubeCode,
  createYoutubeClient: () => ({ channels: { list: h.channelsList } }),
}));

import { createApp } from '@/app';
import { testServer } from '@tests/helpers/testServer';
import { findSetCookie } from '@tests/helpers/httpCookies';

const app = testServer(createApp());

const CODE = 'a'.repeat(40);
const STATE = 'matching-state';

const callback = () =>
  request(app)
    .get('/auth/youtube/callback')
    .set('Cookie', `youtube_oauth_state=${STATE}`)
    .query({ code: CODE, state: STATE });

beforeEach(() => {
  vi.clearAllMocks();
  h.exchangeYoutubeCode.mockResolvedValue({
    access_token: 'yt-access',
    refresh_token: 'yt-refresh',
    scope: 'https://www.googleapis.com/auth/youtube',
    token_type: 'Bearer',
    expiry_date: Date.now() + 3600_000,
  });
  h.channelsList.mockResolvedValue({ data: { items: [{ id: 'UC-channel-id' }] } });
});

describe('a successful YouTube connect', () => {
  it('marks the redirect as a fresh connect', async () => {
    const response = await callback();

    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe('/?connected=youtube');
  });

  it('stores the tokens in a cookie', async () => {
    const response = await callback();

    const cookie = findSetCookie(response, 'youtube_tokens');
    expect(cookie).toBeDefined();
    expect(cookie).toContain('HttpOnly');
  });

  it('stores the exchanged tokens', async () => {
    const response = await callback();

    const cookie = findSetCookie(response, 'youtube_tokens')!;
    const value = JSON.parse(decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!));
    expect(value.access_token).toBe('yt-access');
    expect(value.refresh_token).toBe('yt-refresh');
  });

  it('exchanges the code it was given', async () => {
    await callback();

    expect(h.exchangeYoutubeCode).toHaveBeenCalledWith(CODE);
  });

  // Authenticating costs no quota, so the connect must not call the API at all.
  it('calls no YouTube API', async () => {
    await callback();

    expect(h.channelsList).not.toHaveBeenCalled();
  });
});

describe('when the connect fails', () => {
  it('does not mark a connect when the code exchange fails', async () => {
    h.exchangeYoutubeCode.mockRejectedValue(new Error('invalid_grant'));

    const response = await callback();

    expect(response.headers['location']).toMatch(/^\/\?error=youtube/);
    expect(response.headers['location']).not.toContain('connected=youtube');
  });

  // 400 and 401 are the two YouTube answers that mean "this code or token is no good" - the user
  // can fix that by connecting again, which is what auth_error tells the page to offer.
  it.each([[400], [401]])('reports an auth error for a %i', async (code) => {
    const { YoutubeApiError } = await import('@/youtube/client');
    h.exchangeYoutubeCode.mockRejectedValue(new YoutubeApiError('bad code', code));

    const response = await callback();

    expect(response.headers['location']).toBe('/?error=youtube&reason=auth_error');
  });

  /**
   * A bare 403 is not quota. During OAuth it is far more likely to be a permissions or consent
   * problem, and calling it quota sends the user off to wait for a midnight reset that will never
   * fix it. Not every YoutubeApiError is an auth error either - only the codes that say so.
   */
  it.each([[403], [500]])('reports a plain failure for a %i', async (code) => {
    const { YoutubeApiError } = await import('@/youtube/client');
    h.exchangeYoutubeCode.mockRejectedValue(new YoutubeApiError('nope', code));

    const response = await callback();

    expect(response.headers['location']).toBe('/?error=youtube&reason=failed');
  });

  // An error that is not YouTube's at all cannot be classified by its code.
  it('reports a plain failure for an error with no status at all', async () => {
    h.exchangeYoutubeCode.mockRejectedValue(new Error('socket hang up'));

    const response = await callback();

    expect(response.headers['location']).toBe('/?error=youtube&reason=failed');
  });

  it('stores nothing when the exchange fails', async () => {
    h.exchangeYoutubeCode.mockRejectedValue(new Error('invalid_grant'));

    const response = await callback();

    expect(findSetCookie(response, 'youtube_tokens')).toBeUndefined();
  });
});

/**
 * The failure this replaced: the connect fetched a channel id, an exhausted quota failed that
 * call, and the whole connect was abandoned before the cookie was ever written. Combined with the
 * validator clearing tokens on the same 403, running out of quota logged you out and then refused
 * every attempt to log back in, because reconnecting needed the quota that was gone.
 */
describe('connecting while the daily quota is exhausted', () => {
  beforeEach(async () => {
    const { YoutubeApiError } = await import('@/youtube/client');
    h.channelsList.mockRejectedValue(new YoutubeApiError('quota', 403, 'quotaExceeded'));
  });

  it('connects anyway', async () => {
    const response = await callback();

    expect(response.headers['location']).toBe('/?connected=youtube');
  });

  it('stores the tokens anyway', async () => {
    const response = await callback();

    expect(findSetCookie(response, 'youtube_tokens')).toBeDefined();
  });
});

/**
 * What the callback writes to the log. These are the lines someone reads when a connect failed and
 * the browser only said "something went wrong" - so which service rejected the state, and whether
 * a code arrived at all, have to be in them.
 */
describe('what the callback records', () => {
  it('names YouTube when it rejects a mismatched state', async () => {
    const { Logger } = await import('@/lib/logger');
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);

    await request(app)
      .get('/auth/youtube/callback')
      .set('Cookie', 'youtube_oauth_state=some-other-state')
      .query({ code: CODE, state: STATE });

    expect(warn).toHaveBeenCalledWith(
      'YouTube callback rejected - OAuth state mismatch',
      expect.anything(),
    );
  });

  // Distinguishes "the user never got back from Google" from "they did, and it failed here".
  it('records whether an authorization code arrived', async () => {
    const { Logger } = await import('@/lib/logger');
    const requestStart = vi.spyOn(Logger, 'requestStart').mockImplementation(() => undefined);

    await callback();

    expect(requestStart).toHaveBeenCalledWith(
      'YouTube Callback Request',
      expect.objectContaining({ authCodePresent: true }),
    );
  });
});
