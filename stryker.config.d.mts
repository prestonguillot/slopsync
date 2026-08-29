/**
 * Types for the stryker config, so the tests reading it are type-checked.
 *
 * Hand-written for the same reason as scripts/mutation-ratchet.d.mts: the config is plain JS
 * (stryker loads it directly) and tsconfig.test.json cannot turn allowJs on, because that makes tsc
 * resolve the public/js client scripts, which are scripts rather than modules.
 *
 * Only `mutate` is declared, because it is the only field anything outside stryker reads - the
 * ratchet builds its file matcher from these globs so it cannot disagree with what is measured.
 */

declare const config: {
  mutate: string[];
};

export default config;
