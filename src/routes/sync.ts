import { Router, Request, Response } from 'express';
import { ensureValidYouTubeToken } from '../youtube/auth';
import {
  classifyYoutubeError,
  describeRetryWait,
  youtubeWritesBlocked,
  YoutubeQuotaError,
} from '../youtube/writes';
import { Logger } from '../lib/logger';
import { renderPartial } from '../lib/renderPartial';
import { validate, schemas, ValidatedRequest } from '../lib/validation';
import { csrfValidationMiddleware } from '../auth/csrf';
import { authExpired, signalAuthExpired } from '../auth/authExpired';
import { SpotifyTokens, YouTubeTokens } from '../types/oauth';
import { parseSpotifyTokenCookie, parseYouTubeTokenCookie } from '../auth/cookieParser';
import { z } from 'zod';
import { formatErrorDetails } from '../lib/errorFormatter';
import { ensureValidSpotifyToken } from '../spotify/auth';
import { runSync } from '../sync/runSync';
import { ProgressUpdate } from '../types/progress';

const router = Router();

type YoutubeClient = Awaited<ReturnType<typeof ensureValidYouTubeToken>>['client'];

// Helper function to get YouTube user ID from cached channel ID in tokens
function getYouTubeUserId(youtubeTokens: YouTubeTokens): string {
  if (!youtubeTokens.channel_id) {
    throw new Error('YouTube channel ID not found in tokens - re-authenticate with YouTube');
  }
  return youtubeTokens.channel_id;
}

// POST returns the SSE subscriber fragment (CSRF-protected); it does no work.
// The subscriber connects to the stream below, which runs the sync.
router.post(
  '/playlist/:playlistId',
  csrfValidationMiddleware,
  validate({
    params: z.object({ playlistId: schemas.spotifyPlaylistId }),
    body: z.object({ batchSize: schemas.batchSize.optional() }),
  }),
  async (
    req: ValidatedRequest<{ playlistId: string }, Record<string, unknown>, { batchSize?: string }>,
    res,
  ) => {
    const html = await renderPartial('sync-subscriber.ejs', {
      id: req.params.playlistId,
      batchSize: req.body.batchSize || '1',
    });
    res.send(html);
  },
);

// SSE stream: authenticates (before opening the stream, so token-refresh cookies
// can be set), then runs the sync and streams progress -> result -> errors as
// `message` frames, ending with a `close` frame. Same-origin only (SameSite=strict
// cookies) so a GET trigger is CSRF-safe.
router.get(
  '/playlist/:playlistId/stream',
  validate({
    params: z.object({ playlistId: schemas.spotifyPlaylistId }),
    query: z.object({ batchSize: schemas.batchSize.optional() }),
  }),
  async (req: ValidatedRequest<{ playlistId: string }, { batchSize?: string }>, res: Response) => {
    const playlistId = req.params.playlistId;
    Logger.requestStart('Sync stream started', { playlistId, requestUrl: req.originalUrl });

    // --- Authentication (must complete before the SSE headers are written) ---
    const spotifyTokens: SpotifyTokens | null = parseSpotifyTokenCookie(
      req.cookies.spotify_tokens,
      res,
    );
    const youtubeTokens: YouTubeTokens | null = parseYouTubeTokenCookie(
      req.cookies.youtube_tokens,
      res,
    );
    if (!spotifyTokens || !youtubeTokens) {
      const service = !spotifyTokens ? 'Spotify' : 'YouTube';
      const html = await renderPartial('sync-error.ejs', {
        playlistId,
        title: `${service} Authentication Required`,
        message: `Please connect to ${service} first using the connection button at the top of the page.`,
      });
      return res.status(401).send(html);
    }

    let spotifyAccessToken: string;
    let youtube: YoutubeClient;
    let initialQuotaUsed: number;
    try {
      spotifyAccessToken = await ensureValidSpotifyToken(req as Request, res);
      const yt = await ensureValidYouTubeToken(req as Request, res);
      youtube = yt.client;
      initialQuotaUsed = yt.quotaUsed;
      getYouTubeUserId(youtubeTokens); // validates channel id is present
    } catch (error) {
      const expired = authExpired(error);
      if (expired) {
        signalAuthExpired(res, expired);
        return res.status(401).send(await renderPartial('auth-expired.ejs', { ...expired }));
      }
      Logger.error('Sync stream auth failed', { playlistId }, error);
      const html = await renderPartial('sync-error.ejs', {
        playlistId,
        title: 'Authentication Error',
        message: 'Failed to verify your connection. Please try reconnecting.',
      });
      return res.status(500).send(html);
    }

    // --- Open the stream ---
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': stream open\n\n');

    const emit = (html: string) => {
      if (res.writable && !res.writableEnded) {
        res.write(`event: message\ndata: ${html.replace(/\s+/g, ' ').trim()}\n\n`);
      }
    };
    const emitProgress = async (update: ProgressUpdate) => {
      emit(
        await renderPartial('progress-update.ejs', {
          message: update.message,
          details: update.details,
          percentage: update.percentage || 0,
          type: update.type,
        }),
      );
    };

    const abortController = new AbortController();
    let clientClosed = false;
    req.on('close', () => {
      clientClosed = true;
      abortController.abort();
    });

    try {
      await runSync({
        playlistId,
        batchSizeRaw: req.query.batchSize,
        spotifyAccessToken,
        youtube,
        initialQuotaUsed,
        emit,
        emitProgress,
        signal: abortController.signal,
      });
    } catch (error) {
      Logger.error('Error syncing playlist', {}, error);
      let html: string;
      // 'quota' (daily budget gone) and 'rate-limit' (transient throttle) both mean YouTube refused
      // on limits; anything else is a real error.
      const failure = classifyYoutubeError(error);
      if (failure !== 'other') {
        Logger.warn('YouTube refused the sync on limits', { failure });
        // Not always the daily quota: the breaker also opens after unrelated failures, and this
        // said "your quota has been exceeded" for all of them - sending people to wait for a
        // midnight reset that was never the problem.
        const blocked = youtubeWritesBlocked();
        const reason =
          error instanceof YoutubeQuotaError ? error.reason : 'YouTube refused the request';
        // No HX-Trigger here, unlike the other routes: the SSE headers went out with writeHead
        // before the sync began, and setting one now throws ERR_HTTP_HEADERS_SENT. The partial
        // carries a marker instead and the client raises the event when it lands.
        html = await renderPartial('sync-error.ejs', {
          playlistId,
          youtubeBlocked: true,
          title: 'YouTube is not accepting changes',
          message: `The sync stopped because ${reason}.`,
          details: blocked
            ? `Syncing is paused until this clears - try again ${describeRetryWait(blocked.retryAt)}. A daily quota resets at midnight Pacific.`
            : 'Try again shortly. A daily quota resets at midnight Pacific.',
        });
      } else {
        html = await renderPartial('sync-error.ejs', {
          playlistId,
          title: 'Error syncing playlist',
          message: `Something went wrong during the sync process. Please try again. Details: ${formatErrorDetails(error)}`,
        });
      }
      emit(html);
    } finally {
      if (!clientClosed && res.writable && !res.writableEnded) {
        res.write('event: close\ndata: {}\n\n');
        res.end();
      }
    }
    return;
  },
);

export { router as syncRouter };
