/**
 * A panel discovering the session is gone has to tell the connection button.
 *
 * The button loads once and never polls - correct, since the server holds no session state and
 * polling would re-check a connection nobody is using. The cost was that it kept saying "Connected"
 * above a panel already offering a Reconnect link, until the page was reloaded by hand.
 *
 * The response header is the whole mechanism: HTMX turns it into an event, and the button re-runs
 * the probe it already had.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { authExpiredEvent } from '@/auth/authExpired';

const h = vi.hoisted(() => ({ ensureValidSpotifyToken: vi.fn() }));

vi.mock('@/spotify/auth', async (importActual) => ({
  ...(await importActual<typeof import('@/spotify/auth')>()),
  ensureValidSpotifyToken: h.ensureValidSpotifyToken,
}));

import { createApp } from '@/app';
import { testServer } from '@tests/helpers/testServer';

const app = testServer(createApp());
const spotifyCookie = `spotify_tokens=${JSON.stringify({
  accessToken: 'at',
  refreshToken: 'rt',
})}`;

beforeEach(() => vi.clearAllMocks());

describe('the reconnect prompt', () => {
  it('names the event for the service that expired', () => {
    expect(authExpiredEvent('Spotify')).toBe('auth-expired-spotify');
    expect(authExpiredEvent('YouTube')).toBe('auth-expired-youtube');
  });

  it('tells the page to re-probe when a panel finds the session gone', async () => {
    h.ensureValidSpotifyToken.mockRejectedValue(new Error('SPOTIFY_AUTH_REQUIRED'));

    const response = await request(app)
      .get('/auth/spotify/playlists')
      .set('Cookie', [spotifyCookie]);

    expect(response.status).toBe(401);
    expect(response.headers['hx-trigger']).toBe('auth-expired-spotify');
    expect(response.text).toContain('Reconnect to Spotify');
  });

  it('says nothing when the request succeeds', async () => {
    // A stray event would re-probe on every page interaction, which is the polling this design
    // deliberately avoids.
    h.ensureValidSpotifyToken.mockResolvedValue('at');

    const response = await request(app)
      .get('/auth/spotify/playlists')
      .set('Cookie', [spotifyCookie]);

    expect(response.headers['hx-trigger']).toBeUndefined();
  });
});

describe('the connection buttons', () => {
  const index = fs.readFileSync(path.join(__dirname, '../../views/index.ejs'), 'utf-8');

  it.each([
    ['spotify', 'Spotify'],
    ['youtube', 'YouTube'],
  ])('has %s listening for its own expiry event', (slug, service) => {
    // Listening per service, so one service expiring does not re-probe the other. `from:body`
    // because HTMX fires the header's event there, not on the button.
    const div = index.match(new RegExp(`<div id="${slug}-status"[\\s\\S]*?>`))?.[0] ?? '';

    expect(div).toContain(`hx-trigger="load, ${authExpiredEvent(service as 'Spotify')} from:body"`);
  });
});
