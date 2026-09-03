/**
 * Unit tests for the YouTube write layer (src/youtube/writes.ts):
 * every write goes through the circuit breaker, quota cost is counted, and a
 * quota-exceeded (403) opens the breaker and surfaces as YoutubeQuotaError.
 *
 * Errors here are YoutubeApiError, which is the ONLY thing the hand-written client throws. A
 * googleapis-shaped literal ({ code, errors: [{ reason }] }) is not a shape anything produces, and
 * the classification would read an always-undefined reason from it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// isOpen/getState are here because the write layer reads them to say WHY it is refusing. A mock
// missing a method the real breaker has does not fail as a missing expectation - it fails as a
// TypeError from inside the code under test, which reads like a bug in the code.
vi.mock('../../src/lib/circuitBreaker', () => ({
  youtubeCircuitBreaker: {
    canProceed: vi.fn(),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    open: vi.fn(),
    isOpen: vi.fn(() => false),
    getState: vi.fn(() => ({
      state: 'CLOSED',
      nextAttemptTime: 0,
      failureCount: 0,
      openReason: '',
      openClearsAt: null,
    })),
  },
}));

// The backoff between retries is asserted on rather than served: serving it would put seconds of
// real sleeping in the suite for no added coverage.
const h = vi.hoisted(() => ({ sleep: vi.fn((_ms: number) => Promise.resolve()) }));
vi.mock('../../src/lib/delay', () => ({ sleep: h.sleep }));

import { youtubeCircuitBreaker } from '../../src/lib/circuitBreaker';
import { YoutubeApiError } from '../../src/youtube/client';
import { Logger } from '../../src/lib/logger';
import {
  youtubeWrite,
  classifyYoutubeError,
  YoutubeQuotaError,
  YOUTUBE_WRITE_COST,
  getYoutubeWriteQuotaUsed,
  resetYoutubeWriteQuotaCounter,
  youtubeWritesBlocked,
  describeRetryWait,
  dailyQuotaResetAt,
} from '../../src/youtube/writes';

const breaker = vi.mocked(youtubeCircuitBreaker);

/** Exactly what src/youtube/client.ts throws for a non-ok response. */
const apiError = (code: number, reason?: string) =>
  new YoutubeApiError(`YouTube API error (${code})`, code, reason);

describe('youtubeWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetYoutubeWriteQuotaCounter();
    breaker.canProceed.mockReturnValue(true);
  });

  it('runs the write, records success, and counts quota when the breaker is closed', async () => {
    const write = vi.fn(() => Promise.resolve('result'));
    const result = await youtubeWrite('playlistItems.insert', write);

    expect(result).toBe('result');
    expect(write).toHaveBeenCalledOnce();
    expect(breaker.recordSuccess).toHaveBeenCalledOnce();
    expect(getYoutubeWriteQuotaUsed()).toBe(YOUTUBE_WRITE_COST);
  });

  it('refuses without calling the write when the breaker is open', async () => {
    breaker.canProceed.mockReturnValue(false);
    const write = vi.fn(() => Promise.resolve('result'));

    await expect(youtubeWrite('playlistItems.insert', write)).rejects.toBeInstanceOf(
      YoutubeQuotaError,
    );
    expect(write).not.toHaveBeenCalled();
    expect(getYoutubeWriteQuotaUsed()).toBe(0);
  });

  it('opens the breaker and throws YoutubeQuotaError on a 403 quotaExceeded', async () => {
    const quotaError = apiError(403, 'quotaExceeded');
    const write = vi.fn(() => Promise.reject(quotaError));

    await expect(youtubeWrite('playlists.insert', write)).rejects.toBeInstanceOf(YoutubeQuotaError);
    expect(breaker.open).toHaveBeenCalledOnce();
    expect(breaker.recordFailure).not.toHaveBeenCalled();
  });

  it('opens the breaker and throws YoutubeQuotaError on a 403 dailyLimitExceeded', async () => {
    const write = vi.fn(() => Promise.reject(apiError(403, 'dailyLimitExceeded')));

    await expect(youtubeWrite('playlists.insert', write)).rejects.toBeInstanceOf(YoutubeQuotaError);
    expect(breaker.open).toHaveBeenCalledOnce();
  });

  // A bare 403 is NOT necessarily quota - it can be insufficientPermissions, forbidden, or a
  // video-specific rejection. Reporting it as quota opened the breaker for 15 minutes and hid the
  // real cause. It must surface as itself.
  it('does NOT treat a bare 403 (no reason) as quota - rethrows the original, breaker stays closed', async () => {
    const bare403 = apiError(403);
    const write = vi.fn(() => Promise.reject(bare403));

    await expect(youtubeWrite('playlistItems.delete', write)).rejects.toBe(bare403);
    expect(breaker.open).not.toHaveBeenCalled();
    expect(breaker.recordFailure).toHaveBeenCalledOnce();
  });

  // rateLimitExceeded is a short-window throttle (retryable), not the daily budget - opening the
  // breaker over it needlessly kills the whole run.
  it('does NOT treat 403 rateLimitExceeded as daily quota', async () => {
    const throttled = apiError(403, 'rateLimitExceeded');
    const write = vi.fn(() => Promise.reject(throttled));

    await expect(youtubeWrite('playlistItems.insert', write)).rejects.toBe(throttled);
    expect(breaker.open).not.toHaveBeenCalled();
    expect(breaker.recordFailure).toHaveBeenCalledOnce();
  });

  it('records a failure and rethrows the original error for non-quota failures', async () => {
    const serverError = apiError(500);
    const write = vi.fn(() => Promise.reject(serverError));

    await expect(youtubeWrite('playlistItems.update', write)).rejects.toBe(serverError);
    expect(breaker.recordFailure).toHaveBeenCalledOnce();
    expect(breaker.open).not.toHaveBeenCalled();
  });
});

/**
 * The routes classify READ errors with this too (sync, playlistDetails, the OAuth callback), so
 * one definition of "quota" serves every caller instead of the three that had drifted apart.
 */
describe('classifyYoutubeError', () => {
  it('treats a quota error a write already classified as quota', () => {
    expect(classifyYoutubeError(new YoutubeQuotaError('breaker open'))).toBe('quota');
  });

  it.each([['quotaExceeded'], ['dailyLimitExceeded']])(
    'treats a 403 %s as the daily budget being gone',
    (reason) => {
      expect(classifyYoutubeError(apiError(403, reason))).toBe('quota');
    },
  );

  it.each([['rateLimitExceeded'], ['userRateLimitExceeded']])(
    'treats a 403 %s as a transient throttle, not quota',
    (reason) => {
      expect(classifyYoutubeError(apiError(403, reason))).toBe('rate-limit');
    },
  );

  // A bare 403 during OAuth is far more likely permissions or consent than quota - calling it
  // quota sends the user off to wait for a midnight reset that will not fix it.
  it('does not treat a bare 403 as quota', () => {
    expect(classifyYoutubeError(apiError(403))).toBe('other');
  });

  it('does not treat a 403 with an unrelated reason as quota', () => {
    expect(classifyYoutubeError(apiError(403, 'insufficientPermissions'))).toBe('other');
  });

  it.each([[401], [404], [500]])('treats a %i as other', (code) => {
    expect(classifyYoutubeError(apiError(code, 'quotaExceeded'))).toBe('other');
  });

  it('tolerates errors that are not YouTube API errors at all', () => {
    expect(classifyYoutubeError(new Error('socket hang up'))).toBe('other');
    expect(classifyYoutubeError(undefined)).toBe('other');
  });
});

/**
 * A run of rapid playlist writes draws 409 SERVICE_UNAVAILABLE - "the operation was aborted" -
 * out of YouTube. It is a conflict, not a refusal: the same write succeeds a moment later.
 *
 * Giving up on the first one abandoned a reorder a quarter of the way through, which spends the
 * quota and leaves the playlist in neither the old order nor the new - so the next attempt has more
 * to undo than this one did.
 */
describe('youtubeWrite: failures that pass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetYoutubeWriteQuotaCounter();
    breaker.canProceed.mockReturnValue(true);
  });

  it('tries a 409 again, and reports the success', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(apiError(409, 'SERVICE_UNAVAILABLE'))
      .mockResolvedValueOnce('done');

    await expect(youtubeWrite('playlistItems.update', write)).resolves.toBe('done');

    expect(write).toHaveBeenCalledTimes(2);
    expect(breaker.recordSuccess).toHaveBeenCalledOnce();
    // A write that eventually worked is not a failure the breaker should count towards opening.
    expect(breaker.recordFailure).not.toHaveBeenCalled();
  });

  it('charges quota once for a write that took two attempts', async () => {
    const write = vi.fn().mockRejectedValueOnce(apiError(409)).mockResolvedValueOnce('done');

    await youtubeWrite('playlistItems.update', write);

    expect(getYoutubeWriteQuotaUsed()).toBe(YOUTUBE_WRITE_COST);
  });

  it('backs off further each time rather than hammering', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(apiError(409))
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValueOnce('done');

    await youtubeWrite('playlistItems.update', write);

    expect(h.sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000]);
  });

  it.each([
    ['a 409 conflict', apiError(409, 'SERVICE_UNAVAILABLE')],
    ['a 503 from YouTube itself', apiError(503)],
    ['a 500 from YouTube itself', apiError(500)],
    ['a short-window rate limit', apiError(403, 'rateLimitExceeded')],
  ])('tries again after %s', async (_label, error) => {
    const write = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('done');

    await expect(youtubeWrite('playlistItems.update', write)).resolves.toBe('done');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['the daily quota being gone', apiError(403, 'quotaExceeded')],
    ['a permission problem', apiError(403, 'insufficientPermissions')],
    ['a video that cannot be added', apiError(400, 'invalidVideoId')],
    ['a playlist that is not there', apiError(404)],
  ])('does not try again after %s', async (_label, error) => {
    const write = vi.fn().mockRejectedValue(error);

    await expect(youtubeWrite('playlistItems.update', write)).rejects.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it('gives up rather than retrying forever, and says what beat it', async () => {
    const write = vi.fn().mockRejectedValue(apiError(409, 'SERVICE_UNAVAILABLE'));

    await expect(youtubeWrite('playlistItems.update', write)).rejects.toMatchObject({ code: 409 });

    expect(write).toHaveBeenCalledTimes(4);
    // Only now, having actually given up, does the breaker hear about it.
    expect(breaker.recordFailure).toHaveBeenCalledOnce();
  });

  it('charges no quota for a write that never landed', async () => {
    const write = vi.fn().mockRejectedValue(apiError(409));

    await expect(youtubeWrite('playlistItems.update', write)).rejects.toThrow();

    expect(getYoutubeWriteQuotaUsed()).toBe(0);
  });
});

/**
 * A refusal has to say what is blocking, why, and until when.
 *
 * The breaker opens two ways that mean opposite things - a real daily quota exhaustion, or
 * `failureThreshold` unrelated failures - and once open every refusal looks the same. Reporting all
 * of them as "quota exceeded" sends people to wait for a midnight reset that was never the problem.
 */
describe('what a blocked write reports', () => {
  it('carries the reason and the retry time on the error', async () => {
    const retryAt = new Date(Date.now() + 12 * 60 * 1000);
    breaker.canProceed.mockReturnValue(false);
    breaker.isOpen.mockReturnValue(true);
    breaker.getState.mockReturnValue({
      state: 'OPEN',
      nextAttemptTime: retryAt.getTime(),
      failureCount: 0,
      openReason: '2 consecutive request failures',
    } as ReturnType<typeof breaker.getState>);

    await expect(youtubeWrite('playlistItems.insert', vi.fn())).rejects.toMatchObject({
      reason: '2 consecutive request failures',
      retryAt,
    });
  });

  it('logs the refusal, which is otherwise invisible', async () => {
    // No request is made, so nothing else in the log mentions a breaker. Without this line the only
    // trace is the calling route's generic "something went wrong" plus a stack.
    const warn = vi.spyOn(Logger, 'warn');
    breaker.canProceed.mockReturnValue(false);
    breaker.isOpen.mockReturnValue(true);
    breaker.getState.mockReturnValue({
      state: 'OPEN',
      nextAttemptTime: Date.now() + 60_000,
      failureCount: 0,
      openReason: 'the daily YouTube API quota is exhausted',
    } as ReturnType<typeof breaker.getState>);

    await expect(youtubeWrite('playlistItems.insert', vi.fn())).rejects.toThrow();

    expect(warn).toHaveBeenCalledWith(
      'YouTube write refused - circuit breaker is open',
      expect.objectContaining({
        operation: 'playlistItems.insert',
        reason: 'the daily YouTube API quota is exhausted',
        retryAt: expect.any(String),
      }),
    );
  });

  it('opens the breaker with the one reason that really is quota', async () => {
    breaker.canProceed.mockReturnValue(true);
    breaker.isOpen.mockReturnValue(false);

    await expect(
      youtubeWrite(
        'playlistItems.insert',
        vi.fn(() => Promise.reject(apiError(403, 'quotaExceeded'))),
      ),
    ).rejects.toThrow();

    // The clear time goes in with the reason. A daily quota outlasts the breaker's fifteen-minute
    // probe window many times over, so without it every caller would tell the user to come back in
    // fifteen minutes, over and over, until midnight Pacific.
    expect(breaker.open).toHaveBeenCalledWith(
      'the daily YouTube API quota is exhausted',
      dailyQuotaResetAt(),
    );
  });
});

describe('youtubeWritesBlocked', () => {
  it('reports nothing while writes are allowed', () => {
    breaker.isOpen.mockReturnValue(false);

    expect(youtubeWritesBlocked()).toBeNull();
  });

  it('falls back to a usable reason rather than an empty string', () => {
    // An older breaker, or one opened before the reason was recorded, must not produce
    // "blocked because ." in the UI.
    breaker.isOpen.mockReturnValue(true);
    breaker.getState.mockReturnValue({
      state: 'OPEN',
      nextAttemptTime: Date.now() + 1000,
      failureCount: 0,
      openReason: '',
      openClearsAt: null,
    } as ReturnType<typeof breaker.getState>);

    expect(youtubeWritesBlocked()?.reason).toBe('repeated YouTube failures');
  });
});

describe('describeRetryWait', () => {
  const now = Date.now();

  it.each([
    ['in about 12 minutes', 12 * 60_000],
    ['in about a minute', 40_000],
    ['now', -5000],
    ['in about 59 minutes', 59 * 60_000],
    // A daily quota is a wait of hours, and "in about 313 minutes" is a number nobody converts.
    ['in about an hour', 60 * 60_000],
    ['in about 5 hours', 5 * 60 * 60_000],
  ])('says %s', (expected, offset) => {
    expect(describeRetryWait(new Date(now + offset), now)).toBe(expected);
  });
});

/**
 * The daily quota comes back at midnight Pacific, which is neither UTC midnight nor the circuit
 * breaker's fifteen-minute probe. Both offsets are checked because Pacific is UTC-7 in summer and
 * UTC-8 in winter, and reading the offset rather than assuming one is the whole point.
 */
describe('dailyQuotaResetAt', () => {
  it.each([
    ['during PDT (UTC-7)', '2026-09-03T05:30:00Z', '2026-09-03T07:00:00.000Z'],
    ['during PST (UTC-8)', '2026-01-15T05:30:00Z', '2026-01-15T08:00:00.000Z'],
    // A minute past Pacific midnight waits out the whole of the next day, not a moment.
    ['just after a reset', '2026-09-03T07:01:00Z', '2026-09-04T07:00:00.000Z'],
  ])('%s', (_label, now, expected) => {
    expect(dailyQuotaResetAt(new Date(now)).toISOString()).toBe(expected);
  });

  it('is always ahead of now, and never more than a day out', () => {
    const now = new Date();

    const reset = dailyQuotaResetAt(now).getTime() - now.getTime();

    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

/**
 * The reset is a fixed instant, so asking twice must give the same answer. It used to carry the
 * caller's milliseconds, which made every call a slightly different Date for one boundary - fine
 * to display, quietly wrong to compare or store.
 */
describe('dailyQuotaResetAt is a boundary, not an offset', () => {
  it('lands exactly on the second, with no milliseconds', () => {
    expect(dailyQuotaResetAt(new Date('2026-09-03T05:37:23.427Z')).getMilliseconds()).toBe(0);
  });

  it('gives the same answer for two instants in the same Pacific day', () => {
    const early = dailyQuotaResetAt(new Date('2026-09-03T05:37:23.427Z'));
    const later = dailyQuotaResetAt(new Date('2026-09-03T06:12:44.001Z'));

    expect(early.toISOString()).toBe(later.toISOString());
  });

  // Non-zero seconds, so dropping any one component of the time-of-day changes the answer.
  it('accounts for the seconds, not just hours and minutes', () => {
    expect(dailyQuotaResetAt(new Date('2026-09-03T05:37:23Z')).toISOString()).toBe(
      '2026-09-03T07:00:00.000Z',
    );
  });
});

/**
 * Which clock a blocked write quotes. The breaker holds two times that mean different things: when
 * to probe again, and when the cause actually lifts. Quoting the probe window for a daily quota
 * tells someone to come back every fifteen minutes until midnight Pacific.
 */
describe('which retry time a blocked write reports', () => {
  const IN_FIFTEEN_MINUTES = Date.now() + 15 * 60_000;
  const AT_MIDNIGHT_PACIFIC = new Date(Date.now() + 5 * 60 * 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    breaker.isOpen.mockReturnValue(true);
  });

  it('prefers when the cause lifts over when the breaker next probes', () => {
    breaker.getState.mockReturnValue({
      state: 'OPEN',
      nextAttemptTime: IN_FIFTEEN_MINUTES,
      failureCount: 0,
      openReason: 'the daily YouTube API quota is exhausted',
      openClearsAt: AT_MIDNIGHT_PACIFIC,
    } as ReturnType<typeof breaker.getState>);

    expect(youtubeWritesBlocked()?.retryAt).toBe(AT_MIDNIGHT_PACIFIC);
  });

  // Nothing knows better than the probe window for a breaker opened by unrelated failures.
  it('falls back to the probe window when the cause has no known end', () => {
    breaker.getState.mockReturnValue({
      state: 'OPEN',
      nextAttemptTime: IN_FIFTEEN_MINUTES,
      failureCount: 0,
      openReason: 'repeated YouTube failures',
      openClearsAt: null,
    } as ReturnType<typeof breaker.getState>);

    expect(youtubeWritesBlocked()?.retryAt.getTime()).toBe(IN_FIFTEEN_MINUTES);
  });
});
