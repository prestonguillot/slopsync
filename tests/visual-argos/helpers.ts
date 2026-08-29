/**
 * Shared rendering helpers + fixtures for the Argos visual specs. Renders the real EJS
 * partials with the actual stylesheets, exactly like the app serves them, so the captured
 * pixels are the app's own output. Baselines live in Argos - nothing is committed to git.
 */
import fs from 'fs';
import path from 'path';
import ejs from 'ejs';
import type { Page } from '@playwright/test';
// Relative, not the `@/` alias: vitest resolves that alias but Playwright reads the root
// tsconfig.json, which declares no paths - so an aliased import here resolves in the unit suite
// and fails in the Argos run, which is the one this file exists for.
import { viewLocals } from '../../src/lib/viewLocals';

export const ROOT = path.join(__dirname, '../..');

/**
 * Render a view the way the app does. Express hands every template app.locals; ejs.renderFile does
 * not, so the helpers have to be merged in here or the template throws on one of them. Passed
 * first, so a spec can still override a helper if it ever needs to.
 */
export const renderFile = (file: string, data: Record<string, unknown>) =>
  ejs.renderFile(path.join(ROOT, file), { ...viewLocals, ...data });

// Inline the self-hosted woff2 as base64 data URIs. Under setContent the page base is
// about:blank, so @font-face url('/fonts/..') requests never resolve and text falls back to
// system fonts - data URIs need no request, so the real display fonts render in the capture
// (argosScreenshot waits for document.fonts.ready). Production still uses the url()-based
// public/css/fonts.css; this is a test-only transform of the same @font-face rules.
const fontsCss = fs
  .readFileSync(path.join(ROOT, 'public/css/fonts.css'), 'utf-8')
  .replace(
    /url\('\/fonts\/([^']+)'\)/g,
    (_m, file) =>
      `url('data:font/woff2;base64,${fs.readFileSync(path.join(ROOT, 'public/fonts', file)).toString('base64')}')`,
  );

export const CSS = [
  fs.readFileSync(path.join(ROOT, 'public/vendor/bootstrap.min.css'), 'utf-8'),
  fontsCss,
  fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf-8'),
].join('\n');

// Solid-colour data-URI images so captures need no network and stay deterministic. Fully
// URL-encoded (no literal quotes) so the URI is also valid inside a CSS url('...') - the
// album-art backdrop consumes it that way.
export const img = (color: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#${color}"/></svg>`)}`;

// Current theme for captures - set per Playwright project via setTheme() in each spec's
// beforeEach, so every view is baselined in both light and dark.
let THEME = 'light';
export const setTheme = (t: string) => {
  THEME = t;
};
export const currentTheme = () => THEME;

const doc = (body: string, harnessCss = '.harness{max-width:900px}') =>
  `<!doctype html><html data-theme="${THEME}" data-bs-theme="${THEME}"><head><meta charset="utf-8"><style>${CSS}
   body{margin:0;padding:16px}${harnessCss}</style></head>
   <body><div class="harness">${body}</div></body></html>`;

/** Render a partial into an isolated page and load it. */
export async function renderPartial(
  page: Page,
  partial: string,
  data: Record<string, unknown>,
  harnessCss?: string,
): Promise<void> {
  const body = await renderFile(path.join('views/partials', partial), data);
  await page.setContent(doc(body, harnessCss));
}

/** Load raw markup (already-rendered or hand-written) into an isolated page. */
export async function renderHtml(page: Page, body: string, harnessCss?: string): Promise<void> {
  await page.setContent(doc(body, harnessCss));
}

export const renderString = (partial: string, data: Record<string, unknown>) =>
  renderFile(path.join('views/partials', partial), data);

// --- Fixtures (mirrors the retired tests/visual/components.spec.ts) ---

export const score = {
  stars: 4.5,
  totalScore: 0.9,
  color: '#3bb54a',
  components: { coreMatch: 0.6, officialVideo: 0.3 },
};

export const spotify = (over = {}) => ({
  id: 't1',
  name: 'Song Title',
  artist: 'The Artist',
  album: 'An Album',
  albumArt: img('cc3366'),
  ...over,
});

export const youtube = (over = {}) => ({
  id: 'vid1',
  title: 'Song Title (Official Video)',
  url: '#',
  thumbnail: img('3366cc'),
  ...over,
});

export const detailsBase = {
  playlistId: 'pl1',
  playlistName: 'My Playlist',
  linkedCount: 1,
  totalTracks: 2,
  needsResync: false,
};

export const playlistItem = (over = {}) => ({
  id: 'p1',
  name: 'My Playlist',
  tracksTotal: 33,
  youtubeTracksTotal: 30,
  coverImage: img('7a3ea1'),
  spotifyUrl: '#',
  youtubeUrl: '#',
  isSynced: true,
  syncIcon: '',
  buttonText: 'Update YouTube Playlist',
  buttonClass: 'btn-outline-success',
  isYouTubeConnected: true,
  isDisabled: false,
  ...over,
});

export const videoModalFixture = {
  modalTitle: 'Choose a video',
  instructionText: 'Pick the best match for <strong>Song Title</strong>',
  currentVideoId: '',
  playlistId: 'p1',
  trackId: 't1',
  trackName: 'Song Title',
  artistName: 'The Artist',
  searchQuery: 'Song Title The Artist',
  videos: [
    {
      id: 'v1',
      title: 'Song Title (Official Video)',
      channelTitle: 'The Artist',
      description: 'Official music video. '.repeat(12),
      thumbnail: img('3366cc'),
      matchScore: score,
    },
    {
      id: 'v2',
      title: 'Song Title (Live)',
      channelTitle: 'A Fan',
      description: 'Live performance from a concert.',
      thumbnail: img('cc9933'),
      matchScore: { stars: 3, totalScore: 0.62, color: '#e0a800', components: { coreMatch: 0.6 } },
    },
  ],
};

export const CONNECTION_MODAL = `
  <dialog class="connection-error-modal" id="connectionErrorModal" aria-labelledby="l">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title" id="l">Spotify Connection Failed</h5>
        <button type="button" class="btn-close" data-dialog-close aria-label="Close"></button>
      </div>
      <div class="modal-body">
        <p class="modal-message">Spotify API quota exceeded. Please wait and try again later.</p>
        <div class="text-center"><button type="button" class="btn btn-error-modal" data-dialog-close>OK</button></div>
      </div>
    </div>
  </dialog>`;
