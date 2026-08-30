/**
 * The single Spotify token validate/refresh/rewrite path.
 *
 * Validates an access token with a lightweight /me call; on 401 it refreshes (reusing the stored
 * refresh token when Spotify doesn't return a new one), rewrites the cookie, and reports what
 * happened. Both callers go through resolveSpotifyToken and differ only at the edges:
 * ensureValidSpotifyToken (per-request, throws) and validateSpotifyConnection (status endpoint,
 * returns a ConnectionResult and owns the circuit breaker).
 */

import { Request, Response } from 'express';
import {
  getCurrentUser,
  refreshAccessToken,
  SpotifyApiError,
  isSpotifyUpstreamFailure,
} from './client';
import {
  getSecureCookieOptions,
  parseSpotifyTokenCookie,
  validateAndSerializeSpotifyTokens,
} from '../auth/cookieParser';
import { SpotifyTokens, TokenOutcome } from '../types/oauth';
import { Logger } from '../lib/logger';

/**
 * Resolve a usable Spotify access token, refreshing and rewriting the cookie if needed.
 * Never throws for an API rejection - the outcome says what happened, so each caller decides
 * whether that means "reconnect", "back off", or "report an error".
 */
export async function resolveSpotifyToken(
  tokens: SpotifyTokens,
  res: Response,
): Promise<TokenOutcome> {
  try {
    await getCurrentUser(tokens.accessToken);
    return { status: 'valid', accessToken: tokens.accessToken };
  } catch (error: unknown) {
    const statusCode = error instanceof SpotifyApiError ? error.status : undefined;

    // 401 = the access token expired/was rejected - routine and refreshable, NOT an API-health
    // failure. Anything else is about Spotify itself and is reported as-is.
    if (statusCode !== 401) {
      return { status: 'error', statusCode, error };
    }

    if (!tokens.refreshToken) {
      return { status: 'expired', error };
    }

    Logger.auth('Spotify', 'token expired, refreshing');
    try {
      const refreshed = await refreshAccessToken(tokens.refreshToken);
      const updated = {
        accessToken: refreshed.accessToken,
        // Spotify may not return a new refresh token; reuse the stored one.
        refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      };
      // Validate before storing: a cookie written straight from a refresh response is exactly
      // where a malformed token would otherwise be persisted unnoticed.
      res.cookie(
        'spotify_tokens',
        validateAndSerializeSpotifyTokens(updated),
        getSecureCookieOptions(),
      );
      Logger.auth('Spotify', 'token refreshed successfully');
      return { status: 'refreshed', accessToken: updated.accessToken };
    } catch (refreshError) {
      Logger.error('Failed to refresh Spotify token', {}, refreshError);
      // A refresh that failed because Spotify is down says nothing about the token. Calling that
      // 'expired' asks the user to reconnect, which is both wrong and impossible while the auth
      // service is the thing that is broken.
      if (isSpotifyUpstreamFailure(refreshError)) {
        const statusCode =
          refreshError instanceof SpotifyApiError ? refreshError.status : undefined;
        return { status: 'error', statusCode, error: refreshError };
      }
      return { status: 'expired', error: refreshError };
    }
  }
}

/**
 * The access token for this request, refreshing it if needed.
 * Throws Error('SPOTIFY_AUTH_REQUIRED') when the user must reconnect.
 */
export async function ensureValidSpotifyToken(req: Request, res: Response): Promise<string> {
  const tokens = parseSpotifyTokenCookie(req.cookies.spotify_tokens, res);
  if (!tokens) {
    throw new Error('SPOTIFY_AUTH_REQUIRED');
  }

  const outcome = await resolveSpotifyToken(tokens, res);
  if (outcome.status === 'valid' || outcome.status === 'refreshed') {
    return outcome.accessToken;
  }
  // 'error' is Spotify being unreachable, throttled or broken - not the user's session. Rethrown
  // as itself so callers branch on its status (503 -> "Spotify is temporarily unavailable") rather
  // than offering a reconnect that fixes nothing.
  if (outcome.status === 'error') {
    throw outcome.error;
  }
  throw new Error('SPOTIFY_AUTH_REQUIRED', { cause: outcome.error });
}
