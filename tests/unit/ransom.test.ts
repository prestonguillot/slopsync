/**
 * Unit tests for ransom-note lettering.
 *
 * Eight mutants survive this file and cannot be killed by any assertion worth writing, so the bar
 * sits below 100 on purpose:
 *
 * - `letters` counts non-space characters to decide how many decks to deal in advance. Mutating it
 *   to count everything, or to deal one deck more, only ever produces SPARE cards - and spare cards
 *   are never drawn, because the map draws one per non-space character. Output is identical.
 * - The `variant === undefined` guard is unreachable: the loop deals whole decks until every letter
 *   has a card. It exists because noUncheckedIndexedAccess types the lookup as possibly-undefined,
 *   and throwing beats a fallback that would cut the whole heading from one magazine and still look
 *   plausible enough to ship.
 */

import { describe, it, expect } from 'vitest';
import { toRansom, RANSOM_VARIANTS } from '@/lib/ransom';

describe('toRansom', () => {
  it('cuts a string into one chip per character, preserving the text', () => {
    const chips = toRansom('Your Playlists');

    expect(chips).toHaveLength('Your Playlists'.length);
    expect(chips.map((c) => c.char).join('')).toBe('Your Playlists');
  });

  it('assigns every letter a variant the stylesheet actually defines', () => {
    const chips = toRansom('Your Playlists');

    chips.forEach((chip) => {
      expect(chip.variant).toBeGreaterThanOrEqual(0);
      expect(chip.variant).toBeLessThan(RANSOM_VARIANTS);
      expect(Number.isInteger(chip.variant)).toBe(true);
    });
  });

  it('cuts identically on every call', () => {
    // The whole point of hashing instead of randomising: the page must not reshuffle per request,
    // and visual snapshots must not flake.
    const a = toRansom('Your Playlists');
    const b = toRansom('Your Playlists');

    expect(a).toEqual(b);
  });

  it('marks spaces as gaps rather than letters', () => {
    const chips = toRansom('Your Playlists');

    expect(chips[4]).toMatchObject({ char: ' ', isSpace: true });
    expect(chips.filter((c) => c.isSpace)).toHaveLength(1);
    expect(chips.filter((c) => !c.isSpace).every((c) => c.char.trim() !== '')).toBe(true);
  });

  it('gives a repeated letter different chips at different positions', () => {
    // Otherwise every "s" in a heading would be cut from the same magazine, and the row would
    // visibly stripe instead of reading as hand-pasted.
    const chips = toRansom('sssssssss');
    const variants = new Set(chips.map((c) => c.variant));

    expect(variants.size).toBeGreaterThan(1);
  });

  it('deals every look exactly once per run of four letters', () => {
    // The property the deck buys us. Hashing letters independently had no such guarantee: it dealt
    // "Your Playlists" six blue chips and zero red, silently dropping a colour from the palette.
    const letters = toRansom('Your Playlists Are Here Now').filter((c) => !c.isSpace);

    for (let i = 0; i + RANSOM_VARIANTS <= letters.length; i += RANSOM_VARIANTS) {
      const run = letters.slice(i, i + RANSOM_VARIANTS).map((c) => c.variant);
      expect(new Set(run).size).toBe(RANSOM_VARIANTS);
    }
  });

  it('uses every look the stylesheet defines on a real heading', () => {
    const variants = new Set(toRansom('Your Playlists').map((c) => c.variant));

    expect(variants.size).toBe(RANSOM_VARIANTS);
  });

  it('does not let a word gap shift the deal', () => {
    // Spaces must not consume a card, or a heading's runs would straddle the deck boundary and the
    // once-per-run guarantee would quietly stop holding.
    const spaced = toRansom('ab cd').filter((c) => !c.isSpace);
    const tight = toRansom('ab cd'.replace(' ', ''));

    expect(spaced.map((c) => c.variant)).not.toContain(undefined);
    expect(new Set(spaced.map((c) => c.variant)).size).toBe(RANSOM_VARIANTS);
    expect(tight).toHaveLength(4);
  });

  it('cuts two different headings differently', () => {
    // The deal is seeded from the text. Without that it is seeded from nothing, and every heading
    // on the page is cut to the same pattern - which reads as a template rather than as letters
    // pasted one at a time.
    const a = toRansom('Your Playlists').map((c) => c.variant);
    const b = toRansom('Xour Playlists').map((c) => c.variant);

    expect(a).not.toEqual(b);
  });

  it('deals a different deck for each run, not the same one over and over', () => {
    // Every run holds all four looks, which a single repeated deck also satisfies - and that would
    // print an unmistakable four-letter pattern down the heading. The decks have to differ.
    const variants = toRansom('abcdefghijklmnop').map((c) => c.variant);
    const runs = [];
    for (let i = 0; i + RANSOM_VARIANTS <= variants.length; i += RANSOM_VARIANTS) {
      runs.push(variants.slice(i, i + RANSOM_VARIANTS).join(''));
    }

    expect(runs.length).toBeGreaterThan(1);
    expect(new Set(runs).size).toBeGreaterThan(1);
  });

  it('cuts this heading exactly this way', () => {
    // A golden master, because "stable" is the property that cannot be checked by re-running the
    // same call twice - that passes even if the deal changes, as long as it changes for everyone.
    // The app's headings are captured in Argos, so a deal that shifts moves visual baselines with
    // it. If this assertion has to change, that is the change announcing itself.
    const cut = toRansom('Your Playlists')
      .map((chip) => (chip.isSpace ? ' ' : String(chip.variant)))
      .join('');

    expect(cut).toBe('3120 031212302');
  });

  it('handles an empty string without inventing a chip', () => {
    expect(toRansom('')).toEqual([]);
  });

  it('keeps multi-byte characters whole', () => {
    // Array.from iterates code points; a naive split('') would cut an emoji in half and emit two
    // broken chips.
    const chips = toRansom('a★b');

    expect(chips).toHaveLength(3);
    expect(chips.map((c) => c.char)).toEqual(['a', '★', 'b']);
  });
});
