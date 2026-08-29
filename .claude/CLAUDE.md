# Project Instructions & Conventions

The single source of truth for how to work in this repo. Auto-loaded into context.

## Working with me (the human)

- **Always include my exact prompt(s), verbatim, in the git commits you create** (see
  Git Commit Workflow below).
- **Default to "the HTMX way."** If unsure whether something fits the architecture, ask
  before implementing a non-standard solution.

## Architecture Principles

### HTMX Philosophy

- **Server is the source of truth** for data and business logic.
- **Client manages its own UI state** (auth tokens, preferences).
- **Server holds no per-request or session state** — auth is proven on each request.
- Use HTTP caching headers instead of manual client-side caching.
- Prefer standard HTTP mechanisms (and standard HTML) over custom solutions.

### Authentication

- **OAuth tokens live client-side** (httpOnly cookies), sent with each request.
- **The server validates tokens on demand** — it doesn't remember who you are; you
  prove it every request. No server-side session state.

### State Management

- **Server-side:** business logic, data fetching, validation.
- **Client-side:** UI state, auth tokens, user preferences.
- **HTTP caching:** `Cache-Control` headers for data caching.
- **sessionStorage:** only for temporary UI state within a page session.

### Multi-Instance / Stateless Server

- The server keeps **no per-request or session state**: auth is cookie-based and
  validated on demand, and a sync runs entirely within its own SSE request (it does not
  use a shared in-memory progress map and does not need sticky sessions).
- **Externalize shared configuration:** CSRF secret, API keys, and config come from
  environment variables — never generated per instance, and never committed to source
  control.
- The only per-instance state is **operational, not user/session data**: the YouTube
  circuit breaker and the write-quota counter (`src/youtube/writes.ts`). These are
  local protection/diagnostics and are acceptable per-instance — correctness doesn't
  depend on sharing them.

## Development Practices

### Code Style

- Use HTTP standards (headers, status codes, caching) over custom mechanisms; keep
  server logic simple and stateless.
- **Prefer native HTML elements over custom JS widgets** — standard `<select>`,
  `<input>`, `<button>`, `<dialog>`, `<details>`, etc. Native elements are more
  accessible and maintainable; some styling limits are an acceptable tradeoff.
- **Separate HTML from TypeScript** — all HTML responses render from EJS templates in
  `views/`, never embedded as string literals in route files. (Better escaping/XSS
  safety, easier maintenance, clear separation of concerns.)
- **All CSS lives in `public/css/` files.** No `<style>` tags in templates/responses,
  no CSS-in-JS.
  - **Exception:** an inline `style` attribute is allowed _only_ to pass a
    server-computed dynamic value as a CSS custom property — e.g.
    `style="--progress-width: <%= percentage %>%"` consumed by a class in the
    stylesheet. Static styling must never be inline.
  - Bootstrap utility classes and HTML `data-*` attributes are fine.

### Type Safety

- **Be as type-safe as possible.** Avoid `as any` casts — they hide bugs. Use proper
  types/interfaces; lean on Zod schemas for runtime validation _and_ type inference.
  Middleware that transforms request data must type the transformed values.

### Refactoring & Cleanup

- **No dead code** — unused functions, variables, imports, or commented-out code. When
  replacing code, verify the old code is unreferenced, then delete it entirely.

### Project structure & duplication

- **`src/` is organized by domain** — put new code where it belongs:
  - `src/routes/` — Express HTTP handlers.
  - `src/spotify/`, `src/youtube/` — each external API's client, auth/token logic, and
    helpers.
  - `src/sync/` — the sync/matching domain (track matching, reconcile, video search,
    the playlist-details service).
  - `src/auth/` — cookies, CSRF, connection/token validation.
  - `src/lib/` — cross-cutting helpers (logger, cache, circuit breaker, request
    validation, env validation, html escaping).
  - `src/types/` — shared type definitions.
- **Eliminate duplication.** A single source of truth prevents bugs that only get fixed
  in one copy; shared logic belongs in the domain folder above, not copy-pasted per route.

### Testing

- **Run `npm run test:run` after every change** and keep it green.
- **Cover new functionality with tests** — happy paths _and_ error cases.
- **Test behavior, not implementation.** When a test fails, the new code is the more
  likely culprit than the test.
- The app logger is silenced during tests (`LOG_LEVEL=silent`); to debug a failing test
  you can temporarily set it to `error` in `vitest.config.ts`.
- **Coverage is not the measure — mutation score is.** Coverage proves a line ran, not
  that anything asserted it. `npm run test:mutation` scores the suite by breaking the
  source and reporting what no test noticed.
- **A new file must arrive with its mutation bar.** `mutation-baseline.json` records a
  score per file and the ratchet fails anything that drops below its own entry. A file
  with no entry cannot be "worse" than one, so it is exempt until somebody records it.
  The `pre-push` hook (`.githooks/pre-push`, installed by `npm install`) measures any
  changed file that has no bar and writes one — commit it alongside the code. It costs a
  git diff unless you actually added a file.
- The weekly sweep records anything that reached `main` without a bar and opens a PR for
  it. That is a backstop for a skipped hook, not the intended route.

### Logging

- **Never call `console.*` directly.** Use the centralized Logger:
  `src/lib/logger.ts` server-side, `public/js/logger.js` client-side (same API:
  `debug`/`info`/`warn`/`error`). This gives one log-level control point, consistent
  formatting, and emoji categorization.

### Security notes (evaluated, NOT vulnerabilities)

- **IDOR on the playlist-button endpoint** — Spotify's API validates playlist access via
  the user's OAuth token, and public playlists are enumerable by design. No server-side
  ownership check needed.
- **Weak token-format validation** — strict format regexes are redundant; Spotify/YouTube
  reject invalid tokens on every call.

## Git Commit Workflow

- **Before pausing for input, commit all changes.**
- **Include ALL user prompts since the last commit, verbatim and in order**, followed by
  a short summary of any discussion/clarification, then the implementation details and
  test results.

```
<user's exact prompt 1>

Discussion/Clarification:
- We discussed X and concluded Y

<user's exact prompt 2 (if any)>

Implementation:
- Changed A to B; added C for D
- All tests passing (N tests)
```

This keeps the history capturing what was asked, how it was discussed, and why.
