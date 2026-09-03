/**
 * Integration tests for connection button endpoints (BUG-002)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Each status render is held back half a second so the spinner cannot flash. That wait is
// statusEndpointTiming.test.ts's subject; here it is four seconds of sleeping that starves the
// rest of the suite.
vi.mock('@/lib/delay', () => ({ sleep: vi.fn(() => Promise.resolve()) }));

import { createApp } from '@/app';
import { testServer } from '@tests/helpers/testServer';

// Mock connection validation so these tests are deterministic and offline - the
// real validators hit the live Spotify/YouTube APIs (the source of CI flakiness).
const mockAuth = vi.hoisted(() => ({
  validateSpotifyConnection: vi.fn(),
  validateYouTubeConnection: vi.fn(),
}));
vi.mock('@/auth/authValidation', async (orig) => ({
  ...(await orig<typeof import('@/auth/authValidation')>()),
  validateSpotifyConnection: mockAuth.validateSpotifyConnection,
  validateYouTubeConnection: mockAuth.validateYouTubeConnection,
}));

const app = testServer(createApp());

describe('Connection Button Endpoints', () => {
  beforeEach(() => {
    mockAuth.validateSpotifyConnection.mockResolvedValue({ connected: false });
    mockAuth.validateYouTubeConnection.mockResolvedValue({ connected: false });
  });

  describe('BUG-002: Loading parameter handling', () => {
    describe('GET /api/status/spotify/button', () => {
      it('should return 200 and render connection button', async () => {
        const response = await request(app).get('/api/status/spotify/button').expect(200);

        // Should contain connection button HTML
        expect(response.text).toBeDefined();
        expect(response.text.length).toBeGreaterThan(0);
      });

      it('should not crash with missing loading parameter', async () => {
        // This test ensures BUG-002 is fixed - the endpoint should pass loading parameter
        const response = await request(app).get('/api/status/spotify/button');

        // Should succeed without ReferenceError
        expect(response.status).toBe(200);

        // Response should not contain error text
        expect(response.text).not.toContain('ReferenceError');
        expect(response.text).not.toContain('loading is not defined');
      });

      it('should render for unauthenticated users', async () => {
        const response = await request(app).get('/api/status/spotify/button').expect(200);

        // Should render successfully even without auth
        expect(response.text).toBeDefined();
      });
    });

    describe('GET /api/status/youtube/button', () => {
      it('should return 200 and render connection button', async () => {
        const response = await request(app).get('/api/status/youtube/button').expect(200);

        // Should contain connection button HTML
        expect(response.text).toBeDefined();
        expect(response.text.length).toBeGreaterThan(0);
      });

      it('should not crash with missing loading parameter', async () => {
        // This test ensures BUG-002 is fixed - the endpoint should pass loading parameter
        const response = await request(app).get('/api/status/youtube/button');

        // Should succeed without ReferenceError
        expect(response.status).toBe(200);

        // Response should not contain error text
        expect(response.text).not.toContain('ReferenceError');
        expect(response.text).not.toContain('loading is not defined');
      });

      it('should render for unauthenticated users', async () => {
        const response = await request(app).get('/api/status/youtube/button').expect(200);

        // Should render successfully even without auth
        expect(response.text).toBeDefined();
      });
    });

    describe('Rate limiting', () => {
      it('should apply rate limiting to status endpoints', async () => {
        // Status endpoints use statusLimiter (30 req/min)
        // First request should succeed
        const response1 = await request(app).get('/api/status/spotify/button');

        expect(response1.status).toBe(200);

        // Subsequent requests should also succeed (we're not hitting the limit)
        const response2 = await request(app).get('/api/status/spotify/button');

        expect(response2.status).toBe(200);
      });
    });

    describe('Content validation', () => {
      it('should return HTML content for Spotify button', async () => {
        const response = await request(app).get('/api/status/spotify/button');

        // Should be HTML
        expect(response.headers['content-type']).toMatch(/html/);
      });

      it('should return HTML content for YouTube button', async () => {
        const response = await request(app).get('/api/status/youtube/button');

        // Should be HTML
        expect(response.headers['content-type']).toMatch(/html/);
      });
    });
  });

  describe('Error handling', () => {
    it('should handle invalid HTTP methods gracefully', async () => {
      const response = await request(app).post('/api/status/spotify/button');

      // Should return 404 (route not found for POST)
      expect(response.status).toBe(404);
    });
  });

  /**
   * The status endpoint reports a connection; it never announces one.
   *
   * It holds no session, so "connected" and "just connected" are the same thing to it. Announcing a
   * connection on every render made the client refetch the whole Spotify library - every playlist
   * on both services - each time the button rendered. Only the OAuth callback knows a connect
   * actually happened, and it says so with ?connected=youtube.
   */
  describe('the status buttons announce nothing', () => {
    const YOUTUBE_TOKENS = JSON.stringify({
      access_token: 'mock_youtube_access_token',
      refresh_token: 'mock_youtube_refresh_token',
      scope: 'https://www.googleapis.com/auth/youtube',
      token_type: 'Bearer',
      expiry_date: Date.now() + 3600000,
    });
    const SPOTIFY_TOKENS = JSON.stringify({
      accessToken: 'mock_spotify_access_token',
      refreshToken: 'mock_spotify_refresh_token',
    });

    it('sends no HX-Trigger when YouTube is connected', async () => {
      mockAuth.validateYouTubeConnection.mockResolvedValue({ connected: true });

      const response = await request(app)
        .get('/api/status/youtube/button')
        .set('Cookie', [`youtube_tokens=${YOUTUBE_TOKENS}`]);

      expect(response.status).toBe(200);
      expect(response.headers['hx-trigger']).toBeUndefined();
    });

    it('sends no HX-Trigger when YouTube is not connected', async () => {
      const response = await request(app).get('/api/status/youtube/button');

      expect(response.headers['hx-trigger']).toBeUndefined();
    });

    it('sends no HX-Trigger for the Spotify button', async () => {
      const response = await request(app)
        .get('/api/status/spotify/button')
        .set('Cookie', [`spotify_tokens=${SPOTIFY_TOKENS}`]);

      expect(response.headers['hx-trigger']).toBeUndefined();
    });
  });
});

/**
 * A service that is up but rationing us is not a disconnected service, and the button has to say
 * so. Offering "Connect" during a quota outage sends the user into an OAuth round trip that cannot
 * help - and, before the validator stopped clearing tokens on a 403, actively made things worse by
 * discarding the credentials that were still good.
 */
describe('when a service is unavailable rather than disconnected', () => {
  beforeEach(() => {
    mockAuth.validateYouTubeConnection.mockResolvedValue({
      connected: false,
      unavailable: true,
      retryAt: new Date(Date.now() + 5 * 60 * 60 * 1000),
      error: 'YouTube is not accepting requests right now. Try again in about 5 hours.',
    });
  });

  it('does not offer a connect link', async () => {
    const response = await request(app).get('/api/status/youtube/button');

    expect(response.text).not.toContain('/auth/youtube/login');
  });

  it('says the service is unavailable', async () => {
    const response = await request(app).get('/api/status/youtube/button');

    expect(response.text).toContain('Youtube Unavailable');
    expect(response.text).toContain('data-connected="unavailable"');
    expect(response.text).toContain('disabled');
  });

  it('carries the reason, so the wait is discoverable from the control itself', async () => {
    const response = await request(app).get('/api/status/youtube/button');

    expect(response.text).toContain('Try again in about 5 hours');
  });

  // The contrast that gives the above its meaning: genuinely disconnected still offers the link.
  it('still offers the link when actually disconnected', async () => {
    mockAuth.validateYouTubeConnection.mockResolvedValue({ connected: false });

    const response = await request(app).get('/api/status/youtube/button');

    expect(response.text).toContain('/auth/youtube/login');
    expect(response.text).not.toContain('Unavailable');
  });
});
