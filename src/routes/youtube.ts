import { Router } from 'express';
import { Logger } from '../lib/logger';
import { getSecureCookieOptions } from '../auth/cookieParser';
import { issueOAuthState, verifyOAuthState, canonicalLoginUrl } from '../auth/oauthState';
import { validate, schemas, ValidatedRequest } from '../lib/validation';
import { validateAndSerializeYouTubeTokens } from '../auth/cookieParser';
import { getYoutubeAuthUrl, exchangeYoutubeCode, YoutubeApiError } from '../youtube/client';
import { z } from 'zod';

const router = Router();

const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube'];
const YOUTUBE_OAUTH_STATE_COOKIE = 'youtube_oauth_state';

// YouTube login
router.get('/login', (req, res) => {
  Logger.requestStart('YouTube Login Request', {
    requestUrl: req.originalUrl,
  });

  // Before the cookie exists, not after: minting it on a host the callback will not be sent to
  // guarantees a state mismatch.
  const canonical = canonicalLoginUrl(req, process.env.YOUTUBE_REDIRECT_URI);
  if (canonical) {
    Logger.auth('YouTube', 'moving the login to the callback host', { canonical });
    return res.redirect(canonical);
  }

  const state = issueOAuthState(res, YOUTUBE_OAUTH_STATE_COOKIE);
  const url = getYoutubeAuthUrl(YOUTUBE_SCOPES, state);
  Logger.auth('YouTube', 'redirecting to authorization', { authorizeURL: url });
  res.redirect(url);
});

// YouTube callback
router.get(
  '/callback',
  validate({
    query: z.object({
      code: schemas.oauthCode,
      state: z.string().optional(),
    }),
  }),
  async (req: ValidatedRequest<Record<string, string>, { code: string; state?: string }>, res) => {
    Logger.requestStart('YouTube Callback Request', {
      requestUrl: req.originalUrl,
      authCodePresent: !!req.query.code,
    });

    const { code, state } = req.query;

    // Reject a callback that didn't originate from our /login (CSRF / account fixation).
    if (!verifyOAuthState(req, res, YOUTUBE_OAUTH_STATE_COOKIE, state, 'YouTube')) {
      return res.redirect('/?error=youtube&reason=state_mismatch');
    }

    try {
      // Authenticating costs no quota, and nothing here spends any: this used to call
      // channels.list to cache a channel id, which meant a connect could only succeed while quota
      // remained. Exhaust the quota and the app cleared your tokens on the next page load and then
      // refused every attempt to reconnect, because the reconnect needed the quota that was gone.
      const tokens = await exchangeYoutubeCode(code as string);

      const serializedTokens = validateAndSerializeYouTubeTokens(tokens);
      res.cookie('youtube_tokens', serializedTokens, getSecureCookieOptions());

      Logger.auth('YouTube', 'tokens stored in cookie');

      // ?connected=youtube marks this as the moment YouTube was connected, which is something only
      // this callback knows: the status endpoint holds no session and cannot tell "connected" from
      // "just connected". The playlist list may be sitting in the browser cache from before this,
      // showing every playlist as unsynced, so the client refetches it once on this signal.
      res.redirect('/?connected=youtube');
    } catch (error) {
      Logger.error('Error getting YouTube tokens', {}, error);
      // Only the code exchange can fail here, and it talks to Google's token endpoint rather than
      // the Data API, so there is no quota answer to classify - a 403 from it is a consent or
      // permissions problem, never a spent budget. 400 and 401 mean the code or token is no good,
      // which the user can fix by connecting again; anything else is not theirs to fix.
      const errorReason =
        error instanceof YoutubeApiError && (error.code === 401 || error.code === 400)
          ? 'auth_error'
          : 'failed';
      res.redirect(`/?error=youtube&reason=${errorReason}`);
    }
  },
);

export { router as youtubeRouter };
