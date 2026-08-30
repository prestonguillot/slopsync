/**
 * Hand-written Spotify Web API client (replaces the unmaintained
 * spotify-web-api-node, which still calls endpoints Spotify removed in its
 * Feb 2026 Development-Mode migration).
 *
 * Stateless: every call takes the access token (or, for the token endpoints,
 * reads client credentials from the environment) and returns clean typed domain
 * objects - no `.body` wrapper. Errors throw SpotifyApiError carrying the HTTP
 * status so callers can branch on 401/403/429.
 *
 * Specs verified against the official docs (June 2026), incl. the Feb 2026 changes:
 * - Token endpoints use HTTP Basic auth + form-urlencoded bodies.
 * - refresh_token is OPTIONAL on refresh; reuse the existing one when absent.
 * - Playlist track-count object was renamed tracks -> items in Dev Mode; read
 *   `items.total ?? tracks.total` for compatibility with both modes.
 * - Web API errors use the envelope { error: { status, message } }; account
 *   (token) errors use { error, error_description }.
 */

import { Logger } from '../lib/logger';

const ACCOUNTS_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';

/** Error from a Spotify API or token call, carrying the HTTP status. */
export class SpotifyApiError extends Error {
  readonly status: number;
  readonly body?: string;
  /** Seconds to wait before retrying, parsed from the Retry-After header (429/503). */
  readonly retryAfter?: number;
  constructor(message: string, status: number, body?: string, retryAfter?: number) {
    super(message);
    this.name = 'SpotifyApiError';
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

/**
 * Spotify answered 200 with a body that contradicts itself: a non-zero total, and no items.
 *
 * Its own name, because the two things it sits between are indistinguishable without it. An empty
 * account is this same shape minus the total, and a real API failure never reaches here at all - so
 * returning an empty list would render "you have no playlists" to someone who has sixty-three.
 */
export class SpotifyIncompleteResponseError extends Error {
  readonly reportedTotal: number;
  constructor(reportedTotal: number) {
    super(`Spotify reported ${reportedTotal} playlists but returned none`);
    this.name = 'SpotifyIncompleteResponseError';
    this.reportedTotal = reportedTotal;
  }
}

/**
 * Does this token-endpoint failure mean Spotify is unavailable, rather than the token being dead?
 *
 * RFC 6749 §5.2 defines `temporarily_unavailable` and `server_error` as "the authorization server
 * is overloaded or currently down". Neither says anything about the token. Read as an auth failure
 * they send the user to re-authorize an account that is fine - during the one window where the
 * re-authorization cannot succeed either.
 */
export function isSpotifyUpstreamFailure(error: unknown): boolean {
  if (!(error instanceof SpotifyApiError)) return false;
  if (error.status >= 500) return true;
  return /\b(?:temporarily_unavailable|server_error)\b/.test(error.body ?? '');
}

/** Parses a Retry-After header (delay in seconds, or an HTTP date) into seconds. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.max(0, Math.round((when - Date.now()) / 1000));
  return undefined;
}

export interface SpotifyTokenSet {
  accessToken: string;
  /** Absent on some refreshes - callers reuse their stored token when so. */
  refreshToken?: string;
  expiresIn: number;
  scope: string;
  tokenType: string;
}

export interface SpotifyUser {
  id: string;
  displayName: string | null;
}

export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  ownerId: string | null;
  /** null when Spotify omits the count (Dev Mode strips it from /me/playlists). */
  trackTotal: number | null;
  spotifyUrl: string;
  /** Playlist cover URL. undefined when Spotify omits images (e.g. Dev Mode). */
  coverImage?: string;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  ownerId: string | null;
  trackTotal: number | null;
  spotifyUrl: string;
}

// --- Raw response shapes (only the fields we read) ---

interface RawTokenResponse {
  access_token: string;
  token_type: string;
  scope?: string;
  expires_in: number;
  refresh_token?: string;
}

interface RawCountObject {
  total?: number;
}
interface RawPlaylistObject {
  id: string;
  name: string;
  owner?: { id?: string };
  external_urls?: { spotify?: string };
  images?: Array<{ url?: string }>;
  // Dev Mode renamed `tracks` -> `items`; accept either.
  tracks?: RawCountObject;
  items?: RawCountObject;
}
interface RawPlaylistsPage {
  items?: Array<RawPlaylistObject | null>;
  next?: string | null;
  total?: number;
}
interface RawUser {
  id: string;
  display_name?: string | null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function basicAuthHeader(): string {
  const clientId = requireEnv('SPOTIFY_CLIENT_ID');
  const clientSecret = requireEnv('SPOTIFY_CLIENT_SECRET');
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

/** Reads the count from either the new `items` object or the legacy `tracks`. */
function readTrackTotal(p: RawPlaylistObject): number | null {
  const total = p.items?.total ?? p.tracks?.total;
  return typeof total === 'number' ? total : null;
}

function toPlaylistSummary(p: RawPlaylistObject): SpotifyPlaylistSummary {
  return {
    id: p.id,
    name: p.name,
    ownerId: p.owner?.id ?? null,
    trackTotal: readTrackTotal(p),
    spotifyUrl: p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${p.id}`,
    coverImage: p.images?.[0]?.url,
  };
}

// --- Token endpoints ---

/** Builds the Authorization Code flow authorize URL to redirect the user to. */
export function getAuthorizeUrl(scopes: string[], state: string, showDialog = false): string {
  const params = new URLSearchParams({
    client_id: requireEnv('SPOTIFY_CLIENT_ID'),
    response_type: 'code',
    redirect_uri: requireEnv('SPOTIFY_REDIRECT_URI'),
    state,
    scope: scopes.join(' '),
  });
  if (showDialog) params.set('show_dialog', 'true');
  return `${ACCOUNTS_BASE}/authorize?${params.toString()}`;
}

async function tokenRequest(body: URLSearchParams): Promise<SpotifyTokenSet> {
  const response = await fetch(`${ACCOUNTS_BASE}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfter = parseRetryAfter(retryAfterHeader);
    // Account errors use { error, error_description }.
    let message = `Spotify token request failed: HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      if (parsed.error_description || parsed.error) {
        message = `Spotify token request failed: ${parsed.error_description || parsed.error}`;
      }
    } catch {
      /* non-JSON body */
    }
    if (response.status === 429) {
      Logger.warn('Spotify token endpoint rate limited', {
        retryAfterSeconds: retryAfter ?? null,
        retryAfterHeader,
      });
    }
    // The status, not just the parsed body. `message` is overwritten above whenever the body
    // carries an OAuth error code, so a 503 reads as bare "temporarily_unavailable" with nothing
    // to say it was a 503 - which is how an outage had to be confirmed by hand with curl.
    Logger.warn('Spotify token request failed', {
      status: response.status,
      url: `${ACCOUNTS_BASE}/api/token`,
      body: text.slice(0, 300),
    });
    throw new SpotifyApiError(message, response.status, text, retryAfter);
  }

  const data = JSON.parse(text) as RawTokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // may be undefined on refresh
    expiresIn: data.expires_in,
    scope: data.scope ?? '',
    tokenType: data.token_type,
  };
}

/** Exchanges an authorization code for an access + refresh token. */
export function exchangeCodeForTokens(code: string): Promise<SpotifyTokenSet> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: requireEnv('SPOTIFY_REDIRECT_URI'),
    }),
  );
}

/**
 * Refreshes an access token. The response may omit refresh_token - callers must
 * fall back to the token they already hold when `refreshToken` is undefined.
 */
export function refreshAccessToken(refreshToken: string): Promise<SpotifyTokenSet> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );
}

// --- Web API endpoints ---

async function apiGet<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfter = parseRetryAfter(retryAfterHeader);
    let message = `Spotify API request failed: HTTP ${response.status} (${path})`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message)
        message = `Spotify API error (${response.status}): ${parsed.error.message}`;
    } catch {
      /* non-JSON body */
    }
    if (response.status === 429) {
      Logger.warn('Spotify rate limited', {
        path,
        retryAfterSeconds: retryAfter ?? null,
        retryAfterHeader,
      });
    }
    throw new SpotifyApiError(message, response.status, text, retryAfter);
  }

  return (await response.json()) as T;
}

/** GET /v1/me - current user's profile (id + display name). */
export async function getCurrentUser(accessToken: string): Promise<SpotifyUser> {
  const raw = await apiGet<RawUser>('/me', accessToken);
  return { id: raw.id, displayName: raw.display_name ?? null };
}

/** GET /v1/me/playlists - all of the current user's playlists, paginated. */
export async function getUserPlaylists(accessToken: string): Promise<SpotifyPlaylistSummary[]> {
  const all: SpotifyPlaylistSummary[] = [];
  const limit = 50; // API maximum
  let offset = 0;
  let reportedTotal: number | null = null;

  while (true) {
    const page = await apiGet<RawPlaylistsPage>(
      `/me/playlists?limit=${limit}&offset=${offset}`,
      accessToken,
    );
    const rawItems = page.items ?? [];
    // Spotify can return null entries for deleted/unavailable playlists.
    const items = rawItems.filter((p): p is RawPlaylistObject => p != null);
    all.push(...items.map(toPlaylistSummary));
    reportedTotal ??= page.total ?? null;

    // Dropping an entry silently makes a short list look like the whole list, and an empty one
    // indistinguishable from an account with no playlists.
    if (items.length < rawItems.length) {
      Logger.warn('Spotify returned null playlist entries', {
        offset,
        reportedTotal,
        returned: rawItems.length,
        usable: items.length,
      });
    }

    // Terminate on `next`, and guard on the RAW page length. Testing the null-filtered length here
    // silently truncated the list: a page whose entries are all deleted/unavailable filters to
    // empty and would stop pagination even though `next` still points at more playlists.
    if (!page.next || rawItems.length === 0) break;
    offset += limit;
  }

  // Spotify saying it holds playlists while handing back none is the difference between an empty
  // account and a broken response; without the total, both arrive here as zero. Thrown rather than
  // logged and returned: the caller renders a list, and an empty one reads as an emptied account.
  if (all.length === 0 && (reportedTotal ?? 0) > 0) {
    Logger.warn('Spotify reports playlists but returned none', { reportedTotal });
    throw new SpotifyIncompleteResponseError(reportedTotal!);
  }

  Logger.debug('Fetched Spotify user playlists', { count: all.length, reportedTotal });
  return all;
}

/** GET /v1/playlists/{id} - a single playlist's metadata. */
export async function getPlaylist(
  accessToken: string,
  playlistId: string,
): Promise<SpotifyPlaylist> {
  const raw = await apiGet<RawPlaylistObject>(
    `/playlists/${encodeURIComponent(playlistId)}`,
    accessToken,
  );
  return {
    id: raw.id,
    name: raw.name,
    ownerId: raw.owner?.id ?? null,
    trackTotal: readTrackTotal(raw),
    spotifyUrl: raw.external_urls?.spotify ?? `https://open.spotify.com/playlist/${raw.id}`,
  };
}
