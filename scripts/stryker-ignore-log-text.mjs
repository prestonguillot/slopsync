import { PluginKind, declareClassPlugin } from '@stryker-mutator/api/plugin';

const REASON = 'log wording: asserting it pins the message rather than any behaviour';

/**
 * The names the app logs through. `Logger` is the server-side one (src/lib/logger.ts); the client
 * scripts use a `Logger` global of the same shape (public/js/logger.js).
 *
 * `console` is deliberately absent. Nothing outside the two loggers is allowed to call it, and the
 * calls inside them pass a built-up variable rather than a literal - so listing it would ignore
 * nothing, while widening what this can reach.
 */
const LOGGER_OBJECTS = new Set(['Logger', 'logger']);

/**
 * Ignore mutants in the TEXT a log line says.
 *
 * Rewording a log message is not a behaviour change, so no test fails, so every one of them
 * survives - about a fifth of every survivor list in this repo, which is a fifth of the noise to
 * read past when deciding what actually needs a test.
 *
 * This ignores only string literals and template literals passed DIRECTLY to a log call. It does
 * not touch:
 * - the context object (`Logger.warn(msg, { status, url })`), where the VALUES are real data and
 *   the app's own rule is that an unexpected API response must log status, url and a body snippet;
 * - anything computed and then logged, since the computation is the code under test;
 * - string literals anywhere else, which is why this is a plugin and not
 *   `excludedMutations: ['StringLiteral']` - that would also stop measuring
 *   `secure: NODE_ENV === 'production'`, `sameSite: 'strict'`, `hmac.digest('hex')` and
 *   `privacyStatus: 'private'`.
 *
 * Ignored mutants are still reported, with this reason attached. They are labelled, not hidden.
 */
export class LogTextIgnorer {
  shouldIgnore(path) {
    if (path.isExpressionStatement()) return isBareLogLine(path) ? REASON : undefined;
    if (!path.isStringLiteral() && !path.isTemplateLiteral()) return undefined;

    const call = path.parentPath;
    if (!call?.isCallExpression() || !isLoggerCall(call)) return undefined;
    // Only a direct argument. A literal nested inside an object or an expression is something else.
    return call.get('arguments').some((arg) => arg.node === path.node) ? REASON : undefined;
  }
}

/**
 * A log statement whose every argument is wording or a plain name - the line Stryker's
 * CallExpression mutator deletes.
 *
 * That mutator deletes a call statement only where the deletion is the sole mutant left in it: a
 * log call with a real context object yields mutants in the object and no deletion at all. So the
 * deletion only ever lands on a log line with nothing else in it to measure, and that is the shape
 * this ignores. Ignoring a node ignores everything beneath it, which is why an argument that could
 * itself be mutated - `{ status, url }`, a call, an expression - leaves the whole line measured.
 */
function isBareLogLine(statement) {
  const call = statement.get('expression');
  return call.isCallExpression() && isLoggerCall(call) && call.get('arguments').every(isInert);
}

function isInert(arg) {
  return (
    arg.isStringLiteral() ||
    arg.isTemplateLiteral() ||
    arg.isIdentifier() ||
    (arg.isObjectExpression() && arg.node.properties.length === 0)
  );
}

function isLoggerCall(call) {
  const callee = call.get('callee');
  if (!callee.isMemberExpression()) return false;
  const object = callee.get('object');
  return object.isIdentifier() && LOGGER_OBJECTS.has(object.node.name);
}

export const strykerPlugins = [declareClassPlugin(PluginKind.Ignore, 'log-text', LogTextIgnorer)];
