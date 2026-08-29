/**
 * The mutation ratchet (scripts/mutation-ratchet.mjs) is what stands between this repo and a test
 * suite that quietly stops testing. It had four bugs in a day, every one of them found by accident,
 * and every one the same shape: it reported success when nothing had been measured. A gate that
 * fails open is worse than no gate, because the green tick is believed.
 *
 * Its decisions are pure functions - data in, verdict out - and these are the tests for them. The
 * disk, git and stryker parts are the command handlers, which are not tested here: they are what
 * the CI job itself exercises on every run.
 */

import { describe, it, expect } from 'vitest';

import strykerConfig from '../../stryker.config.mjs';
import {
  makeMutatedMatcher,
  parseReport,
  judge,
  regressionsIn,
  newBaselines,
  mergeBaseline,
  summaryTable,
  type Verdict,
} from '../../scripts/mutation-ratchet.mjs';

/** A stryker report, keyed by absolute path the way stryker writes it. */
const reportOf = (files: Record<string, string[]>, cwd = '/repo') => ({
  files: Object.fromEntries(
    Object.entries(files).map(([file, statuses]) => [
      `${cwd}/${file}`,
      { mutants: statuses.map((status) => ({ status })) },
    ]),
  ),
});

const measured = (files: Record<string, string[]>) => parseReport(reportOf(files), '/repo');

describe('which files stryker mutates', () => {
  // The real globs: a copy would let this agree with itself while disagreeing with stryker.
  const globs = strykerConfig.mutate as string[];
  const isMutated = makeMutatedMatcher(globs);

  it.each([['src/routes/sync.ts'], ['src/lib/logger.ts'], ['public/js/videoModal.js']])(
    'mutates %s',
    (file) => expect(isMutated(file)).toBe(true),
  );

  it.each([['src/types/spotify.ts'], ['src/server.ts'], ['public/vendor/htmx.min.js']])(
    'does not mutate %s',
    (file) => expect(isMutated(file)).toBe(false),
  );

  /**
   * The globs are include-minus-exclude. picomatch given the array ORs them, and reads a leading
   * `!` as "anything but this" - so `!src/types/**` alone matches every test file and template in
   * the repo. Getting this wrong does not throw; `check` just decides a test-only change touched a
   * mutated file, or that nothing changed at all.
   */
  it.each([['tests/unit/logger.test.ts'], ['views/index.ejs'], ['package.json']])(
    'does not mutate %s, which no include names',
    (file) => expect(isMutated(file)).toBe(false),
  );
});

describe('reading a stryker report', () => {
  it('scores killed against the mutants that could have been killed', () => {
    const { scores } = measured({ 'src/a.ts': ['Killed', 'Killed', 'Survived', 'NoCoverage'] });

    expect(scores['src/a.ts']).toBe(50);
  });

  // A mutant nothing could distinguish is not evidence either way, and stryker excludes it too.
  it('does not count Ignored mutants against the score', () => {
    const { scores } = measured({ 'src/a.ts': ['Killed', 'Ignored', 'Ignored'] });

    expect(scores['src/a.ts']).toBe(100);
  });

  it('counts a Timeout as killed: the test noticed', () => {
    const { scores } = measured({ 'src/a.ts': ['Timeout', 'Survived'] });

    expect(scores['src/a.ts']).toBe(50);
  });

  it('counts NoCoverage against the score, like a survivor', () => {
    const { scores } = measured({ 'src/a.ts': ['Killed', 'NoCoverage'] });

    expect(scores['src/a.ts']).toBe(50);
  });

  it('rounds to two places', () => {
    const { scores } = measured({ 'src/a.ts': ['Killed', 'Survived', 'Survived'] });

    expect(scores['src/a.ts']).toBe(33.33);
  });

  /**
   * The distinction the whole `reported` set exists for. A file with nothing to mutate is fine; a
   * file the run never reached is not. Both are absent from `scores`, so only `reported` separates
   * them - and one of them must fail the build.
   */
  it('reports a file with no mutants, but gives it no score', () => {
    const { scores, reported } = measured({ 'src/empty.ts': [] });

    expect(reported.has('src/empty.ts')).toBe(true);
    expect(scores).not.toHaveProperty('src/empty.ts');
  });

  it('keys scores relative to the repo, not by stryker absolute paths', () => {
    const { scores } = measured({ 'src/a.ts': ['Killed'] });

    expect(Object.keys(scores)).toEqual(['src/a.ts']);
  });
});

describe('judging a file against its baseline', () => {
  const baseline = { 'src/a.ts': 80 };

  it('passes a file that held its score', () => {
    const [verdict] = judge(
      ['src/a.ts'],
      baseline,
      measured({ 'src/a.ts': Array(80).fill('Killed').concat(Array(20).fill('Survived')) }),
    );

    expect(verdict).toMatchObject({ status: 'ok', before: 80, now: 80 });
  });

  it('fails a file that dropped', () => {
    const verdicts = judge(['src/a.ts'], baseline, {
      scores: { 'src/a.ts': 60 },
      reported: new Set(['src/a.ts']),
    });

    expect(verdicts[0]).toMatchObject({ status: 'worse', before: 80, now: 60 });
    expect(regressionsIn(verdicts)).toHaveLength(1);
  });

  // Mutant counts shift by one or two as code moves around; a bar that fails on that is a bar
  // people learn to re-record without reading.
  it('tolerates a point of drift', () => {
    const verdicts = judge(['src/a.ts'], baseline, {
      scores: { 'src/a.ts': 79.5 },
      reported: new Set(['src/a.ts']),
    });

    expect(verdicts[0]!.status).toBe('ok');
  });

  it('fails a drop of just over a point', () => {
    const verdicts = judge(['src/a.ts'], baseline, {
      scores: { 'src/a.ts': 78.9 },
      reported: new Set(['src/a.ts']),
    });

    expect(verdicts[0]!.status).toBe('worse');
  });

  // The edge of the tolerance, named exactly: a point down is drift, and anything past it is not.
  it('passes a drop of exactly a point', () => {
    const verdicts = judge(['src/a.ts'], baseline, {
      scores: { 'src/a.ts': 79 },
      reported: new Set(['src/a.ts']),
    });

    expect(verdicts[0]!.status).toBe('ok');
  });

  /**
   * The bug that made the gate meaningless: a file asked for and not in the report scored nothing,
   * and scoring nothing read as scoring fine. A stryker run that skips a file must not pass it.
   */
  it('fails a file the run never measured', () => {
    const verdicts = judge(['src/a.ts'], baseline, { scores: {}, reported: new Set() });

    expect(verdicts[0]).toMatchObject({ status: 'unmeasured', before: 80, now: undefined });
    expect(regressionsIn(verdicts)).toHaveLength(1);
  });

  it('fails an unmeasured file that has no baseline either', () => {
    const verdicts = judge(['src/new.ts'], {}, { scores: {}, reported: new Set() });

    expect(regressionsIn(verdicts)).toHaveLength(1);
  });

  it('does not fail a new file, because it has nothing to be worse than', () => {
    const verdicts = judge(['src/new.ts'], baseline, measured({ 'src/new.ts': ['Survived'] }));

    expect(verdicts[0]).toMatchObject({ status: 'new', before: undefined, now: 0 });
    expect(regressionsIn(verdicts)).toEqual([]);
  });

  it('hands a new file its first bar, so it does not stay exempt', () => {
    // Passing is only half of it. A file with no baseline can never be 'worse', so without this it
    // sits unratcheted for as long as nobody re-records by hand - which is how src/lib/ransom.ts
    // spent six weeks at 67% while the gate reported success.
    const verdicts = judge(
      ['src/new.ts', 'src/a.ts'],
      baseline,
      measured({ 'src/new.ts': ['Killed', 'Survived'], 'src/a.ts': ['Killed'] }),
    );

    // Only the one without a bar; the file that already has one keeps the bar it has.
    expect(newBaselines(verdicts)).toEqual({ 'src/new.ts': 50 });
  });

  it('records nothing for a file that was never measured', () => {
    // 'unmeasured' already fails the run. Recording a bar from a file the run never reached would
    // write a number nothing earned, on top of a failure.
    const verdicts = judge(['src/new.ts'], {}, { scores: {}, reported: new Set() });

    expect(newBaselines(verdicts)).toEqual({});
  });

  it('records nothing when every file already has a bar', () => {
    const verdicts = judge(['src/a.ts'], baseline, measured({ 'src/a.ts': ['Killed'] }));

    expect(newBaselines(verdicts)).toEqual({});
  });

  it('passes a file with nothing in it to mutate', () => {
    const verdicts = judge(['src/empty.ts'], baseline, measured({ 'src/empty.ts': [] }));

    expect(verdicts[0]!.status).toBe('nothing-mutable');
    expect(regressionsIn(verdicts)).toEqual([]);
  });

  it('judges every file it is given', () => {
    const verdicts = judge(
      ['src/a.ts', 'src/b.ts'],
      { 'src/a.ts': 80, 'src/b.ts': 50 },
      {
        scores: { 'src/a.ts': 80, 'src/b.ts': 10 },
        reported: new Set(['src/a.ts', 'src/b.ts']),
      },
    );

    expect(verdicts.map((v) => v.status)).toEqual(['ok', 'worse']);
  });
});

/**
 * A scoped run reports only the files it mutated. Replacing the baseline wholesale with its scores
 * would drop every other file's record - the ratchet forgetting everything, reported as a routine
 * re-record. This nearly happened: an 11-file run would have moved 21 files' bars.
 */
describe('re-recording the baseline', () => {
  const tracked = () => true;

  it('keeps the files a scoped run did not measure', () => {
    const merged = mergeBaseline({ 'src/a.ts': 90 }, { 'src/a.ts': 80, 'src/b.ts': 70 }, tracked);

    expect(merged).toEqual({ 'src/a.ts': 90, 'src/b.ts': 70 });
  });

  it('takes the new score for a file that was measured', () => {
    const merged = mergeBaseline({ 'src/a.ts': 40 }, { 'src/a.ts': 80 }, tracked);

    expect(merged['src/a.ts']).toBe(40);
  });

  it('forgets a file that is gone or no longer mutated', () => {
    const merged = mergeBaseline(
      {},
      { 'src/a.ts': 80, 'src/gone.ts': 70 },
      (f) => f !== 'src/gone.ts',
    );

    expect(merged).toEqual({ 'src/a.ts': 80 });
  });

  // Written to git on every re-record: unsorted, the diff is unreadable and nobody checks it.
  it('sorts by path', () => {
    const merged = mergeBaseline({ 'src/z.ts': 1, 'src/a.ts': 2 }, { 'src/m.ts': 3 }, tracked);

    expect(Object.keys(merged)).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });
});

describe('the CI summary table', () => {
  const held: Verdict[] = [{ file: 'src/a.ts', before: 80, now: 80, status: 'ok' }];
  const dropped: Verdict[] = [
    { file: 'src/a.ts', before: 80, now: 80, status: 'ok' },
    { file: 'src/b.ts', before: 80, now: 10, status: 'worse' },
  ];

  /**
   * Asserted whole. GitHub renders this as a table only if the separator row and the newlines are
   * there; lose them and the summary is a wall of pipes, which reads as the job being broken.
   */
  it('renders as a markdown table GitHub can display', () => {
    expect(summaryTable(held)).toBe(
      [
        '## Mutation score held',
        '',
        '| File | Baseline | Now | |',
        '| --- | --- | --- | --- |',
        '| src/a.ts | 80% | 80% | ok |',
        '',
      ].join('\n'),
    );
  });

  it('says so when something dropped', () => {
    expect(summaryTable(dropped)).toContain('## Mutation score regressed');
  });

  // A hundred rows of ok is where a worse goes to hide.
  it('shows only what needs reading when something dropped', () => {
    const table = summaryTable(dropped);

    expect(table).toContain('| src/b.ts | 80% | 10% | **worse** |');
    expect(table).not.toContain('src/a.ts');
  });

  it('renders an unmeasured file as measured by nothing, not as zero', () => {
    const table = summaryTable([
      { file: 'src/a.ts', before: 80, now: undefined, status: 'unmeasured' },
    ]);

    expect(table).toContain('| src/a.ts | 80% | – | **not measured** |');
  });

  it('leaves out files with nothing to mutate', () => {
    const table = summaryTable([
      { file: 'src/empty.ts', before: undefined, now: undefined, status: 'nothing-mutable' },
    ]);

    expect(table).not.toContain('src/empty.ts');
  });
});
