/**
 * Helpers every EJS template may use, independent of any request.
 *
 * Express installs these onto app.locals. Anything that renders a view WITHOUT Express has to
 * install them too - the Argos visual specs call ejs.renderFile directly - or the template throws
 * on a helper it is entitled to expect.
 *
 * Both sides import this one object, so a helper cannot reach the templates without also reaching
 * whatever renders them outside Express.
 */

import { toRansom } from './ransom';

export const viewLocals = {
  toRansom,
};
