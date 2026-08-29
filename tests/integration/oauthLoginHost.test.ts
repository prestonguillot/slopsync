/**
 * A login must be served from the host the provider calls back to.
 *
 * The state cookie is scoped to the host that set it, and `localhost` and `127.0.0.1` are different
 * hosts to a browser. Starting the connect on the one that is not registered as the redirect URI
 * mints a cookie the callback can never read, so the connect fails - every time, while looking
 * intermittent, because the failure redirect lands the browser on the OTHER host and the retry
 * then works.
 *
 * Both services register a redirect URI, so both have this failure mode.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { testServer } from '@tests/helpers/testServer';
import { findSetCookie } from '@tests/helpers/httpCookies';

const app = testServer(createApp());

// Credentials as well as redirect URIs: the on-the-right-host case builds a real authorize URL,
// and the builders throw without them - which would look like the route failing.
const ENV = {
  SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:3000/auth/spotify/callback',
  YOUTUBE_REDIRECT_URI: 'http://127.0.0.1:3000/auth/youtube/callback',
  SPOTIFY_CLIENT_ID: 'test-spotify-client',
  YOUTUBE_CLIENT_ID: 'test-youtube-client',
  YOUTUBE_CLIENT_SECRET: 'test-youtube-secret',
} as const;

const ORIGINAL = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));

beforeEach(() => {
  Object.assign(process.env, ENV);
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe.each([
  ['youtube', 'youtube_oauth_state'],
  ['spotify', 'spotify_oauth_state'],
])('GET /auth/%s/login', (service, stateCookie) => {
  const login = (host: string) => request(app).get(`/auth/${service}/login`).set('Host', host);

  it('sends a login started on the wrong host to the callback host first', async () => {
    const res = await login('localhost:3000');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`http://127.0.0.1:3000/auth/${service}/login`);
  });

  it('sets no state cookie on the wrong host', async () => {
    // The point of redirecting first. A cookie set here is one the callback cannot read, and
    // issuing it anyway would burn the user's attempt exactly as before.
    const res = await login('localhost:3000');

    expect(findSetCookie(res, stateCookie)).toBeUndefined();
  });

  it('issues the state and goes to the provider when already on the callback host', async () => {
    const res = await login('127.0.0.1:3000');

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\//);
    expect(findSetCookie(res, stateCookie)).toBeDefined();
  });
});
