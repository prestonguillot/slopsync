/**
 * Express application setup (without server.listen)
 * This allows the app to be imported for testing without starting the server
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'path';
import { spotifyRouter } from './routes/spotify';
import { youtubeRouter } from './routes/youtube';
import { syncRouter } from './routes/sync';
import { playlistDetailsRouter } from './routes/playlistDetails';
import playlistTracksRouter from './routes/playlistTracks';
import { Logger } from './lib/logger';
import { validateSpotifyConnection, validateYouTubeConnection } from './auth/authValidation';
import { csrfCookieMiddleware, getCsrfToken } from './auth/csrf';
import { parseSpotifyTokenCookie, parseYouTubeTokenCookie } from './auth/cookieParser';
import { enforceMinDisplayTime } from './lib/minDisplayTime';
import { viewLocals } from './lib/viewLocals';
import debugFixtures from './debug-fixtures.json';
import { setCache, CacheDuration } from './lib/cache';

export function createApp() {
  const app = express();

  // Security headers with Helmet
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // NOTE: 'unsafe-inline' for styles and scripts is necessary for this HTMX/Bootstrap architecture.
          // ARCHITECTURAL TRADEOFF: We allow 'unsafe-inline' to enable:
          // 1. HTMX inline script initialization (required for HTMX to work on initial page load)
          // 2. Bootstrap inline styles for certain components
          // 3. Dynamic HTML swapping via HTMX (safe because HTML comes from server, not user input)
          //
          // MITIGATION: No user-supplied data is embedded into inline scripts or styles. All dynamic
          // content (playlists, videos, etc.) is inserted via HTMX swap operations which target DOM
          // elements, not inline script/style content.
          //
          // FUTURE IMPROVEMENT: To remove 'unsafe-inline', we would need to:
          // - Generate random CSP nonces on each request
          // - Embed nonces in all inline scripts: <script nonce="...">
          // - Embed nonces in inline styles: <style nonce="...">
          // - Pass nonces to templates and dynamically generated HTML
          // This is possible but adds complexity; not justified for current risk level.
          // htmx, Bootstrap, and the display fonts are all self-hosted from /vendor + /fonts;
          // no external style/font origins remain.
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:', 'http:'], // Allow external images (YouTube thumbnails, etc.)
          connectSrc: ["'self'"], // Allow SSE connections to same origin
          fontSrc: ["'self'"], // self-hosted woff2 from /fonts
          frameSrc: ["'none'"],
        },
      },
      hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
      },
    }),
  );

  // Middleware
  app.use(express.json({ limit: '10kb' })); // Limit request body size to prevent DoS
  app.use(express.urlencoded({ extended: true, limit: '10kb' }));
  app.use(cookieParser());
  app.use(csrfCookieMiddleware); // CSRF protection - set token cookie on all requests

  // Request logging middleware
  app.use((req, res, next) => {
    // Skip logging for static assets and favicon to reduce noise
    if (
      req.originalUrl.includes('.css') ||
      req.originalUrl.includes('.js') ||
      req.originalUrl.includes('.png') ||
      req.originalUrl.includes('.ico') ||
      req.originalUrl.includes('/favicon')
    ) {
      return next();
    }

    const hasSpotifyToken = !!req.cookies.spotify_tokens;
    const hasYoutubeToken = !!req.cookies.youtube_tokens;

    Logger.requestStart(`${req.method} ${req.originalUrl}`, {
      fullUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
      userAgent: req.get('User-Agent')?.slice(0, 100) || 'none',
      hasAuth: hasSpotifyToken || hasYoutubeToken,
    });

    // Express 5 leaves req.body undefined when no body parser matched (e.g. GET),
    // and guard req.query defensively too.
    if (req.query && Object.keys(req.query).length > 0) {
      Logger.debug('Request query parameters', { query: req.query });
    }
    if (req.body && Object.keys(req.body).length > 0) {
      Logger.debug('Request body', { body: req.body });
    }

    // Track response completion
    res.on('finish', () => {
      Logger.debug('Response sent', {
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
      });
    });

    next();
  });

  // Static files
  app.use(express.static(path.join(__dirname, '../public')));

  // View engine setup (EJS for templating)
  app.set('views', path.join(__dirname, '../views'));
  app.set('view engine', 'ejs');

  // Available to every template, so a ransom heading can be included anywhere without each route
  // remembering to pass the helper down. The visual specs render views outside Express and install
  // the same object, rather than keeping a second copy of this list in step by hand.
  Object.assign(app.locals, viewLocals);

  // Routes
  app.use('/auth/spotify', spotifyRouter);
  app.use('/auth/youtube', youtubeRouter);
  app.use('/api/sync', syncRouter);
  app.use('/api/playlistDetails', playlistDetailsRouter);
  app.use(playlistTracksRouter);

  // Main page
  app.get('/', (req, res) => {
    // CSRF token is now available in res.locals.csrfToken (set by csrfCookieMiddleware)
    const csrfToken = getCsrfToken(req, res);

    res.render('index', { csrfToken });
  });

  // Debug/Component showcase page
  app.get('/debug/components', (_req, res) => {
    res.render('debug-components', debugFixtures);
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Connection status button endpoints
  app.get('/api/status/spotify/button', async (req, res) => {
    const startTime = Date.now();
    const spotifyTokens = parseSpotifyTokenCookie(req.cookies.spotify_tokens, res);
    const spotifyResult = await validateSpotifyConnection(spotifyTokens, res);

    await enforceMinDisplayTime(startTime);

    // Disable caching to ensure error states are always shown
    // Connection status can change (connected → error), so we must not return cached responses
    setCache(res, CacheDuration.NO_CACHE);

    res.render('partials/connection-button', {
      service: 'spotify',
      connected: spotifyResult.connected,
      unavailable: !!spotifyResult.unavailable,
      error: spotifyResult.error,
      loading: false,
    });
  });

  app.get('/api/status/youtube/button', async (req, res) => {
    const startTime = Date.now();
    const youtubeTokens = parseYouTubeTokenCookie(req.cookies.youtube_tokens, res);
    const youtubeResult = await validateYouTubeConnection(youtubeTokens, res);

    await enforceMinDisplayTime(startTime);

    // Disable caching to ensure error states are always shown
    // Connection status can change (connected → error), so we must not return cached responses
    setCache(res, CacheDuration.NO_CACHE);

    res.render('partials/connection-button', {
      service: 'youtube',
      connected: youtubeResult.connected,
      unavailable: !!youtubeResult.unavailable,
      error: youtubeResult.error,
      loading: false,
    });
  });

  // 404 handler - must come after all other routes
  app.use((req, res) => {
    res.status(404).render('partials/error-message', {
      type: 'warning',
      message: 'Page not found',
      details: `Cannot ${req.method} ${req.originalUrl}`,
    });
  });

  // Global error handler - must be last
  app.use(
    (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
      Logger.error('Unhandled error', { url: req.originalUrl, method: req.method }, err);

      // Don't expose error details in production
      const message = err instanceof Error ? err.message : 'Something went wrong';
      const errorDetails =
        process.env.NODE_ENV === 'development' ? message : 'Something went wrong';
      const status =
        typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
          ? err.status
          : 500;

      res.status(status).render('partials/error-message', {
        type: 'danger',
        message: 'Internal server error',
        details: errorDetails,
      });
    },
  );

  return app;
}
