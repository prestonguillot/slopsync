/**
 * While YouTube is refusing writes, the app must not offer actions that can only fail.
 *
 * The reported symptom was a video replace returning 500 "Unable to update the playlist. Please try
 * again." for a write the app refused itself - the breaker was open, YouTube was never called, and
 * retrying was the one thing guaranteed not to work. Offering the button at all is the same mistake
 * one step earlier.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { testServer } from '@tests/helpers/testServer';
import { youtubeCircuitBreaker } from '@/lib/circuitBreaker';

const app = testServer(createApp());

const spotifyCookie = `spotify_tokens=${JSON.stringify({
  accessToken: 'at',
  refreshToken: 'rt',
})}`;

beforeEach(() => vi.clearAllMocks());
afterEach(() => youtubeCircuitBreaker.close());

describe('the sync button while writes are refused', () => {
  it('comes back disabled, saying why and when', async () => {
    youtubeCircuitBreaker.open('the daily YouTube API quota is exhausted');

    const res = await request(app)
      .get('/auth/spotify/playlist-button/37i9dQZF1DXcBWIGoYBM5M')
      .set('Cookie', [spotifyCookie]);

    expect(res.status).toBe(503);
    expect(res.text).toContain('disabled');
    expect(res.text).toContain('the daily YouTube API quota is exhausted');
    // It must not still be a button that posts a sync.
    expect(res.text).not.toContain('hx-post');
  });

  it('is offered normally once the breaker closes', async () => {
    youtubeCircuitBreaker.open('transient');
    youtubeCircuitBreaker.close();

    const res = await request(app)
      .get('/auth/spotify/playlist-button/37i9dQZF1DXcBWIGoYBM5M')
      .set('Cookie', [spotifyCookie]);

    // Whatever else it does (auth, lookups), it must not be the blocked branch.
    expect(res.status).not.toBe(503);
  });
});

describe('the breaker records why it opened', () => {
  it('keeps the reason and a reset time while open', () => {
    youtubeCircuitBreaker.open('2 consecutive request failures');

    const state = youtubeCircuitBreaker.getState();
    expect(state.openReason).toBe('2 consecutive request failures');
    expect(state.nextAttemptTime).toBeGreaterThan(Date.now());
  });

  /**
   * Two different times. `nextAttemptTime` is when to probe again in case this was a blip;
   * `openClearsAt` is when the cause actually lifts, and only a caller that knows can say. A
   * breaker opened by unrelated failures has no such knowledge, and must not invent one.
   */
  it('has no clear time when the caller did not know one', () => {
    youtubeCircuitBreaker.open('2 consecutive request failures');

    expect(youtubeCircuitBreaker.getState().openClearsAt).toBeNull();
  });

  it('keeps a clear time that outlasts the probe window', () => {
    const midnightPacific = new Date(Date.now() + 5 * 60 * 60 * 1000);

    youtubeCircuitBreaker.open('the daily YouTube API quota is exhausted', midnightPacific);

    const state = youtubeCircuitBreaker.getState();
    expect(state.openClearsAt).toBe(midnightPacific);
    expect(state.openClearsAt!.getTime()).toBeGreaterThan(state.nextAttemptTime);
  });

  it('forgets it once closed, so a stale reason cannot be shown', () => {
    youtubeCircuitBreaker.open('2 consecutive request failures');
    youtubeCircuitBreaker.close();

    expect(youtubeCircuitBreaker.getState().openReason).toBe('');
  });

  it('forgets the clear time once closed too', () => {
    youtubeCircuitBreaker.open('the daily YouTube API quota is exhausted', new Date());
    youtubeCircuitBreaker.close();

    expect(youtubeCircuitBreaker.getState().openClearsAt).toBeNull();
  });
});
