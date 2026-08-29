/**
 * OAuth `state` CSRF protection, shared by the provider login/callback flows.
 *
 * Without it, an attacker can trick a victim's browser into completing the connect with the
 * ATTACKER's authorization code, binding the attacker's account to the victim's session
 * (login-CSRF / account fixation). Spotify had this; YouTube did not.
 *
 * SameSite=lax (not strict) is deliberate: the callback is a cross-site top-level navigation back
 * from the provider, and Strict would withhold the cookie there, so verification would fail every
 * time.
 */

import { Request, Response } from 'express';
import { generateCsrfToken } from './csrf';
import { Logger } from '../lib/logger';

/**
 * Where a login has to be served from for its state cookie to survive the round trip.
 *
 * The provider always calls back to the registered redirect URI's hostname. Cookies are scoped per
 * hostname, and `localhost` and `127.0.0.1` are different hostnames to a browser however identical
 * they look - so a login started on the other one mints a cookie the callback can never read, and
 * the connect fails every time. Sending the browser to the callback's own hostname first means the
 * cookie is set where it will be read.
 *
 * Compared on hostname, not host: cookies ignore the port, so a login on a different port still
 * hands its cookie to the callback. Redirecting for a port difference would move the browser off
 * whatever port the app is actually reachable on for no gain.
 *
 * The destination comes from this app's own configured redirect URI, never from the request, so a
 * caller cannot steer it.
 *
 * @param req the login request
 * @param redirectUri the provider's registered redirect URI
 * @returns the URL to send the browser to first, or undefined when it is already in the right place
 */
export function canonicalLoginUrl(
  req: Request,
  redirectUri: string | undefined,
): string | undefined {
  if (!redirectUri) return undefined;

  const parse = (url: string): URL | undefined => {
    try {
      return new URL(url);
    } catch {
      return undefined;
    }
  };

  const callback = parse(redirectUri);
  if (!callback) {
    // A redirect URI we cannot parse is a configuration problem, but failing the login over it
    // would turn a wrong-host warning into a dead connect button.
    Logger.warn('OAuth redirect URI is not a valid URL; cannot canonicalize the login host');
    return undefined;
  }

  const requestHostname = parse(`http://${req.headers.host ?? ''}`)?.hostname;
  if (!requestHostname || requestHostname === callback.hostname) return undefined;

  return `${callback.protocol}//${callback.host}${req.originalUrl}`;
}

const stateCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 10 * 60 * 1000, // 10 minutes
  path: '/',
});

/**
 * Mints a random state, stores it in a one-time cookie, and returns it for the authorize URL.
 *
 * (Spotify additionally REQUIRES a non-empty state: its authorize endpoint renders a generic
 * error page for an authenticated user when `state=` is present but empty.)
 */
export function issueOAuthState(res: Response, cookieName: string): string {
  const state = generateCsrfToken();
  res.cookie(cookieName, state, stateCookieOptions());
  return state;
}

/**
 * Verifies a callback's state against the one-time cookie. The cookie is single-use, so it is
 * cleared regardless of outcome. Returns false when the caller should reject the callback.
 */
export function verifyOAuthState(
  req: Request,
  res: Response,
  cookieName: string,
  receivedState: string | undefined,
  service: string,
): boolean {
  const expectedState = req.cookies?.[cookieName];
  res.clearCookie(cookieName, { path: '/' });

  if (!expectedState || !receivedState || receivedState !== expectedState) {
    Logger.warn(`${service} callback rejected - OAuth state mismatch`, {
      hasExpectedState: !!expectedState,
      hasReceivedState: !!receivedState,
    });
    return false;
  }
  return true;
}
