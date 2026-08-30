/**
 * The reconnect frame for a session that has run out.
 *
 * ensureValidSpotifyToken / ensureValidYouTubeToken throw SPOTIFY_AUTH_REQUIRED and
 * YOUTUBE_AUTH_REQUIRED to say "this user has to connect again". Only the sync stream ever answered
 * that; every other route let it fall through to a generic handler and rendered "something went
 * wrong, please try again" - which is not something trying again fixes, and never offers the one
 * action that does.
 */

import { Response } from 'express';

export interface AuthExpired {
  service: 'Spotify' | 'YouTube';
  /**
   * Where to reconnect. The partial links it, so rendering without it throws and express turns
   * that into a 500 - an expired session reported as a crash.
   */
  loginUrl: string;
}

/**
 * The event name the connection buttons listen for, so one re-probes when a panel discovers the
 * session is gone.
 *
 * The button loads once and never polls, which is right - the server holds no session state and
 * polling would only re-check a connection nobody is using. But it means the button keeps saying
 * "Connected" long after a panel has rendered a reconnect prompt underneath it, until the page is
 * reloaded by hand. Naming the event per service keeps the other button from re-fetching for a
 * service that is fine.
 */
export const authExpiredEvent = (service: AuthExpired['service']): string =>
  `auth-expired-${service.toLowerCase()}`;

/**
 * Tell the page that this service's session is gone, alongside whatever the caller renders.
 *
 * HTMX fires the named event on receiving this header; the connection button listens for it and
 * re-runs the status probe it already had. Nothing is remembered server-side - the button asks
 * again and finds out for itself, which is the same thing a reload did, minus the reload.
 */
export function signalAuthExpired(res: Response, expired: AuthExpired): void {
  res.set('HX-Trigger', authExpiredEvent(expired.service));
}

/** What the caller must render, or null when this error is not an expired session. */
export function authExpired(error: unknown): AuthExpired | null {
  if (!(error instanceof Error)) return null;

  if (error.message === 'SPOTIFY_AUTH_REQUIRED') {
    return { service: 'Spotify', loginUrl: '/auth/spotify/login' };
  }
  if (error.message === 'YOUTUBE_AUTH_REQUIRED') {
    return { service: 'YouTube', loginUrl: '/auth/youtube/login' };
  }
  return null;
}
