import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getSecureCookieOptions,
  parseSpotifyTokenCookie,
  parseYouTubeTokenCookie,
  validateAndSerializeSpotifyTokens,
  validateAndSerializeYouTubeTokens,
} from '../../src/auth/cookieParser';
import { Logger } from '../../src/lib/logger';
import { Response } from 'express';

describe('Cookie Parser Utilities', () => {
  let mockRes: Partial<Response>;

  beforeEach(() => {
    mockRes = {
      clearCookie: vi.fn(),
    };
  });

  describe('parseSpotifyTokenCookie', () => {
    it('should parse valid Spotify token cookie', () => {
      const validTokens = {
        accessToken: 'valid_access_token_123',
        refreshToken: 'valid_refresh_token_456',
      };
      const cookieValue = JSON.stringify(validTokens);

      const result = parseSpotifyTokenCookie(cookieValue, mockRes as Response);

      expect(result).toEqual(validTokens);
      expect(mockRes.clearCookie).not.toHaveBeenCalled();
    });

    it('should return null for undefined cookie', () => {
      const result = parseSpotifyTokenCookie(undefined, mockRes as Response);

      expect(result).toBeNull();
      expect(mockRes.clearCookie).not.toHaveBeenCalled();
    });

    it('should return null and clear cookie for invalid JSON', () => {
      const invalidJson = 'not valid json {[}';

      const result = parseSpotifyTokenCookie(invalidJson, mockRes as Response);

      expect(result).toBeNull();
      expect(mockRes.clearCookie).toHaveBeenCalledWith('spotify_tokens');
    });

    it('should return null and clear cookie for invalid token structure', () => {
      const invalidStructure = JSON.stringify({
        accessToken: 'valid',
        // missing refreshToken
      });

      const result = parseSpotifyTokenCookie(invalidStructure, mockRes as Response);

      expect(result).toBeNull();
      expect(mockRes.clearCookie).toHaveBeenCalledWith('spotify_tokens');
    });

    it('should return null and clear cookie for empty tokens', () => {
      const emptyTokens = JSON.stringify({
        accessToken: '',
        refreshToken: 'token',
      });

      const result = parseSpotifyTokenCookie(emptyTokens, mockRes as Response);

      expect(result).toBeNull();
      expect(mockRes.clearCookie).toHaveBeenCalledWith('spotify_tokens');
    });

    it('should work without Response object provided', () => {
      const validTokens = {
        accessToken: 'valid_access_token_123',
        refreshToken: 'valid_refresh_token_456',
      };
      const cookieValue = JSON.stringify(validTokens);

      const result = parseSpotifyTokenCookie(cookieValue);

      expect(result).toEqual(validTokens);
    });

    it('should accept valid tokens even with extra properties', () => {
      // Extra properties are allowed by Zod and don't pose security risk
      const tokensWithExtra = JSON.stringify({
        accessToken: 'token_123',
        refreshToken: 'token_456',
        extraProperty: 'ignored',
      });

      const result = parseSpotifyTokenCookie(tokensWithExtra, mockRes as Response);

      expect(result).toEqual({
        accessToken: 'token_123',
        refreshToken: 'token_456',
      });
      expect(mockRes.clearCookie).not.toHaveBeenCalled();
    });

    it('should handle tokens with special characters safely', () => {
      const specialCharTokens = {
        accessToken: 'token_with_!@#$%^&*()_+-=[]{}|;:",.<>?/~`',
        refreshToken: 'another_token_with_special_chars',
      };
      const cookieValue = JSON.stringify(specialCharTokens);

      const result = parseSpotifyTokenCookie(cookieValue, mockRes as Response);

      expect(result).toEqual(specialCharTokens);
      expect(mockRes.clearCookie).not.toHaveBeenCalled();
    });
  });

  describe('parseYouTubeTokenCookie', () => {
    it('should parse valid YouTube token cookie', () => {
      const validTokens = {
        access_token: 'ya29.a0AfH6SMBx...',
        scope: 'https://www.googleapis.com/auth/youtube',
        token_type: 'Bearer',
        expiry_date: Date.now() + 3600000,
      };
      const cookieValue = JSON.stringify(validTokens);

      const result = parseYouTubeTokenCookie(cookieValue, mockRes as Response);

      expect(result).toEqual(validTokens);
      expect(mockRes.clearCookie).not.toHaveBeenCalled();
    });

    it('should parse YouTube token without optional refresh_token', () => {
      const validTokens = {
        access_token: 'ya29.a0AfH6SMBx...',
        scope: 'https://www.googleapis.com/auth/youtube',
        token_type: 'Bearer',
      };
      const cookieValue = JSON.stringify(validTokens);

      const result = parseYouTubeTokenCookie(cookieValue, mockRes as Response);

      expect(result).toEqual(validTokens);
      expect(mockRes.clearCookie).not.toHaveBeenCalled();
    });

    it('should return null for undefined cookie', () => {
      const result = parseYouTubeTokenCookie(undefined, mockRes as Response);

      expect(result).toBeNull();
      expect(mockRes.clearCookie).not.toHaveBeenCalled();
    });

    it('should return null and clear cookie for invalid JSON', () => {
      const invalidJson = 'this is not json at all';

      const result = parseYouTubeTokenCookie(invalidJson, mockRes as Response);

      expect(result).toBeNull();
      expect(mockRes.clearCookie).toHaveBeenCalledWith('youtube_tokens');
    });

    it('should return null and clear cookie for missing required fields', () => {
      const invalidStructure = JSON.stringify({
        access_token: 'token',
        // missing scope and token_type
      });

      const result = parseYouTubeTokenCookie(invalidStructure, mockRes as Response);

      expect(result).toBeNull();
      expect(mockRes.clearCookie).toHaveBeenCalledWith('youtube_tokens');
    });

    it('should return null and clear cookie for empty access_token', () => {
      const emptyToken = JSON.stringify({
        access_token: '',
        scope: 'https://www.googleapis.com/auth/youtube',
        token_type: 'Bearer',
      });

      const result = parseYouTubeTokenCookie(emptyToken, mockRes as Response);

      expect(result).toBeNull();
      expect(mockRes.clearCookie).toHaveBeenCalledWith('youtube_tokens');
    });

    it('should handle malicious array instead of object', () => {
      const maliciousArray = JSON.stringify(['access_token', 'scope', 'token_type']);

      const result = parseYouTubeTokenCookie(maliciousArray, mockRes as Response);

      expect(result).toBeNull();
      expect(mockRes.clearCookie).toHaveBeenCalledWith('youtube_tokens');
    });

    it('should work without Response object provided', () => {
      const validTokens = {
        access_token: 'ya29.a0AfH6SMBx...',
        scope: 'https://www.googleapis.com/auth/youtube',
        token_type: 'Bearer',
      };
      const cookieValue = JSON.stringify(validTokens);

      const result = parseYouTubeTokenCookie(cookieValue);

      expect(result).toEqual(validTokens);
    });

    it('should accept optional refresh_token and expiry_date', () => {
      const fullTokens = {
        access_token: 'ya29.a0AfH6SMBx...',
        refresh_token: '1//refresh_token_here',
        scope: 'https://www.googleapis.com/auth/youtube',
        token_type: 'Bearer',
        expiry_date: 1234567890,
      };
      const cookieValue = JSON.stringify(fullTokens);

      const result = parseYouTubeTokenCookie(cookieValue, mockRes as Response);

      expect(result).toEqual(fullTokens);
      expect(mockRes.clearCookie).not.toHaveBeenCalled();
    });
  });

  describe('Error logging', () => {
    it('should log warnings for parse failures', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const invalidJson = 'not json';

      parseSpotifyTokenCookie(invalidJson, mockRes as Response);

      // The Logger.warn should have been called (tested through behavior, not logging directly)
      // Actual verification happens through mockRes.clearCookie being called
      expect(mockRes.clearCookie).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });

    it('should identify malicious activity based on parse failure', () => {
      const maliciousPayload = 'DROP TABLE users; --';

      parseSpotifyTokenCookie(maliciousPayload, mockRes as Response);

      expect(mockRes.clearCookie).toHaveBeenCalledWith('spotify_tokens');
    });
  });
});

/**
 * The cookie options and the validating serializers.
 *
 * getSecureCookieOptions decides whether the OAuth tokens are readable by JavaScript and whether
 * they may travel over plain HTTP, so its every field is asserted rather than spot-checked.
 */
describe('getSecureCookieOptions', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('locks the token cookies down', () => {
    // Asserted whole. httpOnly keeps the tokens out of JS (the app's stated security model is that
    // OAuth tokens live in httpOnly cookies); sameSite:strict is the CSRF defence; a wrong maxAge
    // silently logs the user out.
    expect(getSecureCookieOptions()).toEqual({
      httpOnly: true,
      secure: false, // NODE_ENV is 'test'
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'strict',
    });
  });

  it('requires HTTPS in production', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(getSecureCookieOptions().secure).toBe(true);
  });

  it.each([['development'], ['test']])('does not require HTTPS in %s', (env) => {
    vi.stubEnv('NODE_ENV', env);

    expect(getSecureCookieOptions().secure).toBe(false);
  });
});

describe('validateAndSerializeSpotifyTokens', () => {
  it('serializes a valid pair to JSON', () => {
    const json = validateAndSerializeSpotifyTokens({
      accessToken: 'access',
      refreshToken: 'refresh',
    });

    expect(JSON.parse(json)).toEqual({ accessToken: 'access', refreshToken: 'refresh' });
  });

  // The point of the function: a refresh response is never written to a cookie unvalidated.
  it.each([
    ['an empty access token', { accessToken: '', refreshToken: 'refresh' }],
    ['a missing access token', { refreshToken: 'refresh' }],
    ['an empty refresh token', { accessToken: 'access', refreshToken: '' }],
    ['nothing at all', {}],
  ])('refuses to serialize %s', (_label, tokens) => {
    expect(() => validateAndSerializeSpotifyTokens(tokens)).toThrow();
  });

  it('strips unknown keys rather than storing them', () => {
    const json = validateAndSerializeSpotifyTokens({
      accessToken: 'access',
      refreshToken: 'refresh',
      somethingElse: 'should not survive',
    });

    expect(JSON.parse(json)).not.toHaveProperty('somethingElse');
  });
});

describe('validateAndSerializeYouTubeTokens', () => {
  const valid = {
    access_token: 'access',
    refresh_token: 'refresh',
    scope: 'https://www.googleapis.com/auth/youtube',
    token_type: 'Bearer',
  };

  it('serializes a valid token set to JSON', () => {
    expect(JSON.parse(validateAndSerializeYouTubeTokens(valid))).toMatchObject(valid);
  });

  // Cookies written before the channel id was dropped still parse; the field is simply not kept.
  it('drops a channel id left over from an older cookie', () => {
    const json = validateAndSerializeYouTubeTokens({ ...valid, channel_id: 'UC123' });

    expect(JSON.parse(json).channel_id).toBeUndefined();
    expect(JSON.parse(json).access_token).toBe(valid.access_token);
  });

  it('accepts a token set with no refresh token', () => {
    const { refresh_token: _drop, ...noRefresh } = valid;

    expect(() => validateAndSerializeYouTubeTokens(noRefresh)).not.toThrow();
  });

  it.each([
    ['an empty access token', { ...valid, access_token: '' }],
    ['no scope', { access_token: 'a', token_type: 'Bearer' }],
    ['no token_type', { access_token: 'a', scope: 's' }],
  ])('refuses to serialize %s', (_label, tokens) => {
    expect(() => validateAndSerializeYouTubeTokens(tokens)).toThrow();
  });
});

/**
 * The error path of the two parsers: what happens when a cookie is malformed.
 *
 * Two behaviours the earlier tests left unpinned. First, the parsers may be called with no Response
 * (auth checks that only read the token), so the `res.clearCookie(...)` on the failure path is
 * guarded by `if (res)` - without the guard, a malformed cookie on a res-less call would throw
 * instead of returning null. Second, the failure is logged as possible malicious activity, and that
 * diagnostic - the reason it failed, and that a cookie was in fact present - is the whole point of
 * the catch block.
 */
describe('malformed-cookie handling', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null without throwing when Spotify cookie is malformed and no res is given', () => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    expect(parseSpotifyTokenCookie('not json {[}')).toBeNull();
  });

  it('returns null without throwing when YouTube cookie is malformed and no res is given', () => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    expect(parseYouTubeTokenCookie('not json {[}')).toBeNull();
  });

  it('logs the Spotify parse failure with the reason and that a cookie was present', () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    parseSpotifyTokenCookie('not json {[}', { clearCookie: vi.fn() } as unknown as Response);

    expect(warn).toHaveBeenCalledWith(
      'Failed to parse Spotify token cookie - possible malicious activity',
      expect.objectContaining({ cookiePresent: true, error: expect.any(String) }),
    );
  });

  it('logs the YouTube parse failure with the reason and that a cookie was present', () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    parseYouTubeTokenCookie('not json {[}', { clearCookie: vi.fn() } as unknown as Response);

    expect(warn).toHaveBeenCalledWith(
      'Failed to parse YouTube token cookie - possible malicious activity',
      expect.objectContaining({ cookiePresent: true, error: expect.any(String) }),
    );
  });
});
