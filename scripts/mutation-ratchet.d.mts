/**
 * Types for the ratchet's exported decisions, so the tests calling them are type-checked.
 *
 * Hand-written: the script is plain JS and tsconfig.test.json cannot turn allowJs on, because that
 * makes tsc resolve the public/js client scripts, which are scripts rather than modules.
 *
 * These can drift from the implementation without tsc noticing. What catches that is
 * tests/unit/mutationRatchet.test.ts, which calls the real module: a signature that stops being
 * true fails there rather than passing quietly.
 */

export type Status = 'ok' | 'worse' | 'new' | 'unmeasured' | 'nothing-mutable';

export interface Verdict {
  file: string;
  before?: number;
  now?: number;
  status: Status;
}

export interface Measured {
  scores: Record<string, number>;
  reported: Set<string>;
}

export interface StrykerReport {
  files: Record<string, { mutants: { status: string }[] }>;
}

export function makeMutatedMatcher(globs: string[]): (file: string) => boolean;

export function parseReport(report: StrykerReport, cwd?: string): Measured;

export function judge(
  files: string[],
  baseline: Record<string, number>,
  measured: Measured,
): Verdict[];

export function regressionsIn(verdicts: Verdict[]): Verdict[];

export function newBaselines(verdicts: Verdict[]): Record<string, number>;

export function mergeBaseline(
  scores: Record<string, number>,
  previous: Record<string, number>,
  stillTracked: (file: string) => boolean,
): Record<string, number>;

export function summaryTable(verdicts: Verdict[]): string;
