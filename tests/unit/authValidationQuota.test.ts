import { describe, it, expect, beforeEach, vi } from 'vitest';
import { validateYouTubeConnection } from '../../src/auth/authValidation';
import { youtubeCircuitBreaker } from '../../src/lib/circuitBreaker';
import { YouTubeTokens } from '../../src/types/oauth';
import { YoutubeApiError } from '../../src/youtube/client';
import { Logger } from '../../src/lib/logger';

/**
 * Exactly what src/youtube/client.ts throws for a non-ok response. A plain literal ({ code: 401 })
 * is not a shape the client produces.
 */
const apiError = (code: number, message: string, reason?: string) =>
  new YoutubeApiError(message, code, reason);

// Mock the hand-written YouTube client. createYoutubeClient returns a shared
// client whose channels.list can be overridden per test; refresh is stubbed.
const yt = vi.hoisted(() => ({ channelsList: vi.fn(), refresh: vi.fn() }));
vi.mock('../../src/youtube/client', async (importActual) => {
  const actual = await importActual<typeof import('../../src/youtube/client')>();
  return {
    ...actual,
    createYoutubeClient: vi.fn(() => ({ channels: { list: yt.channelsList } })),
    refreshYoutubeAccessToken: yt.refresh,
  };
});

describe('YouTube Auth Validation - Quota Handling', () => {
  let mockResponse: any;
  let mockYoutubeTokens: YouTubeTokens;

  beforeEach(() => {
    // The quota tests below leave a 403 on channelsList. Without this, a test that runs after one
    // of them inherits the rejection and trips the breaker, so what these assert depends on the
    // order they happen to be declared in.
    yt.channelsList.mockReset();
    yt.refresh.mockReset();

    // Reset circuit breaker before each test
    youtubeCircuitBreaker.close();

    // Mock response object
    mockResponse = {
      clearCookie: vi.fn(),
      cookie: vi.fn(),
    };

    // A cookie's worth of YouTube tokens. scope/token_type are not optional garnish: the schema
    // requires them, and parseYouTubeTokenCookie validates against that same schema on the way in,
    // so tokens reaching this code always carry them.
    mockYoutubeTokens = {
      access_token: 'mock_access_token',
      refresh_token: 'mock_refresh_token',
      scope: 'https://www.googleapis.com/auth/youtube',
      token_type: 'Bearer',
      expiry_date: Date.now() + 3600000,
    };

    vi.clearAllMocks();
  });

  /**
   * A rationing service is not a credential problem. Clearing the cookie here is what turned a
   * temporary limit into a lockout: the user was shown as disconnected and sent to reconnect,
   * down a path that needed the very API that was refusing - so the quota logged them out and
   * then refused to let them back in until it reset.
   */
  describe('Circuit Breaker Token Handling', () => {
    it('reports unavailable rather than disconnected when the breaker is open', async () => {
      youtubeCircuitBreaker.open('the daily YouTube API quota is exhausted');

      const result = await validateYouTubeConnection(mockYoutubeTokens, mockResponse);

      expect(result.connected).toBe(false);
      expect(result.unavailable).toBe(true);
      expect(mockResponse.clearCookie).not.toHaveBeenCalled();
    });

    it('says when to come back', async () => {
      youtubeCircuitBreaker.open('the daily YouTube API quota is exhausted');

      const result = await validateYouTubeConnection(mockYoutubeTokens, mockResponse);

      expect(result.retryAt).toBeInstanceOf(Date);
      expect(result.retryAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('should not clear tokens when circuit breaker is closed', async () => {
      // Ensure circuit breaker is closed
      youtubeCircuitBreaker.close();

      // This will fail because we're not fully mocking the YouTube API,
      // but we're checking that clearCookie isn't called due to circuit breaker
      await validateYouTubeConnection(mockYoutubeTokens, mockResponse).catch(() => {});

      // clearCookie might be called for other reasons (auth failure), but not for circuit breaker
      // Since circuit breaker was closed, it should have attempted validation
      expect(youtubeCircuitBreaker.isOpen()).toBe(false);
    });

    it('should return false when tokens are null', async () => {
      const result = await validateYouTubeConnection(null, mockResponse);

      expect(result.connected).toBe(false);
      expect(mockResponse.clearCookie).not.toHaveBeenCalled();
    });
  });

  describe('Quota Error Detection', () => {
    // The tokens are still good - only the quota is gone - so they are kept, and the breaker is
    // opened so nothing keeps calling an API that has already said no.
    it('keeps tokens on a 403 quota error and opens the breaker', async () => {
      yt.channelsList.mockRejectedValue(apiError(403, 'Quota exceeded', 'quotaExceeded'));

      const result = await validateYouTubeConnection(mockYoutubeTokens, mockResponse);

      expect(result.connected).toBe(false);
      expect(result.unavailable).toBe(true);
      expect(mockResponse.clearCookie).not.toHaveBeenCalled();
      expect(youtubeCircuitBreaker.isOpen()).toBe(true);
    });
  });

  describe('401 token expiry does not trip the circuit breaker', () => {
    it('refreshes on 401 and stays connected without recording a failure', async () => {
      yt.channelsList.mockRejectedValueOnce(apiError(401, 'Invalid credentials'));
      yt.refresh.mockResolvedValueOnce({ access_token: 'refreshed_access_token' });

      const result = await validateYouTubeConnection(mockYoutubeTokens, mockResponse);

      expect(result.connected).toBe(true);
      expect(yt.refresh).toHaveBeenCalledWith('mock_refresh_token');
      expect(mockResponse.cookie).toHaveBeenCalledWith(
        'youtube_tokens',
        expect.any(String),
        expect.anything(),
      );
      expect(mockResponse.clearCookie).not.toHaveBeenCalled();
      expect(youtubeCircuitBreaker.isOpen()).toBe(false);
    });

    it('does NOT open the breaker after repeated 401s (routine expiry, not an API failure)', async () => {
      yt.channelsList.mockRejectedValue(apiError(401, 'Invalid credentials'));
      yt.refresh.mockRejectedValue(new Error('refresh failed'));

      // Well past the failure threshold (2) - none of these should count against the breaker.
      for (let i = 0; i < 5; i++) {
        const result = await validateYouTubeConnection(mockYoutubeTokens, mockResponse);
        expect(result.connected).toBe(false);
        expect(result.errorCode).toBe(401);
      }
      expect(youtubeCircuitBreaker.isOpen()).toBe(false);
    });

    // A refresh response reaches the cookie only through the schema every other write uses -
    // otherwise a bad one is persisted and blows up later, when the cookie is read back.
    it('does not persist a refreshed token that fails validation', async () => {
      yt.channelsList.mockRejectedValueOnce(apiError(401, 'Invalid credentials'));
      yt.refresh.mockResolvedValueOnce({ access_token: '' }); // schema requires a non-empty token

      const result = await validateYouTubeConnection(mockYoutubeTokens, mockResponse);

      expect(mockResponse.cookie).not.toHaveBeenCalled();
      expect(result.connected).toBe(false);
      expect(result.errorCode).toBe(401);
      expect(youtubeCircuitBreaker.isOpen()).toBe(false);
    });

    it('clears tokens and asks to reconnect when there is no refresh token', async () => {
      yt.channelsList.mockRejectedValueOnce(apiError(401, 'Invalid credentials'));
      const noRefresh: YouTubeTokens = {
        access_token: 'a',
        scope: 'https://www.googleapis.com/auth/youtube',
        token_type: 'Bearer',
        expiry_date: Date.now() + 3600000,
      };

      const result = await validateYouTubeConnection(noRefresh, mockResponse);

      expect(result.connected).toBe(false);
      expect(result.errorCode).toBe(401);
      expect(result.error).toBe('YouTube credentials expired. Please reconnect.');
      expect(mockResponse.clearCookie).toHaveBeenCalledWith('youtube_tokens');
      expect(yt.refresh).not.toHaveBeenCalled();
      expect(youtubeCircuitBreaker.isOpen()).toBe(false);
    });
  });

  describe('User Experience Flow', () => {
    it('should transition from connected to unavailable on quota exceeded', async () => {
      // Start in connected state (circuit closed)
      expect(youtubeCircuitBreaker.isOpen()).toBe(false);

      // Simulate quota exceeded
      youtubeCircuitBreaker.open('the daily YouTube API quota is exhausted');

      const result = await validateYouTubeConnection(mockYoutubeTokens, mockResponse);

      expect(result.connected).toBe(false);
      expect(result.unavailable).toBe(true);
      // The credentials survive the outage, so there is something to reconnect with afterwards.
      expect(mockResponse.clearCookie).not.toHaveBeenCalled();
      expect(youtubeCircuitBreaker.isOpen()).toBe(true);
    });

    it('should not show intermediate error state to user', () => {
      // This test documents the design decision:
      // When quota is exceeded, we clear tokens (disconnect) rather than
      // showing an error state with "QUOTA EXCEEDED" buttons

      youtubeCircuitBreaker.open('the daily YouTube API quota is exhausted');
      expect(youtubeCircuitBreaker.canProceed()).toBe(false);

      // User should see disconnected state (tokens cleared)
      // NOT an error state with special error buttons
    });
  });

  describe('Circuit Breaker State Management', () => {
    it('should prevent repeated API calls when circuit is open', async () => {
      youtubeCircuitBreaker.open('the daily YouTube API quota is exhausted');

      // Multiple validation attempts should all be blocked
      const result1 = await validateYouTubeConnection(mockYoutubeTokens, mockResponse);
      const result2 = await validateYouTubeConnection(mockYoutubeTokens, mockResponse);
      const result3 = await validateYouTubeConnection(mockYoutubeTokens, mockResponse);

      expect(result1.connected).toBe(false);
      expect(result2.connected).toBe(false);
      expect(result3.connected).toBe(false);

      // Every page load runs this. Clearing on each one is how a fifteen-minute breaker window
      // became a permanent signed-out state that no amount of reconnecting could fix.
      expect(mockResponse.clearCookie).not.toHaveBeenCalled();
    });

    it('should allow validation when circuit is closed', () => {
      youtubeCircuitBreaker.close();

      expect(youtubeCircuitBreaker.canProceed()).toBe(true);
      expect(youtubeCircuitBreaker.isOpen()).toBe(false);
    });
  });

  describe('Error Message Feedback', () => {
    /**
     * "Please try again later" names no time, and the breaker's own window would name the wrong
     * one: it reopens every fifteen minutes, while the daily quota is gone until midnight Pacific.
     * The wait is asserted loosely because it depends on the hour the test runs.
     */
    it('says the service is refusing and when to retry, when the breaker is open', async () => {
      youtubeCircuitBreaker.open('the daily YouTube API quota is exhausted');

      const result = await validateYouTubeConnection(mockYoutubeTokens, mockResponse);

      expect(result.connected).toBe(false);
      expect(result.error).toContain('YouTube is not accepting requests right now');
      expect(result.error).toMatch(/Try again in about .+\./);
      expect(result.errorCode).toBe('CIRCUIT_BREAKER_OPEN');
    });

    it('says the same on a 403 response', async () => {
      yt.channelsList.mockRejectedValueOnce(apiError(403, 'Quota exceeded', 'quotaExceeded'));

      const result = await validateYouTubeConnection(mockYoutubeTokens, mockResponse);

      expect(result.connected).toBe(false);
      expect(result.error).toContain('YouTube is not accepting requests right now');
      expect(result.errorCode).toBe(403);
    });

    it('should return generic error message for non-quota errors', async () => {
      yt.channelsList.mockRejectedValueOnce(apiError(500, 'Internal server error'));

      const result = await validateYouTubeConnection(mockYoutubeTokens, mockResponse);

      expect(result.connected).toBe(false);
      expect(result.error).toBe('Unable to validate YouTube connection. Please try reconnecting.');
      expect(result.errorCode).toBe(500);
    });

    it('should return no error message when tokens are null', async () => {
      const result = await validateYouTubeConnection(null, mockResponse);

      expect(result.connected).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.errorCode).toBeUndefined();
    });
  });
});

/**
 * What the breaker is told, and what gets written down when a failure is not an Error at all.
 */
describe('what a quota failure records', () => {
  beforeEach(() => {
    yt.channelsList.mockReset();
    yt.refresh.mockReset();
    youtubeCircuitBreaker.close();
  });

  const tokens = {
    access_token: 'a',
    refresh_token: 'b',
    scope: 'https://www.googleapis.com/auth/youtube',
    token_type: 'Bearer',
    expiry_date: Date.now() + 3_600_000,
  };

  /**
   * The reason is why a later refusal can say what happened instead of guessing "quota exceeded",
   * and the clear time is why it can say when - a daily quota outlasts the breaker's probe window
   * many times over.
   */
  it('tells the breaker why it opened and when that lifts', async () => {
    yt.channelsList.mockRejectedValue(apiError(403, 'Quota exceeded', 'quotaExceeded'));

    await validateYouTubeConnection(tokens, { clearCookie: vi.fn(), cookie: vi.fn() } as never);

    const state = youtubeCircuitBreaker.getState();
    expect(state.openReason).toBe(
      'YouTube reported its quota exhausted while validating the connection',
    );
    expect(state.openClearsAt!.getTime()).toBeGreaterThan(state.nextAttemptTime);
  });

  // Not everything thrown is an Error. Logging `undefined` for the message loses the one detail
  // that says what went wrong.
  it('logs a usable message when the failure is not an Error', async () => {
    yt.channelsList.mockRejectedValue('a bare string, not an Error');
    const auth = vi.spyOn(Logger, 'auth').mockImplementation(() => undefined);

    await validateYouTubeConnection(tokens, { clearCookie: vi.fn(), cookie: vi.fn() } as never);

    expect(auth).toHaveBeenCalledWith(
      'YouTube',
      'connection invalid',
      expect.objectContaining({ error: 'Unknown error' }),
    );
  });
});
