/**
 * Ransom-note lettering: cuts a string into per-character chips, each assigned one of a handful of
 * looks, so a heading reads as letters clipped from different magazines and pasted in a row.
 *
 * Two properties matter, and they pull against each other:
 *
 * 1. It must be STABLE. The same heading cuts identically on every render, or the page reshuffles
 *    per request and every visual snapshot flakes. So: hashed, never randomised.
 * 2. Every look must actually appear. Hashing each letter independently gives no distribution
 *    guarantee - "Your Playlists" dealt six blue chips and not one red, dropping the zine's loudest
 *    colour from the heading entirely.
 *
 * So letters are dealt from a shuffled deck rather than hashed one by one: each run of
 * RANSOM_VARIANTS letters contains every look exactly once, in a deterministically shuffled order.
 * That keeps the palette honest and stops any one look from clumping, while still reading as
 * hand-pasted rather than as a repeating pattern.
 */

/** How many distinct chip looks the stylesheet defines (`.ransom__chip--v0` … `--v3`). Adding one
 * here without adding the matching class renders letters with no styling at all. */
export const RANSOM_VARIANTS = 4;

export interface RansomChip {
  char: string;
  /** Index into the chip looks; meaningless for spaces. */
  variant: number;
  /** Spaces are word gaps, not cut-out letters - they get no chip. */
  isSpace: boolean;
}

/**
 * FNV-1a. Chosen for avalanche: adjacent seeds must produce unrelated output, or consecutive decks
 * would shuffle alike and the row would visibly repeat.
 */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * One deck of every look, shuffled from a seed. Drawn by splicing from a pool rather than swapping
 * by index: the pool shrinks by exactly one card per draw, so the deck is built without ever
 * reading an index that might not be there.
 */
function deal(seed: string): number[] {
  const pool = Array.from({ length: RANSOM_VARIANTS }, (_, i) => i);
  const deck: number[] = [];
  for (let draw = 0; pool.length > 0; draw++) {
    deck.push(...pool.splice(hash(`${seed}:${draw}`) % pool.length, 1));
  }
  return deck;
}

export function toRansom(text: string): RansomChip[] {
  const chars = Array.from(text);
  // Seeded by the text, so two headings of the same length don't cut identically.
  const seed = hash(text);

  // Spaces don't draw a card - a word gap shouldn't shift the deal and split a run across two
  // decks, which would quietly break the once-per-run guarantee.
  const letters = chars.filter((char) => char.trim() !== '').length;
  const cards: number[] = [];
  for (let group = 0; cards.length < letters; group++) {
    cards.push(...deal(`${seed}:${group}`));
  }

  let drawn = 0;
  return chars.map((char) => {
    if (char.trim() === '') {
      return { char, variant: 0, isSpace: true };
    }
    const variant = cards[drawn++];
    if (variant === undefined) {
      // Unreachable: the loop above deals whole decks until every letter has a card. Thrown rather
      // than defaulted because a silent fallback would cut the whole heading from one magazine and
      // still look plausible enough to ship.
      throw new Error(`ransom: dealt ${cards.length} cards for ${letters} letters`);
    }
    return { char, variant, isSpace: false };
  });
}
