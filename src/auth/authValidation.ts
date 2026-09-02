/**
 * Connection status for the UI.
 *
 * The token work itself - validate, refresh on 401, rewrite the cookie - is NOT here: it lives
 * once per service in spotify/auth.ts and youtube/auth.ts, which the per-request handlers use
 * too. What remains is what only the status endpoint cares about: gating on the circuit breaker,
 * feeding it, and turning an outcome into something the user can read.
 */

import { Response } from 'express';
import { Logger } from '../lib/logger';
import { SpotifyTokens, TokenOutcome, YouTubeTokens } from '../types/oauth';
import { youtubeCircuitBreaker, spotifyCircuitBreaker } from '../lib/circuitBreaker';
import { resolveSpotifyToken } from '../spotify/auth';
import { resolveYouTubeToken } from '../youtube/auth';

/** The class itself is module-private; the shared helpers below only need its shape. */
type Breaker = typeof spotifyCircuitBreaker;

type Service = 'Spotify' | 'YouTube';

/**
 * Connection validation result with optional error details
 */
export interface ConnectionResult {
  connected: boolean;
  error?: string; // User-friendly error message
  errorCode?: string | number; // Technical error code for logging
}

/**
 * Turn a resolved token into a connection result, keeping the circuit breaker honest.
 *
 * The breaker reflects API health only: a success (or a successful refresh) clears it, the
 * service's own "you have had enough" status opens it, and a genuine failure (5xx/network) counts
 * against it. An expired token never touches it - that is routine, not ill health.
 *
 * @param quotaStatus The status this service uses to say a limit was hit (429 Spotify, 403 YouTube).
 */
function toConnectionResult(
  service: Service,
  cookieName: string,
  breaker: Breaker,
  quotaStatus: number,
  outcome: TokenOutcome,
  res: Response,
): ConnectionResult {
  if (outcome.status === 'valid' || outcome.status === 'refreshed') {
    breaker.recordSuccess();
    Logger.auth(service, 'connection validated');
    return { connected: true };
  }

  if (outcome.status === 'expired') {
    Logger.auth(service, 'connection invalid - credentials expired');
    res.clearCookie(cookieName);
    return {
      connected: false,
      error: `${service} credentials expired. Please reconnect.`,
      errorCode: 401,
    };
  }

  const { statusCode, error } = outcome;
  Logger.auth(service, 'connection invalid', {
    error: error instanceof Error ? error.message : 'Unknown error',
    statusCode,
  });
  res.clearCookie(cookieName);

  // The service told us to back off - stop calling it until it resets.
  if (statusCode === quotaStatus) {
    breaker.open(`${service} reported its quota exhausted while validating the connection`);
    return {
      connected: false,
      error: `${service} API quota exceeded. Please try again later.`,
      errorCode: quotaStatus,
    };
  }

  // Genuine API-health failure (5xx / network) - this is what the circuit breaker is for.
  breaker.recordFailure(error);
  return {
    connected: false,
    error: `Unable to validate ${service} connection. Please try reconnecting.`,
    errorCode: statusCode,
  };
}

/** Refuse to call a service the breaker has already given up on; show it as disconnected. */
function breakerOpenResult(
  service: Service,
  cookieName: string,
  breaker: Breaker,
  res: Response,
): ConnectionResult {
  Logger.auth(service, 'circuit breaker is OPEN, clearing tokens', { state: breaker.getState() });
  // Clear tokens so user sees disconnected state
  res.clearCookie(cookieName);
  return {
    connected: false,
    error: `${service} API quota exceeded. Please try again later.`,
    errorCode: 'CIRCUIT_BREAKER_OPEN',
  };
}

/**
 * Validates Spotify connection and attempts token refresh if needed
 * @returns {ConnectionResult} with connection status and optional error message
 */
export async function validateSpotifyConnection(
  spotifyTokens: SpotifyTokens | null,
  res: Response,
): Promise<ConnectionResult> {
  if (!spotifyTokens) {
    return { connected: false };
  }

  if (!spotifyCircuitBreaker.canProceed()) {
    return breakerOpenResult('Spotify', 'spotify_tokens', spotifyCircuitBreaker, res);
  }

  const outcome = await resolveSpotifyToken(spotifyTokens, res);
  return toConnectionResult('Spotify', 'spotify_tokens', spotifyCircuitBreaker, 429, outcome, res);
}

/**
 * Validates YouTube connection and attempts token refresh if needed
 * @returns {ConnectionResult} with connection status and optional error message
 */
export async function validateYouTubeConnection(
  youtubeTokens: YouTubeTokens | null,
  res: Response,
): Promise<ConnectionResult> {
  if (!youtubeTokens) {
    return { connected: false };
  }

  if (!youtubeCircuitBreaker.canProceed()) {
    return breakerOpenResult('YouTube', 'youtube_tokens', youtubeCircuitBreaker, res);
  }

  // probe: this endpoint exists to say whether YouTube is working for this user, which a token's
  // own expiry cannot answer. The call is how quota exhaustion and API health reach the breaker.
  const outcome = await resolveYouTubeToken(youtubeTokens, res, { probe: true });
  return toConnectionResult('YouTube', 'youtube_tokens', youtubeCircuitBreaker, 403, outcome, res);
}
