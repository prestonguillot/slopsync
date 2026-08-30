/**
 * Styling tests for the press: every picture in the app is run through a filter, because a
 * full-colour photograph is otherwise the only object on a photocopied page that never went near
 * one.
 *
 * These guard the decisions that are invisible when they break - a filter that silently no-ops
 * still renders a perfectly good page, just the wrong one.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '../..');
const css = fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf-8');
const filters = fs.readFileSync(path.join(root, 'views/partials/print-filters.ejs'), 'utf-8');

// Anchored to the start of a line: several of these selectors also appear as the TAIL of a longer
// one (`.tracks-list .track-item:nth-child(4n+3) .youtube-video__thumbnail`), and an unanchored
// match happily returns that rule instead.
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`^${escaped}\\s*{[^}]*}`, 'm'))?.[0] ?? '';
};

describe('The press', () => {
  it('gives every feColorMatrix exactly 20 values', () => {
    // 4 rows x 5. One extra and the matrix is invalid, the browser drops it silently, and every
    // filter downstream screens a colour image while reporting no error at all.
    const matrices = [...filters.matchAll(/type="matrix"\s+values="([^"]+)"/g)];

    expect(matrices.length).toBeGreaterThan(0);
    matrices.forEach((match) => {
      expect(match[1]?.trim().split(/\s+/)).toHaveLength(20);
    });
  });

  it('forces alpha back to opaque wherever it composites arithmetically', () => {
    // feComposite's arithmetic runs on alpha too: k2*1 + k3*1 + k4 = 1 - 1 + 0.5 leaves every pixel
    // half-transparent and the page shows straight through the picture.
    const halftone = filters.match(/<filter\s+id="print-photo"[\s\S]*?<\/filter>/)?.[0] ?? '';

    expect(halftone).toContain('operator="arithmetic"');
    // The screen and grain passes both multiply (k1=1), which leaves alpha at 1*1 = 1.
    const arithmetic = [...halftone.matchAll(/operator="arithmetic"[^/]*?k1="([\d.]+)"/g)];
    expect(arithmetic.length).toBeGreaterThan(0);
    arithmetic.forEach(([, k1]) => expect(Number(k1)).toBe(1));
  });

  it('prints the thumbnails and the covers', () => {
    expect(rule('img.youtube-video__thumbnail')).toContain("filter: url('#print-photo')");
    expect(rule('.playlist-cover')).toContain("filter: url('#print-photo')");
  });

  it('spares the placeholder, which is a div holding a question mark', () => {
    // The class is shared with --placeholder. Unscoped, the press halftones and plate-shifts a
    // piece of UI that is not a photograph and never went near a press.
    expect(rule('.youtube-video__thumbnail')).not.toContain('#print-photo');
    expect(rule('.youtube-video__thumbnail--placeholder')).not.toContain('#print-photo');
    expect(css).toMatch(/^img\.youtube-video__thumbnail\s*{/m);
  });

  it('peels the print back to the photograph on hover, not the other way round', () => {
    // This shipped inverted: the cover was a colour photo that got photocopied on hover. On a
    // photocopied zine the print is what exists and the colour original is what you go looking for.
    expect(rule('.playlist-item:hover .playlist-cover')).toContain('filter: none');
  });

  it('runs both bleeds through the press, unmodified in either theme', () => {
    // The inks carry their own colour now, so there is nothing to flip for dark paper - and an
    // invert would send cyan to red and magenta to green, which stops it being a print of the
    // cover at all.
    expect(css).toMatch(/--bleed-print:\s*url\('#print-bleed'\);/);
    expect(css).not.toMatch(/--bleed-print:[^;]*invert/);
    expect(rule('.track-bleed::after')).toContain('filter: var(--bleed-print)');
    expect(rule('.playlist-item--art::after')).toContain('filter: var(--bleed-print)');
  });

  it('declares filter exactly once in each rule that prints', () => {
    // The test above passed for a full release while the playlist cover was NOT printed: the rule
    // carried `filter: var(--bleed-print)` AND, six lines later, `filter: contrast(1.1)
    // saturate(1.2)`. The later declaration won and the string sat in the file doing nothing.
    // "The stylesheet contains X" and "X takes effect" are different claims, and only this one
    // catches the difference.
    ['.track-bleed::after', '.playlist-item--art::after', 'img.youtube-video__thumbnail'].forEach(
      (selector) => {
        const declarations = rule(selector).match(/^\s*filter:/gm) ?? [];
        expect(
          declarations,
          `${selector} declares filter ${declarations.length} times`,
        ).toHaveLength(1);
      },
    );
  });

  it('leaves no trace of the overprinted artist', () => {
    expect(css).not.toContain('track-art-word');
  });
});

describe('The margin marks', () => {
  it('draws the theme toggle as a patch, not a bordered button', () => {
    const toggle = rule('.theme-toggle');

    expect(toggle).toContain('border: 0');
    expect(toggle).not.toContain('box-shadow: 3px 3px');
  });

  it('keeps the patch square, because a split circle is a yin-yang', () => {
    // A ringed circle split down the middle reads as a yin-yang, or as the half-moon every theme
    // toggle ever shipped. A press checks its inking against rectangular patches.
    expect(rule('.theme-toggle__icon')).toMatch(/border-radius:\s*0/);
  });

  it('floats the toggle instead of reserving space above the masthead', () => {
    // It is position:fixed and takes no space - but the container's Bootstrap mt-5 left a 48px gap
    // for it to sit IN, which read as the mark pushing the header down the page.
    expect(rule('.theme-toggle')).toContain('position: fixed');
    const index = fs.readFileSync(path.join(root, 'views/index.ejs'), 'utf-8');
    expect(index).not.toContain('container mt-5');
  });

  it('makes the inked half the state, and flips it on dark', () => {
    expect(rule('.theme-toggle__icon')).toContain('linear-gradient');
    expect(rule("[data-theme='dark'] .theme-toggle__icon")).toContain('linear-gradient');
  });

  it('hand-cuts the search icon instead of borrowing a font’s emoji', () => {
    const icon = rule('.search-icon');

    expect(icon).toMatch(/mask:\s*url\('\/images\/magnifier\.svg'\)/);
    expect(icon).toContain('background-color: var(--text-muted)');
    expect(fs.existsSync(path.join(root, 'public/images/magnifier.svg'))).toBe(true);
  });
});

describe('Hovers', () => {
  it('drops a row to its own hover ground, not to --surface-alt', () => {
    // --surface-alt on light is #f8f8f8 against a #fff card: a 3% shift nobody can see. The effect
    // was never missing from light mode - it was there and invisible. Dark got a real one only
    // because there --surface-alt happens to be far darker than the card.
    expect(rule('.playlist-item:hover')).toContain('var(--row-hover)');
    expect(rule('.track-item:hover')).toContain('var(--row-hover)');
    expect(css).toMatch(/--row-hover:\s*#e9e4d6/);
    expect(css).toMatch(/--row-hover:\s*#070707/);
  });

  it('clears the print from the whole row, not just from under the cursor', () => {
    // This worked by accident: `--clickable:hover { filter: brightness(0.85) }` outranks
    // `img.youtube-video__thumbnail` (0,2,0 vs 0,1,1) and replaced the press wholesale, so the
    // picture cleared only while you were over the image itself.
    expect(rule('.track-item:hover img.youtube-video__thumbnail')).toContain('filter: none');
    expect(rule('.youtube-video__thumbnail--clickable:hover')).not.toContain('filter:');
  });

  it('posterises the bleed rather than screening it to dots', () => {
    // Every screened version of this - 1-bit, halftone, finer rulings, more inks - keeps only what
    // clears the line, so a cover whose subject is small or low in contrast arrives as blobs. Tone
    // has to be carried in the LEVELS, which is what survives a low-contrast source.
    const bleed = filters.match(/<filter\s+id="print-bleed"[\s\S]*?<\/filter>/)?.[0] ?? '';

    expect(bleed).not.toContain('feTile'); // no screen to threshold against
    expect(bleed).toMatch(/type="discrete"\s+tableValues="[\d. ]{6,}"/); // more than two levels
  });

  it('prints the bleed from three inks, each off register', () => {
    // One ink cannot describe a colour cover, and plates that line up read as a filter rather than
    // as printing. Both are what make it a press instead of an effect.
    const bleed = filters.match(/<filter\s+id="print-bleed"[\s\S]*?<\/filter>/)?.[0] ?? '';
    const offsets = [...bleed.matchAll(/<feOffset[^>]*dx="(-?[\d.]+)"[^>]*dy="(-?[\d.]+)"/g)];

    expect(offsets).toHaveLength(3);
    // Three DIFFERENT slips: identical ones would print the inks on top of each other and there
    // would be no misregistration to see.
    expect(new Set(offsets.map((m) => `${m[1]},${m[2]}`)).size).toBe(3);
    expect(offsets.every((m) => Number(m[1]) !== 0 || Number(m[2]) !== 0)).toBe(true);
  });

  it('overprints the plates rather than adding them', () => {
    // Ink is subtractive: two plates over each other darken. `screen` would brighten, and the
    // bleed would wash out exactly where the cover is densest.
    const bleed = filters.match(/<filter\s+id="print-bleed"[\s\S]*?<\/filter>/)?.[0] ?? '';

    expect([...bleed.matchAll(/<feBlend[^>]*mode="multiply"/g)]).toHaveLength(2);
  });

  it('leaves no tape behind', () => {
    expect(css).not.toMatch(/--tape-/);
    expect(css).not.toMatch(/backdrop-filter/);
  });
});
