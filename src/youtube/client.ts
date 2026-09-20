/**
 * Hand-written YouTube Data API v3 client (replaces the 202 MB googleapis monolith,
 * of which we used 7 endpoints + OAuth refresh).
 *
 * createYoutubeClient(accessToken) returns an object whose method surface mirrors
 * the slice of googleapis we used (channels.list, playlists.list/insert,
 * playlistItems.list/insert/update/delete), each resolving to `{ data }` - so the
 * existing call sites and the helpers that receive a `youtube` object keep working.
 * Errors throw YoutubeApiError carrying `.code` (HTTP status, matching the old
 * googleapis error.code checks) and `.reason` (e.g. quotaExceeded).
 *
 * Specs verified against the official YouTube Data API v3 + Google OAuth docs:
 * - reads (*.list) cost 1 quota unit; writes (insert/update/delete) cost 50.
 * - playlistItems.update is a full PUT (resend snippet.playlistId + resourceId).
 * - delete returns 204 (empty body).
 * - OAuth refresh: POST oauth2.googleapis.com/token (form-urlencoded); no new
 *   refresh_token is returned - reuse the stored one.
 * - YouTube errors: { error: { code, message, errors: [{ reason }] } };
 *   OAuth errors: { error, error_description }. 401 -> refresh+retry; 403
 *   quotaExceeded -> do not retry.
 */

import { Logger } from '../lib/logger';

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Error from a YouTube Data API call. `code` is the HTTP status (matches the old googleapis error.code). */
export class YoutubeApiError extends Error {
  readonly code: number;
  readonly reason?: string;
  constructor(message: string, code: number, reason?: string) {
    super(message);
    this.name = 'YoutubeApiError';
    this.code = code;
    this.reason = reason;
  }
}

// --- Minimal typed resource shapes (only the fields we read) ---

export interface YtChannel {
  id?: string;
  snippet?: { title?: string };
}
export interface YtChannelListResponse {
  items?: YtChannel[];
}

export interface YtPlaylist {
  id?: string;
  snippet?: { title?: string; description?: string };
  contentDetails?: { itemCount?: number };
}
export interface YtPlaylistListResponse {
  items?: YtPlaylist[];
  nextPageToken?: string;
}

export interface YtResourceId {
  kind?: string;
  videoId?: string;
}
export interface YtThumbnail {
  url?: string;
  width?: number;
  height?: number;
}
export interface YtPlaylistItem {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    position?: number;
    playlistId?: string;
    channelTitle?: string; // the playlist owner's channel - NOT the video's uploader
    videoOwnerChannelTitle?: string; // the channel that actually uploaded the video
    publishedAt?: string;
    resourceId?: YtResourceId;
    thumbnails?: { default?: YtThumbnail; medium?: YtThumbnail; high?: YtThumbnail };
  };
}
export interface YtPlaylistItemListResponse {
  items?: YtPlaylistItem[];
  nextPageToken?: string;
}

const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Token fields returned by a code exchange (snake_case, ready to store in the cookie). */
export interface YouTubeOAuthTokens {
  access_token: string;
  refresh_token?: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}

/** Subset returned by a refresh (no new refresh_token; merge over the stored tokens). */
export interface YouTubeRefreshedTokens {
  access_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}

// --- HTTP core ---

async function youtubeRequest<T>(
  accessToken: string,
  method: string,
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  body?: unknown,
): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ''}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = `YouTube API request failed: HTTP ${response.status} (${method} ${path})`;
    let reason: string | undefined;
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string; errors?: Array<{ reason?: string }> };
      };
      if (parsed.error?.message)
        message = `YouTube API error (${response.status}): ${parsed.error.message}`;
      reason = parsed.error?.errors?.[0]?.reason;
    } catch {
      /* non-JSON body */
    }
    throw new YoutubeApiError(message, response.status, reason);
  }

  // delete returns 204 with no body
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const partOf = (part: string[] | undefined): string => (part ?? []).join(',');

// --- OAuth refresh ---

function requireYoutubeCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error('Missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET');
  return { clientId, clientSecret };
}

async function oauthTokenRequest(body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = `YouTube OAuth request failed: HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      if (parsed.error_description || parsed.error)
        message = `YouTube OAuth request failed: ${parsed.error_description || parsed.error}`;
    } catch {
      /* non-JSON */
    }
    // Surface as YoutubeApiError so callers' code-based refresh/auth handling fires.
    throw new YoutubeApiError(message, response.status);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** Builds the Google OAuth consent URL for the Authorization Code flow (offline access). */
export function getYoutubeAuthUrl(scopes: string[], state?: string): string {
  const { clientId } = requireYoutubeCreds();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: process.env.YOUTUBE_REDIRECT_URI ?? '',
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    // `consent` forces the consent screen so Google re-issues a refresh_token on every connect:
    // with only access_type=offline it returns one on the FIRST consent, so a reconnect gets no
    // refresh_token and the access token dies at its 1h expiry with no way to refresh.
    //
    // `select_account` makes the account explicit. Without it Google resolves the account from
    // whatever session the browser already has, which fails in a profile signed in to an account
    // that cannot authorize this app - and does so with a generic error, from a URL that is
    // otherwise valid. A signed-out browser is never asked to resolve anything, which is why the
    // flow completes in a private window and not in the everyday profile.
    prompt: 'select_account consent',
  });
  if (state) params.set('state', state);
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

/** Google's access tokens last an hour; used when a response omits expires_in. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

/**
 * Reads the access token out of an OAuth response, rejecting a response that has none.
 *
 * `String(data.access_token)` coerces a missing field to the literal string "undefined", which is
 * then stored in the cookie as a plausible-looking token and only surfaces much later as a
 * confusing 401 - far from the actual cause.
 */
function requireAccessToken(data: Record<string, unknown>, operation: string): string {
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new YoutubeApiError(
      `YouTube ${operation} response contained no access_token`,
      502,
      'invalidTokenResponse',
    );
  }
  return data.access_token;
}

/**
 * Seconds until the access token expires.
 *
 * A missing or garbage expires_in must not coerce to 0: that makes expiry_date === Date.now(), so
 * the token is born expired and every subsequent request treats it as stale and refreshes it.
 */
function tokenLifetimeSeconds(data: Record<string, unknown>, operation: string): number {
  const expiresIn = Number(data.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    Logger.warn(`YouTube ${operation} response had no usable expires_in - assuming default`, {
      received: data.expires_in,
      assumedSeconds: DEFAULT_TOKEN_LIFETIME_SECONDS,
    });
    return DEFAULT_TOKEN_LIFETIME_SECONDS;
  }
  return expiresIn;
}

/** Exchanges an authorization code for tokens (includes the refresh_token). */
export async function exchangeYoutubeCode(code: string): Promise<YouTubeOAuthTokens> {
  const { clientId, clientSecret } = requireYoutubeCreds();
  const data = await oauthTokenRequest(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.YOUTUBE_REDIRECT_URI ?? '',
    }),
  );
  return {
    access_token: requireAccessToken(data, 'code exchange'),
    refresh_token: data.refresh_token ? String(data.refresh_token) : undefined,
    scope: String(data.scope ?? ''),
    token_type: String(data.token_type ?? 'Bearer'),
    expiry_date: Date.now() + tokenLifetimeSeconds(data, 'code exchange') * 1000,
  };
}

/**
 * Refreshes a YouTube access token. Google does NOT return a new refresh token,
 * so callers merge the result over their stored tokens (keeping refresh_token).
 */
export async function refreshYoutubeAccessToken(
  refreshToken: string,
): Promise<YouTubeRefreshedTokens> {
  const { clientId, clientSecret } = requireYoutubeCreds();
  const data = await oauthTokenRequest(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );
  return {
    access_token: requireAccessToken(data, 'token refresh'),
    scope: String(data.scope ?? ''),
    token_type: String(data.token_type ?? 'Bearer'),
    expiry_date: Date.now() + tokenLifetimeSeconds(data, 'token refresh') * 1000,
  };
}

// --- Client (googleapis-compatible method surface) ---

export interface YoutubeClient {
  channels: {
    list(params: {
      part: string[];
      mine?: boolean;
      maxResults?: number;
    }): Promise<{ data: YtChannelListResponse }>;
  };
  playlists: {
    list(params: {
      part: string[];
      mine?: boolean;
      maxResults?: number;
      pageToken?: string;
    }): Promise<{ data: YtPlaylistListResponse }>;
    insert(params: {
      part: string[];
      requestBody: {
        snippet: { title: string; description?: string };
        status?: { privacyStatus: string };
      };
    }): Promise<{ data: YtPlaylist }>;
  };
  playlistItems: {
    list(params: {
      part: string[];
      playlistId: string;
      maxResults?: number;
      pageToken?: string;
    }): Promise<{ data: YtPlaylistItemListResponse }>;
    insert(params: {
      part: string[];
      requestBody: YtPlaylistItem;
    }): Promise<{ data: YtPlaylistItem }>;
    update(params: {
      part: string[];
      requestBody: YtPlaylistItem;
    }): Promise<{ data: YtPlaylistItem }>;
    delete(params: { id: string }): Promise<{ data: void }>;
  };
}

/** Build a YouTube client bound to an access token. Mirrors the googleapis surface we use. */
export function createYoutubeClient(accessToken: string): YoutubeClient {
  return {
    channels: {
      list: async ({ part, mine, maxResults }) => ({
        data: await youtubeRequest<YtChannelListResponse>(accessToken, 'GET', '/channels', {
          part: partOf(part),
          mine,
          maxResults,
        }),
      }),
    },
    playlists: {
      list: async ({ part, mine, maxResults, pageToken }) => ({
        data: await youtubeRequest<YtPlaylistListResponse>(accessToken, 'GET', '/playlists', {
          part: partOf(part),
          mine,
          maxResults,
          pageToken,
        }),
      }),
      insert: async ({ part, requestBody }) => ({
        data: await youtubeRequest<YtPlaylist>(
          accessToken,
          'POST',
          '/playlists',
          { part: partOf(part) },
          requestBody,
        ),
      }),
    },
    playlistItems: {
      list: async ({ part, playlistId, maxResults, pageToken }) => ({
        data: await youtubeRequest<YtPlaylistItemListResponse>(
          accessToken,
          'GET',
          '/playlistItems',
          {
            part: partOf(part),
            playlistId,
            maxResults,
            pageToken,
          },
        ),
      }),
      insert: async ({ part, requestBody }) => ({
        data: await youtubeRequest<YtPlaylistItem>(
          accessToken,
          'POST',
          '/playlistItems',
          { part: partOf(part) },
          requestBody,
        ),
      }),
      update: async ({ part, requestBody }) => ({
        data: await youtubeRequest<YtPlaylistItem>(
          accessToken,
          'PUT',
          '/playlistItems',
          { part: partOf(part) },
          requestBody,
        ),
      }),
      delete: async ({ id }) => ({
        data: await youtubeRequest<void>(accessToken, 'DELETE', '/playlistItems', { id }),
      }),
    },
  };
}
