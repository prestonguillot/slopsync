import { Response } from 'express';
import { z } from 'zod';
import { SpotifyTokens, YouTubeTokens } from '../types/oauth';
import { Logger } from '../lib/logger';

/**
 * Cookie configuration for authentication tokens
 */
export function getSecureCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'strict' as const, // Strict CSRF protection
  };
}

/**
 * Zod schemas for validating OAuth tokens
 */
export const SpotifyTokensSchema = z.object({
  accessToken: z.string().min(1, 'Access token must not be empty'),
  refreshToken: z.string().min(1, 'Refresh token must not be empty'),
});

export const YouTubeTokensSchema = z.object({
  access_token: z.string().min(1, 'Access token must not be empty'),
  refresh_token: z.string().optional(),
  scope: z.string().min(1, 'Scope must not be empty'),
  token_type: z.string().min(1, 'Token type must not be empty'),
  expiry_date: z.number().optional(),
});

/**
 * Helper function to validate and serialize tokens for cookie storage
 */
export function validateAndSerializeSpotifyTokens(tokens: unknown): string {
  const validated = SpotifyTokensSchema.parse(tokens);
  return JSON.stringify(validated);
}

/**
 * Helper function to validate and serialize YouTube tokens for cookie storage
 */
export function validateAndSerializeYouTubeTokens(tokens: unknown): string {
  const validated = YouTubeTokensSchema.parse(tokens);
  return JSON.stringify(validated);
}

/**
 * Safely parse Spotify token from cookie
 * - Validates JSON parsing
 * - Validates against schema
 * - Clears cookie on failure
 * - Logs warnings for suspicious activity
 */
export function parseSpotifyTokenCookie(
  cookieValue: string | undefined,
  res?: Response,
): SpotifyTokens | null {
  if (!cookieValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(cookieValue);
    const validated = SpotifyTokensSchema.parse(parsed);
    return validated;
  } catch (error) {
    Logger.warn('Failed to parse Spotify token cookie - possible malicious activity', {
      error: error instanceof Error ? error.message : 'Unknown error',
      cookiePresent: !!cookieValue,
    });

    // Clear the corrupted cookie
    if (res) {
      res.clearCookie('spotify_tokens');
    }

    return null;
  }
}

/**
 * Safely parse YouTube token from cookie
 * - Validates JSON parsing
 * - Validates against schema
 * - Clears cookie on failure
 * - Logs warnings for suspicious activity
 */
export function parseYouTubeTokenCookie(
  cookieValue: string | undefined,
  res?: Response,
): YouTubeTokens | null {
  if (!cookieValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(cookieValue);
    const validated = YouTubeTokensSchema.parse(parsed);
    return validated;
  } catch (error) {
    Logger.warn('Failed to parse YouTube token cookie - possible malicious activity', {
      error: error instanceof Error ? error.message : 'Unknown error',
      cookiePresent: !!cookieValue,
    });

    // Clear the corrupted cookie
    if (res) {
      res.clearCookie('youtube_tokens');
    }

    return null;
  }
}
