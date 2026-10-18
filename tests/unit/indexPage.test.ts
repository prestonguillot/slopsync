/**
 * @vitest-environment happy-dom
 *
 * Tests for public/js/indexPage.js: the OAuth error dialog and opening video thumbnails.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trackListeners } from '@tests/helpers/clientListeners';

let listeners: ReturnType<typeof trackListeners>;

async function load(search = '') {
  window.history.replaceState({}, '', `/${search}`);
  listeners = trackListeners(document, document.body);
  vi.resetModules();
  await import('../../public/js/indexPage.js');
  listeners.stop();
  document.dispatchEvent(new Event('DOMContentLoaded'));
}

const renderDialog = () => {
  document.body.innerHTML = `
    <dialog id="connectionErrorModal">
      <h5 id="connectionErrorLabel"></h5>
      <p id="connectionErrorMessage"></p>
    </dialog>`;
  const dialog = document.getElementById('connectionErrorModal') as HTMLDialogElement;
  dialog.showModal = vi.fn();
  return dialog;
};

const message = () => document.getElementById('connectionErrorMessage')!.textContent;
const label = () => document.getElementById('connectionErrorLabel')!.textContent;

beforeEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  vi.stubGlobal('open', vi.fn());
});

afterEach(() => {
  listeners?.removeAll();
  vi.unstubAllGlobals();
});

describe('indexPage.js: the OAuth error dialog', () => {
  it('stays shut when there is no error in the URL', async () => {
    const dialog = renderDialog();

    await load('');

    expect(dialog.showModal).not.toHaveBeenCalled();
  });

  it('opens with the service named when an error arrives', async () => {
    const dialog = renderDialog();

    await load('?error=spotify');

    expect(dialog.showModal).toHaveBeenCalled();
    expect(label()).toBe('Spotify Connection Failed');
  });

  it.each([
    ['quota_exceeded', 'Spotify API quota exceeded. Please wait and try again later.'],
    ['rate_limited', 'Rate limited by Spotify. Please wait a moment and try again.'],
    ['auth_error', 'Spotify authentication failed. Please try reconnecting.'],
    ['service_unavailable', 'Spotify service is temporarily unavailable. Please try again soon.'],
    ['state_mismatch', 'That Spotify connection attempt expired. Start it again.'],
  ])('explains reason=%s', async (reason, expected) => {
    renderDialog();

    await load(`?error=spotify&reason=${reason}`);

    expect(message()).toBe(expected);
  });

  it('falls back to a generic message for an unknown reason', async () => {
    renderDialog();

    await load('?error=spotify&reason=something_new');

    expect(message()).toBe('Connection failed. Please try again.');
  });

  it('capitalises the service name', async () => {
    renderDialog();

    await load('?error=youtube&reason=auth_error');

    expect(label()).toBe('Youtube Connection Failed');
    expect(message()).toContain('Youtube');
  });

  // Otherwise a refresh re-shows the error for a connection that has since succeeded.
  it('scrubs the error out of the URL after showing it', async () => {
    renderDialog();

    await load('?error=spotify&reason=auth_error');

    expect(window.location.search).toBe('');
  });
});

describe('indexPage.js: opening a video thumbnail', () => {
  const renderThumbnail = (over: { url?: string | null } = {}) => {
    const url = over.url === undefined ? 'https://www.youtube.com/watch?v=abc' : over.url;
    document.body.innerHTML = `
      <img id="thumb" class="youtube-video__thumbnail--clickable"
           ${url === null ? '' : `data-video-url="${url}"`} role="button" tabindex="0">
      <img id="plain" class="youtube-video__thumbnail">`;
    return document.getElementById('thumb') as HTMLElement;
  };

  // Without noopener the opened YouTube tab gets a live window.opener pointing at this app and can
  // navigate it away (reverse tabnabbing). The url comes from a data attribute on rendered DOM.
  it('opens the video in a new tab with noopener,noreferrer', async () => {
    const thumb = renderThumbnail();
    await load();

    thumb.click();

    expect(window.open).toHaveBeenCalledWith(
      'https://www.youtube.com/watch?v=abc',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('ignores a click on a thumbnail that is not clickable', async () => {
    renderThumbnail();
    await load();

    document.getElementById('plain')!.click();

    expect(window.open).not.toHaveBeenCalled();
  });

  it('ignores a clickable thumbnail with no url', async () => {
    const thumb = renderThumbnail({ url: null });
    await load();

    thumb.click();

    expect(window.open).not.toHaveBeenCalled();
  });

  it.each([['Enter'], [' ']])('opens the video on %s, since it is a role=button', async (key) => {
    const thumb = renderThumbnail();
    await load();

    thumb.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

    expect(window.open).toHaveBeenCalledWith(
      'https://www.youtube.com/watch?v=abc',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('does not open on other keys', async () => {
    const thumb = renderThumbnail();
    await load();

    thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

    expect(window.open).not.toHaveBeenCalled();
  });

  // Space would otherwise scroll the page out from under the click.
  it('suppresses the default action when it opens from the keyboard', async () => {
    const thumb = renderThumbnail();
    await load();

    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    thumb.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves the default action alone when no thumbnail was opened', async () => {
    renderThumbnail({ url: null });
    await load();

    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    document.getElementById('thumb')!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves the default action alone for a key pressed outside any thumbnail', async () => {
    renderThumbnail();
    await load();

    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    document.getElementById('plain')!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});

describe('indexPage.js: when YouTube stops accepting changes', () => {
  const BLOCKED = 'YouTube is not accepting changes right now.';

  const renderControls = () => {
    document.body.innerHTML = `
      <button id="sync" class="sync-btn">Sync</button>
      <button id="already" class="sync-btn" disabled title="its own reason">Sync</button>
      <div class="track-stamps">
        <button id="edit" hx-get="/videos/search">Edit</button>
        <button id="plain">Not a picker</button>
      </div>
      <button id="outside" hx-get="/elsewhere">Elsewhere</button>
      <div id="target"></div>`;
  };
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
  const block = () => document.body.dispatchEvent(new CustomEvent('youtube-blocked'));
  const swapIn = (html: string) => {
    const target = document.getElementById('target')!;
    target.innerHTML = html;
    target.dispatchEvent(new CustomEvent('htmx:afterSwap', { bubbles: true }));
  };

  it('disables every sync button and says why', async () => {
    renderControls();
    await load();

    block();

    expect(button('sync').disabled).toBe(true);
    expect(button('sync').title).toBe(BLOCKED);
  });

  it('keeps the reason an already-disabled sync button gives', async () => {
    renderControls();
    await load();

    block();

    expect(button('already').title).toBe('its own reason');
  });

  it('disables the stamps that open the video picker and says why', async () => {
    renderControls();
    await load();

    block();

    expect(button('edit').disabled).toBe(true);
    expect(button('edit').title).toBe(BLOCKED);
  });

  it('leaves buttons that never lead to a write alone', async () => {
    renderControls();
    await load();

    block();

    expect(button('plain').disabled).toBe(false);
    expect(button('outside').disabled).toBe(false);
  });

  it('disables the controls when a streamed partial inside the swap is marked blocked', async () => {
    renderControls();
    await load();

    swapIn('<p data-youtube-blocked>Quota spent</p>');

    expect(button('sync').disabled).toBe(true);
  });

  it('disables the controls when the swapped element is itself marked blocked', async () => {
    renderControls();
    await load();

    const target = document.getElementById('target')!;
    target.setAttribute('data-youtube-blocked', '');
    target.dispatchEvent(new CustomEvent('htmx:afterSwap', { bubbles: true }));

    expect(button('sync').disabled).toBe(true);
  });

  it('ignores a swap event raised from something that is not an element', async () => {
    renderControls();
    await load();
    const text = document.createTextNode('streamed text');
    document.getElementById('target')!.appendChild(text);

    expect(() =>
      text.dispatchEvent(new CustomEvent('htmx:afterSwap', { bubbles: true })),
    ).not.toThrow();
    expect(button('sync').disabled).toBe(false);
  });

  it('leaves the controls alone after a swap that is not marked blocked', async () => {
    renderControls();
    await load();

    swapIn('<p>Synced</p>');

    expect(button('sync').disabled).toBe(false);
  });
});
