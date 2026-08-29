/**
 * Full-page captures of the real index.ejs - the assembled shell (header, connection cards,
 * playlist card, controls) that the isolated-partial captures never covered. The page lazy-loads
 * its data via HTMX, so we capture two states:
 *   - loading:   index.ejs as it first renders (spinners + "Loading Playlists")
 *   - populated: the HTMX regions filled with their real partials (connected buttons + a
 *                playlist list), i.e. what a signed-in user actually sees.
 *
 * Rendered from the real templates + public/css (fonts fall back to system - the app's Google
 * Fonts aren't fetched offline; self-hosting them is a follow-up so captures match production).
 * Runs under every viewport project in playwright.argos.config.ts.
 */
import { test } from '@playwright/test';
import { argosScreenshot } from '@argos-ci/playwright';
import { CSS, renderFile, renderString, playlistItem, setTheme, currentTheme } from './helpers';

test.beforeEach(({}, testInfo) => setTheme((testInfo.project.metadata.theme as string) ?? 'light'));

const fullDoc = (body: string) =>
  `<!doctype html><html data-theme="${currentTheme()}" data-bs-theme="${currentTheme()}"><head><meta charset="utf-8"><style>${CSS}
   body{margin:0}</style></head><body>${body}</body></html>`;

async function indexBody(): Promise<string> {
  const html = await renderFile('views/index.ejs', { csrfToken: 'test' });
  return html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
}

test('index page: loading state', async ({ page }) => {
  await page.setContent(fullDoc(await indexBody()));
  await argosScreenshot(page, 'index-loading');
});

test('index page: populated (signed in)', async ({ page }) => {
  await page.setContent(fullDoc(await indexBody()));

  const spotifyBtn = await renderString('connection-button.ejs', {
    service: 'spotify',
    connected: true,
    loading: false,
    error: null,
  });
  const youtubeBtn = await renderString('connection-button.ejs', {
    service: 'youtube',
    connected: true,
    loading: false,
    error: null,
  });
  const items = (
    await Promise.all([
      renderString('playlist-item.ejs', playlistItem({ name: 'My Favorite Songs' })),
      renderString(
        'playlist-item.ejs',
        playlistItem({
          id: 'p2',
          name: 'New Playlist',
          tracksTotal: 25,
          youtubeTracksTotal: 0,
          youtubeUrl: undefined,
          isSynced: false,
          buttonText: 'Sync to YouTube',
          buttonClass: 'btn-primary',
        }),
      ),
      renderString(
        'playlist-item.ejs',
        playlistItem({ id: 'p3', name: 'Chill Vibes', tracksTotal: 100, youtubeTracksTotal: 100 }),
      ),
    ])
  ).join('');
  const list = await renderString('playlist-list-container.ejs', {
    summaryText: 'Showing 2 synced and 1 unsynced playlists',
    playlistsHtml: items,
  });

  await page.evaluate(
    ({ spotifyBtn, youtubeBtn, list }) => {
      document.getElementById('spotify-status')!.innerHTML = spotifyBtn;
      document.getElementById('youtube-status')!.innerHTML = youtubeBtn;
      document.getElementById('playlists-content')!.innerHTML = list;
      // Both services connected -> the refresh control is no longer disabled.
      document.getElementById('refresh-playlists-btn')?.classList.remove('disabled');
      document.getElementById('refresh-playlists-btn')?.removeAttribute('disabled');
    },
    { spotifyBtn, youtubeBtn, list },
  );

  await argosScreenshot(page, 'index-populated');
});
