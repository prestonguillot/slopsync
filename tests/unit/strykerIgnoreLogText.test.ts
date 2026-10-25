/**
 * The ignore-plugin that keeps log wording out of the mutation score
 * (scripts/stryker-ignore-log-text.mjs).
 *
 * A fifth of every survivor list in this repo was the text of a log line: rewording one is not a
 * behaviour change, so no test fails, so it survives forever. The danger of removing that noise is
 * removing signal with it - `excludedMutations: ['StringLiteral']` would also stop measuring
 * `secure: NODE_ENV === 'production'`, `sameSite: 'strict'` and `hmac.digest('hex')`, which is why
 * this is a plugin that names what it ignores rather than a mutator switch.
 *
 * So what these pin is the NARROWNESS. Over-matching here does not fail anything; it quietly stops
 * measuring code, and the score goes UP as it does.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { Mutant } from '@stryker-mutator/api/core';
import { LogTextIgnorer } from '../../scripts/stryker-ignore-log-text.mjs';

// @babel/traverse ships CJS; under ESM the callable hides behind .default.
const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

const ignorer = new LogTextIgnorer();

/** Every string/template literal in `code`, with the ignorer's verdict on it. */
function verdicts(code: string): Array<{ text: string; ignored: boolean }> {
  const found: Array<{ text: string; ignored: boolean }> = [];
  traverse(parse(code, { sourceType: 'module', plugins: ['typescript'] }), {
    StringLiteral: (path) => {
      found.push({ text: path.node.value, ignored: !!ignorer.shouldIgnore(path) });
    },
    TemplateLiteral: (path) => {
      found.push({
        text: path.node.quasis.map((q) => q.value.raw).join('${}'),
        ignored: !!ignorer.shouldIgnore(path),
      });
    },
  });
  return found;
}

const isIgnored = (code: string, text: string) =>
  verdicts(code).find((v) => v.text === text)?.ignored;

describe('what it ignores', () => {
  it.each([
    ["Logger.info('Reconciling YouTube playlist');", 'Reconciling YouTube playlist'],
    ["Logger.warn('Could not fetch', { url });", 'Could not fetch'],
    ["Logger.error('Failed', {}, error);", 'Failed'],
    ["Logger.debug('CSRF token components', { a });", 'CSRF token components'],
  ])('ignores the message in %s', (code, text) => {
    expect(isIgnored(code, text)).toBe(true);
  });

  // The client scripts log through a global of the same shape, lowercased in some files.
  it('ignores a lowercase logger too', () => {
    expect(isIgnored("logger.info('starting up');", 'starting up')).toBe(true);
  });

  it('ignores a template-literal message', () => {
    const code = 'Logger.debug(`Scraping YouTube for: "${query}"`);';
    expect(verdicts(code)[0]).toMatchObject({ ignored: true });
  });

  it('gives a reason, so the report says why', () => {
    const found = verdicts("Logger.info('anything');");
    expect(found).toHaveLength(1);
    // The reason is what makes an ignored mutant labelled rather than hidden.
    const code = "Logger.info('anything');";
    let reason: string | undefined;
    traverse(parse(code, { sourceType: 'module' }), {
      StringLiteral: (path) => {
        reason = ignorer.shouldIgnore(path);
      },
    });
    expect(reason).toContain('log wording');
  });
});

/**
 * Each of these is a real line from this repo, and each is a string literal that decides something.
 * If any of them starts being ignored, the score rises while the app stops being measured.
 */
describe('what it must never ignore', () => {
  it.each([
    ["const opts = { secure: process.env.NODE_ENV === 'production' };", 'production'],
    ["const opts = { sameSite: 'strict' };", 'strict'],
    ["function sign() { return hmac.digest('hex'); }", 'hex'],
    ["youtube.playlists.insert({ status: { privacyStatus: 'private' } });", 'private'],
    ["await youtubeWrite('playlistItems.insert', fn);", 'playlistItems.insert'],
    ["const scopes = ['playlist-read-private'];", 'playlist-read-private'],
    [
      "res.redirect('/?error=youtube&reason=quota_exceeded');",
      '/?error=youtube&reason=quota_exceeded',
    ],
    ["if (item.snippet?.title === 'My Playlist (from Spotify)') {}", 'My Playlist (from Spotify)'],
  ])('measures %s', (code, text) => {
    expect(isIgnored(code, text)).toBe(false);
  });

  // The values in a log's context are real data, and this app's own rule is that an unexpected API
  // response must log its status, url and a body snippet. Only the wording is noise.
  it('measures a string that is a VALUE in a log context, not the message', () => {
    const code = "Logger.warn('Refused', { reason: 'quotaExceeded' });";

    expect(isIgnored(code, 'Refused')).toBe(true);
    expect(isIgnored(code, 'quotaExceeded')).toBe(false);
  });

  // A message built first and logged second is a computation, and the computation is code.
  it('measures a message that is computed before it is logged', () => {
    const code = "const msg = 'Refused: ' + reason; Logger.warn(msg);";

    expect(isIgnored(code, 'Refused: ')).toBe(false);
  });

  // Same call shape, different object: only the loggers are noise.
  it('measures a string argument to something that merely looks like a logger', () => {
    expect(isIgnored("audit.info('user deleted account');", 'user deleted account')).toBe(false);
  });
});

/**
 * The instrumenter that @stryker-mutator/core itself loads, rather than whichever copy a direct
 * dependency would resolve to. What matters is what the sweep generates: Stryker 10 added the
 * CallExpression mutator, and a plugin that only loaded cleanly let it put every log line back into
 * the score.
 */
async function strykerInstrumenter(): Promise<typeof import('@stryker-mutator/instrumenter')> {
  const fromCore = createRequire(
    createRequire(__filename).resolve('@stryker-mutator/core/package.json'),
  );
  return import(pathToFileURL(fromCore.resolve('@stryker-mutator/instrumenter')).href);
}

const silent = {
  isTraceEnabled: () => false,
  isDebugEnabled: () => false,
  isInfoEnabled: () => false,
  isWarnEnabled: () => false,
  isErrorEnabled: () => false,
  isFatalEnabled: () => false,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

/** The mutants Stryker would run against `body`, keyed by the source line each one breaks. */
async function mutantsOf(
  body: string,
): Promise<Array<{ mutator: string; line: string; ignored: boolean }>> {
  const { Instrumenter } = await strykerInstrumenter();
  const content = `function f(service, error, flag, count) {\n${body}\n}`;
  const lines = content.split('\n');
  const { mutants } = await new Instrumenter(silent).instrument(
    [{ name: 'f.ts', content, mutate: true }],
    { ignorers: [new LogTextIgnorer()], excludedMutations: [], plugins: null },
  );
  return mutants.map((m: Mutant) => ({
    mutator: m.mutatorName,
    // Stryker's locations are zero-based.
    line: lines[m.location.start.line]!.trim(),
    ignored: m.status === 'Ignored',
  }));
}

describe('deleting a log line', () => {
  it.each([
    "Logger.auth(service, 'connection validated');",
    "Logger.error('Failed', {}, error);",
    'Logger.debug(`Scraping YouTube for: "${service}"`);',
    "logger.info('starting up');",
  ])('is ignored for %s', async (line) => {
    const deletions = (await mutantsOf(line)).filter((m) => m.mutator === 'CallExpression');

    expect(deletions).toEqual([{ mutator: 'CallExpression', line, ignored: true }]);
  });

  it('still measures deleting the real call beside it', async () => {
    const mutants = await mutantsOf(
      "Logger.auth(service, 'connection validated');\nbreaker.recordSuccess();",
    );

    expect(mutants).toContainEqual({
      mutator: 'CallExpression',
      line: 'breaker.recordSuccess();',
      ignored: false,
    });
  });

  it('still measures deleting a call to something that merely looks like a logger', async () => {
    const line = 'audit.info(service);';

    expect(await mutantsOf(line)).toContainEqual({
      mutator: 'CallExpression',
      line,
      ignored: false,
    });
  });

  // Ignoring a node ignores everything beneath it, so a log line that carries real data must not
  // be ignored as a whole just to silence its deletion.
  it.each([
    ["Logger.warn('Refused', { reason: 'quotaExceeded' });", 'ObjectLiteral'],
    ["Logger.warn('Refused', { reason: 'quotaExceeded' });", 'StringLiteral'],
    ["Logger.info('Synced', count + 1);", 'ArithmeticOperator'],
  ])('leaves the data in %s measured (%s)', async (line, mutator) => {
    const measured = (await mutantsOf(line)).filter((m) => m.mutator === mutator && !m.ignored);

    expect(measured.length).toBeGreaterThan(0);
  });
});
