#!/usr/bin/env node
/**
 * Mutation-score ratchet: a file may not become less well tested than it already is.
 *
 * Each file is compared against its own recorded score rather than a shared threshold. A single bar
 * high enough to be worth enforcing would block any edit to a file that is currently under it, for
 * reasons having nothing to do with the edit. Per-file means a weak file stays editable while a
 * well-tested one cannot quietly rot. Stryker's own `thresholds.break` is one global number: a file
 * losing fifty mutants is ~1% of the whole, so it would not notice.
 *
 * The decisions live in exported functions that take data and return verdicts, so that the thing
 * standing between this repo and a rotting test suite is itself tested (tests/unit/mutationRatchet).
 * Everything to do with disk, git and stryker stays in the command handlers at the bottom.
 *
 * Usage:
 *   node scripts/mutation-ratchet.mjs check [--base origin/main]
 *       Mutate only the files changed against the base and fail if one scores below its baseline.
 *       Mutating everything runs the test suite once per mutant, which is too slow to sit in front
 *       of a change; the files a change touches are the ones it can break.
 *
 *   node scripts/mutation-ratchet.mjs check-all
 *       Compare EVERY file in the last report against its baseline. The per-change check only looks
 *       at what a change touched, so it cannot see a file whose tests were weakened from elsewhere;
 *       this can.
 *
 *   node scripts/mutation-ratchet.mjs update
 *       Sweep everything and rewrite the baseline. Run after deliberately changing what is tested.
 *
 *   node scripts/mutation-ratchet.mjs record
 *       Rewrite the baseline from the report already on disk, without running stryker. The numbers
 *       a laptop measures and the numbers the runner measures are not identical, and the runner is
 *       what enforces them - so the recorded bar has to be one it can actually clear. Download the
 *       sweep's report artifact into reports/mutation/ and record from that.
 *
 *   node scripts/mutation-ratchet.mjs record-new [--base origin/main]
 *       Give a bar to any changed file that has none, and fail if it had to write one. This is the
 *       pre-push gate (.githooks/pre-push): a file arrives with its bar rather than going unratcheted
 *       until the weekly sweep notices. Costs a git diff and a JSON read unless a file is actually
 *       new, so the usual answer is instant.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import picomatch from 'picomatch';

const BASELINE = 'mutation-baseline.json';
const REPORT = 'reports/mutation/report.json';
const INCREMENTAL = 'reports/stryker-incremental.json';

/**
 * Does Stryker mutate this file? Built from Stryker's own globs rather than a copy of them, so
 * changing what gets mutated cannot leave this script quietly disagreeing.
 *
 * The globs are include-minus-exclude, which is NOT what picomatch does with an array: it ORs them,
 * and reads a leading `!` as "matches anything but this" - so `!src/types/**` alone would match
 * every test and template. The two sets are applied separately.
 *
 * @param {string[]} globs stryker's `mutate` globs, exclusions prefixed with `!`
 * @returns {(file: string) => boolean}
 */
export function makeMutatedMatcher(globs) {
  const included = picomatch(globs.filter((g) => !g.startsWith('!')));
  const excluded = picomatch(globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1)));
  return (file) => included(file) && !excluded(file);
}

/**
 * Per-file mutation scores, plus every file the report mentions - including those with nothing
 * mutable in them, which `scores` omits. A file with no mutants is fine; one the run never reached
 * is not, and only `reported` can tell them apart.
 *
 * @param {{ files: Record<string, { mutants: { status: string }[] }> }} report stryker's JSON report
 * @param {string} [cwd] paths in the report are absolute; scores are keyed relative to here
 * @returns {{ scores: Record<string, number>, reported: Set<string> }}
 */
export function parseReport(report, cwd = process.cwd()) {
  const scores = {};
  const reported = new Set();

  for (const [file, data] of Object.entries(report.files)) {
    const relative = path.relative(cwd, file);
    reported.add(relative);

    const counts = {};
    for (const mutant of data.mutants) counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;

    const killed = (counts.Killed ?? 0) + (counts.Timeout ?? 0);
    const survived = (counts.Survived ?? 0) + (counts.NoCoverage ?? 0);
    const total = killed + survived;
    if (total === 0) continue; // nothing mutable in here

    scores[relative] = Math.round((killed / total) * 10000) / 100;
  }
  return { scores, reported };
}

/**
 * The verdict on each of `files`: what it scored, what it was supposed to score, and which of those
 * counts as a regression.
 *
 * `unmeasured` is a regression. A file absent from the report was not measured, which is not the
 * same as not having regressed - a run that silently skips a file must not read as that file being
 * fine.
 *
 * @param {string[]} files the files to judge
 * @param {Record<string, number>} baseline recorded scores
 * @param {{ scores: Record<string, number>, reported: Set<string> }} measured from `parseReport`
 * @returns {{ file: string, before?: number, now?: number,
 *             status: 'ok' | 'worse' | 'new' | 'unmeasured' | 'nothing-mutable' }[]}
 */
export function judge(files, baseline, { scores, reported }) {
  return files.map((file) => {
    const before = baseline[file];
    const now = scores[file];

    if (!reported.has(file)) return { file, before, now: undefined, status: 'unmeasured' };
    if (now === undefined) return { file, before, now, status: 'nothing-mutable' };
    if (before === undefined) return { file, before, now, status: 'new' };
    // A point of tolerance: mutant counts shift slightly as code moves around.
    return { file, before, now, status: now < before - 1 ? 'worse' : 'ok' };
  });
}

/** The verdicts that fail a run. */
export const regressionsIn = (verdicts) =>
  verdicts.filter((v) => v.status === 'worse' || v.status === 'unmeasured');

/**
 * Scores for files that have no bar yet, ready to be recorded.
 *
 * A file with no baseline cannot regress, so it would otherwise sit at whatever it scores for as
 * long as nobody re-records - unratcheted, and indistinguishable from a file that is doing fine.
 * Its first measurement becomes its bar instead, so it is covered from the change that adds it.
 *
 * @param {{ file: string, now?: number, status: string }[]} verdicts
 * @returns {Record<string, number>}
 */
export const newBaselines = (verdicts) =>
  Object.fromEntries(
    verdicts
      .filter((v) => v.status === 'new' && v.now !== undefined)
      .map(({ file, now }) => [file, now]),
  );

/**
 * Merge scores into the baseline, keeping entries the run did not measure.
 *
 * A scoped run reports only the files it mutated, so replacing wholesale would drop every other
 * file's record and silently reset the ratchet to remembering nothing. Entries are pruned only when
 * their file is gone or is no longer mutated at all.
 *
 * @param {Record<string, number>} scores
 * @param {Record<string, number>} previous the baseline as it stands
 * @param {(file: string) => boolean} stillTracked false for a file that is gone or unmutated
 * @returns {Record<string, number>} sorted by path
 */
export function mergeBaseline(scores, previous, stillTracked) {
  const merged = { ...previous, ...scores };
  for (const file of Object.keys(merged)) {
    if (!stillTracked(file)) delete merged[file];
  }
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}

const MUTATED = makeMutatedMatcher(
  (await import(pathToFileURL(path.resolve('stryker.config.mjs')).href)).default.mutate,
);

function readReport() {
  if (!existsSync(REPORT)) {
    throw new Error(`No ${REPORT}. Run stryker first.`);
  }
  return parseReport(JSON.parse(readFileSync(REPORT, 'utf8')));
}

const readBaseline = () =>
  existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).scores : {};

/**
 * Record the scores. The file holds nothing but the numbers - what they mean and how to regenerate
 * them is documented here, in the script that reads and writes them.
 */
function writeBaseline(scores) {
  const sorted = mergeBaseline(scores, readBaseline(), (f) => existsSync(f) && MUTATED(f));
  writeFileSync(BASELINE, JSON.stringify({ scores: sorted }, null, 2) + '\n');
  console.log(`Wrote ${BASELINE} (${Object.keys(sorted).length} files)`);
}

function changedFiles(base) {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' });
  // The diff includes deleted files and the old side of a rename; passing one of those to --mutate
  // would fail on a path that is no longer there.
  return out.split('\n').filter((f) => f && MUTATED(f) && existsSync(f));
}

const LABEL = { ok: 'ok', worse: '**worse**', new: 'new', unmeasured: '**not measured**' };

const row = ({ file, before, now, status }) =>
  `| ${file} | ${before ?? '–'}% | ${now === undefined ? '–' : `${now}%`} | ${LABEL[status]} |`;

/**
 * The run summary table, on CI: a report that has to be downloaded and unzipped to be read is a
 * report nobody reads. When something regressed the table says only what regressed; a hundred rows
 * of `ok` is where a `worse` goes to hide.
 */
export function summaryTable(verdicts) {
  const failed = regressionsIn(verdicts);
  const shown = (failed.length ? verdicts.filter((v) => v.status !== 'ok') : verdicts).filter(
    (v) => v.status !== 'nothing-mutable',
  );
  return [
    failed.length ? '## Mutation score regressed' : '## Mutation score held',
    '',
    '| File | Baseline | Now | |',
    '| --- | --- | --- | --- |',
    ...shown.map(row),
    '',
  ].join('\n');
}

/** Judge `files` against what is recorded, reporting to the log and to CI's run summary. */
function compare(files, { verbose = false } = {}) {
  const verdicts = judge(files, readBaseline(), readReport());

  if (verbose) {
    for (const { file, before, now, status } of verdicts) {
      if (status === 'ok') console.log(`  OK    ${file}: ${now}% (baseline ${before}%)`);
      if (status === 'new') console.log(`  NEW   ${file}: ${now}% (no baseline yet)`);
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summaryTable(verdicts), { flag: 'a' });
  }

  return verdicts;
}

function reportRegressions(regressions) {
  if (regressions.length === 0) return false;
  console.error('\nMutation score regressed:');
  for (const { file, before, now } of regressions) {
    if (now === undefined) console.error(`  ${file}: not in the report - it was never scored`);
    else console.error(`  ${file}: ${before}% -> ${now}%`);
  }
  console.error(
    '\nThe tests no longer catch changes they used to. Either cover the new code, or ' +
      're-record deliberately with: npm run test:mutation:update',
  );
  return true;
}

/**
 * A dead run must leave no report behind - the comparison cannot tell a stale one from a fresh one.
 * With `thresholds.break` null, stryker exits non-zero only on failure.
 *
 * The incremental cache goes too when the run's numbers are going to be recorded. Stryker reports
 * every file the cache has ever held, not just the ones this run mutated - so a scoped run reports
 * 48 files for 11 measured, and the other 37 carry whatever status they were given whenever they
 * were last seen, at whatever config was in force then. Recording those writes numbers nothing
 * measured, and a bar nothing earned is worse than no bar.
 */
function runStryker(args, { fresh = false } = {}) {
  rmSync(REPORT, { force: true });
  if (fresh) rmSync(INCREMENTAL, { force: true });
  const result = spawnSync('npx', ['stryker', 'run', ...args], { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`stryker exited ${result.status}. Nothing was scored; see the output above.`);
  }
}

function main(argv) {
  const command = argv[2];

  if (command === 'update') {
    runStryker([], { fresh: true });
    writeBaseline(readReport().scores);
  } else if (command === 'record') {
    writeBaseline(readReport().scores);
  } else if (command === 'record-new') {
    const baseIndex = argv.indexOf('--base');
    const base = baseIndex === -1 ? 'origin/main' : argv[baseIndex + 1];
    const baseline = readBaseline();
    const files = changedFiles(base).filter((file) => baseline[file] === undefined);

    // The fast path, and the usual one: a git diff and a JSON read, no stryker. Only a change that
    // adds a mutated file pays for a measurement.
    if (files.length === 0) {
      console.log('Every changed file already has a bar.');
      return 0;
    }

    console.log(`No bar yet for:\n  ${files.join('\n  ')}\n`);
    try {
      runStryker(['--mutate', files.join(',')]);
    } catch (error) {
      // Overwhelmingly this is a file with no test of its own. Stryker asks vitest which tests
      // relate to the mutated files, vitest resolves that through imports, and a file nothing
      // imports relates to nothing - so the run ends with "No tests were executed" rather than a
      // score. Untested is the finding, and a stack trace buries it.
      console.error(`\nCould not measure: ${error.message}`);
      console.error(
        '\nIf that says no tests were executed, nothing imports these files - they have',
      );
      console.error(
        'no tests of their own. Write one, then push; a file with no test cannot have a',
      );
      console.error('bar, and without a bar nothing will ever notice its tests rotting.');
      return 1;
    }

    const fresh = newBaselines(judge(files, baseline, readReport()));
    if (Object.keys(fresh).length === 0) {
      console.log('Nothing mutable in them, so there is no bar to record.');
      return 0;
    }

    writeBaseline(fresh);
    for (const [file, score] of Object.entries(fresh)) console.log(`  RECORDED ${file}: ${score}%`);
    console.error(
      '\nmutation-baseline.json has bars that are not committed yet. Commit it, then push.',
    );
    return 1;
  } else if (command === 'check') {
    const baseIndex = argv.indexOf('--base');
    const base = baseIndex === -1 ? 'origin/main' : argv[baseIndex + 1];
    const files = changedFiles(base);

    if (files.length === 0) {
      console.log('No mutated files changed - nothing to check.');
      return 0;
    }

    console.log(`Mutating ${files.length} changed file(s):\n  ${files.join('\n  ')}\n`);
    runStryker(['--mutate', files.join(',')]);

    const verdicts = compare(files, { verbose: true });
    if (reportRegressions(regressionsIn(verdicts))) return 1;

    const fresh = newBaselines(verdicts);
    if (Object.keys(fresh).length > 0) {
      writeBaseline(fresh);
      for (const [file, score] of Object.entries(fresh)) {
        console.log(`  RECORDED ${file}: ${score}% - it had no bar until now`);
      }
    }
    console.log('\nNo file scored below its baseline.');
  } else if (command === 'check-all') {
    const files = Object.keys(readReport().scores);
    const verdicts = compare(files);
    if (reportRegressions(regressionsIn(verdicts))) return 1;

    // The sweep records anything the per-change path did not - a file that reached main without
    // one, because its PR predated the ratchet or changed nothing the paths filter matches.
    const fresh = newBaselines(verdicts);
    if (Object.keys(fresh).length > 0) {
      writeBaseline(fresh);
      for (const [file, score] of Object.entries(fresh)) {
        console.log(`  RECORDED ${file}: ${score}% - it had no bar until now`);
      }
    }
    console.log(`No file scored below its baseline (${files.length} checked).`);
  } else {
    console.error(
      'Usage: mutation-ratchet.mjs check [--base <ref>] | check-all | update | record | record-new',
    );
    return 2;
  }
  return 0;
}

// Importing this for its functions must not run a command.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
