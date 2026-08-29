/**
 * Views must render outside Express, not just inside it.
 *
 * The Argos specs render templates with ejs.renderFile directly, so they get none of app.locals. A
 * template that uses a helper therefore has two ways to be wrong, and only one of them shows up in
 * a normal run. These tests render a view the way those specs do, in the suite that is required, so
 * a helper added to a template cannot break the visual specs silently.
 */

import { describe, it, expect } from 'vitest';
import { createApp } from '@/app';
import { viewLocals } from '@/lib/viewLocals';
import { renderFile } from '@tests/visual-argos/helpers';

describe('view locals', () => {
  it('gives the templates the same helpers Express does', () => {
    // Both sides read one object, so this holds by construction - which is the point. It fails the
    // moment someone introduces a hand-maintained second list.
    const locals = createApp().locals as Record<string, unknown>;

    expect(Object.keys(viewLocals).length).toBeGreaterThan(0);
    Object.entries(viewLocals).forEach(([name, helper]) => {
      expect(locals[name], `app.locals is missing ${name}`).toBe(helper);
    });
  });

  it('renders index.ejs through the visual harness, with no Express in sight', async () => {
    const html = await renderFile('views/index.ejs', { csrfToken: 'test' });

    expect(html).toContain('<body');
  });

  it('cuts the heading into ransom chips rather than dropping it', async () => {
    // A helper resolving to undefined could render an empty heading without throwing, and the
    // capture would be "valid" and wrong. The chips have to actually be in the markup.
    const html = await renderFile('views/index.ejs', { csrfToken: 'test' });

    expect(html).toContain('aria-label="Your Playlists"');
    expect(html).toMatch(/class="ransom__chip ransom__chip--v\d"/);
  });
});
