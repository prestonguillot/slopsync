/**
 * Helpers every EJS template may use, independent of any request.
 *
 * Express installs these once onto app.locals. Anything that renders a view WITHOUT Express has to
 * install them too - the Argos visual specs call ejs.renderFile directly - or the template throws
 * on a helper the app has always handed it.
 *
 * That is not hypothetical: index.ejs gained a ransom heading, and every full-page visual capture
 * died with "toRansom is not defined" for weeks. Nothing caught it, because Argos is not a required
 * check and the failure lives outside the app.
 *
 * So both sides import this one object: a helper cannot reach the templates without also reaching
 * whatever renders them outside Express.
 */

import { toRansom } from './ransom';

export const viewLocals = {
  toRansom,
};
