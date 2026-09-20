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
import { dailyQuotaResetAt, describeRetryWait } from '../youtube/writes';

/** The class itself is module-private; the shared helpers below only need its shape. */
type Breaker = typeof spotifyCircuitBreaker;

/** When the breaker will next let a request through - the right answer for a short throttle. */
const breakerRetryAt = (breaker: Breaker) => new Date(breaker.getState().nextAttemptTime);

type Service = 'Spotify' | 'YouTube';

/**
 * Connection validation result with optional error details.
 *
 * `connected: false` and `unavailable: true` are different answers and the UI has to tell them
 * apart. Not connected means there are no usable credentials and the fix is to connect. Unavailable
 * means the credentials are fine and the service is rationing us - offering a connect button there
 * invites a reconnect that cannot help.
 */
export interface ConnectionResult {
  connected: boolean;
  /** The service is temporarily refusing us. The stored credentials are still good. */
  unavailable?: boolean;
  /** When it is worth trying again. Only set alongside `unavailable`. */
  retryAt?: Date;
  error?: string; // User-friendly error message
  errorCode?: string | number; // Technical error code for logging
}

/** How a service says "you have had enough", and when it will stop saying it. */
interface QuotaLimit {
  /** 429 for Spotify, 403 for YouTube. */
  status: number;
  retryAt: () => Date;
}

/**
 * Turn a resolved token into a connection result, keeping the circuit breaker honest.
 *
 * The breaker reflects API health only: a success (or a successful refresh) clears it, the
 * service's own "you have had enough" status opens it, and a genuine failure (5xx/network) counts
 * against it. An expired token never touches it - that is routine, not ill health.
 *
 * Tokens are cleared for credential problems only. A rationing service is not a credential
 * problem: the tokens still work, and discarding them takes the refresh token with them, so the
 * user is logged out by an outage and has to run the whole OAuth flow again once it lifts.
 */
function toConnectionResult(
  service: Service,
  cookieName: string,
  breaker: Breaker,
  quota: QuotaLimit,
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

  // The service told us to back off - stop calling it until it resets, but keep the credentials.
  if (statusCode === quota.status) {
    const clearsAt = quota.retryAt();
    breaker.open(
      `${service} reported its quota exhausted while validating the connection`,
      clearsAt,
    );
    return unavailableResult(service, clearsAt, statusCode);
  }

  // Genuine API-health failure (5xx / network) - this is what the circuit breaker is for.
  res.clearCookie(cookieName);
  breaker.recordFailure(error);
  return {
    connected: false,
    error: `Unable to validate ${service} connection. Please try reconnecting.`,
    errorCode: statusCode,
  };
}

/** One sentence for a service that is up but refusing us, saying when to come back. */
function unavailableResult(
  service: Service,
  retryAt: Date,
  errorCode: string | number,
): ConnectionResult {
  return {
    connected: false,
    unavailable: true,
    retryAt,
    error: `${service} is not accepting requests right now. Try again ${describeRetryWait(retryAt)}.`,
    errorCode,
  };
}

/**
 * Refuse to call a service the breaker has already given up on.
 *
 * The tokens stay. Clearing them here is what turned a temporary limit into a lockout: every page
 * load through an open breaker cleared the cookie again, so the user was shown as disconnected
 * and sent to reconnect - down a path that needed the very service that was refusing.
 */
function breakerOpenResult(service: Service, breaker: Breaker, retryAt: Date): ConnectionResult {
  Logger.auth(service, 'circuit breaker is OPEN, reporting unavailable', {
    state: breaker.getState(),
    retryAt: retryAt.toISOString(),
  });
  return unavailableResult(service, retryAt, 'CIRCUIT_BREAKER_OPEN');
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
    return breakerOpenResult(
      'Spotify',
      spotifyCircuitBreaker,
      breakerRetryAt(spotifyCircuitBreaker),
    );
  }

  const outcome = await resolveSpotifyToken(spotifyTokens, res);
  // Spotify's 429 is a short throttle, so its own reset window is the honest answer.
  return toConnectionResult(
    'Spotify',
    'spotify_tokens',
    spotifyCircuitBreaker,
    { status: 429, retryAt: () => breakerRetryAt(spotifyCircuitBreaker) },
    outcome,
    res,
  );
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
    return breakerOpenResult('YouTube', youtubeCircuitBreaker, dailyQuotaResetAt());
  }

  // probe: this endpoint exists to say whether YouTube is working for this user, which a token's
  // own expiry cannot answer. The call is how quota exhaustion and API health reach the breaker.
  const outcome = await resolveYouTubeToken(youtubeTokens, res, { probe: true });
  // A YouTube 403 on the daily quota lasts until midnight Pacific, not until the breaker's next
  // probe - so the breaker's window would tell the user to come back in fifteen minutes, all night.
  return toConnectionResult(
    'YouTube',
    'youtube_tokens',
    youtubeCircuitBreaker,
    { status: 403, retryAt: () => dailyQuotaResetAt() },
    outcome,
    res,
  );
}
