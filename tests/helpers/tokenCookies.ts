/**
 * Token cookies shaped the way this app actually writes them.
 *
 * `expiry_date` is the field that matters and the one hand-written fixtures kept leaving out: it is
 * set on the code exchange and on every refresh, and the auth path reads it to decide whether a
 * token can be used as-is, needs refreshing, or has to be asked about. A fixture without it
 * describes a cookie that has never existed outside a test, and sends the code down a branch kept
 * only for cookies written before the field was stored.
 */

interface YouTubeTokenOverrides {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  /** Milliseconds from now. Negative for a token that has already expired. */
  expiresInMs?: number;
}

/** The `youtube_tokens` cookie value, as a live connection would hold it. */
export function youtubeTokenCookie({
  access_token = 'yt-access',
  refresh_token = 'yt-refresh',
  scope = 'https://www.googleapis.com/auth/youtube',
  token_type = 'Bearer',
  expiresInMs = 3_600_000,
}: YouTubeTokenOverrides = {}): string {
  return `youtube_tokens=${JSON.stringify({
    access_token,
    refresh_token,
    scope,
    token_type,
    expiry_date: Date.now() + expiresInMs,
  })}`;
}

/** The `spotify_tokens` cookie value. Spotify's cookie carries no expiry; its client refreshes on a 401. */
export const spotifyTokenCookie = (
  accessToken = 'sp-access',
  refreshToken = 'sp-refresh',
): string => `spotify_tokens=${JSON.stringify({ accessToken, refreshToken })}`;
