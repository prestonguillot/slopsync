import { Router, Request } from 'express';
import { Logger } from '../lib/logger';
import { validate, schemas, ValidatedRequest } from '../lib/validation';
import { csrfValidationMiddleware } from '../auth/csrf';
import { SpotifyTokens, YouTubeTokens } from '../types/oauth';
import { parseSpotifyTokenCookie, parseYouTubeTokenCookie } from '../auth/cookieParser';
import { CacheDuration, setCache } from '../lib/cache';
import { formatErrorDetails } from '../lib/errorFormatter';
import { escapeHtml } from '../lib/htmlEscape';
import { ensureValidYouTubeToken } from '../youtube/auth';
import { ensureValidSpotifyToken } from '../spotify/auth';
import { authExpired, signalAuthExpired } from '../auth/authExpired';
import { classifyYoutubeError } from '../youtube/writes';
import { z } from 'zod';
import ejs from 'ejs';
import path from 'path';
import { fetchPlaylistDetails } from '../sync/playlistDetailsService';
import { searchCandidates } from '../sync/videoPicker';
import {
  applyVideoChoice,
  VideoNotInPlaylistError,
  VideoChoiceResult,
} from '../sync/applyVideoChoice';
import { getPlaylist } from '../spotify/client';
import { findSyncedYoutubePlaylist, syncedPlaylistTitle } from '../youtube/playlist';

const router = Router();

// Get detailed playlist information (Spotify tracks + YouTube videos)
router.get(
  '/playlist/:playlistId',
  validate({
    params: z.object({
      playlistId: schemas.spotifyPlaylistId,
    }),
  }),
  async (req: ValidatedRequest<{ playlistId: string }>, res) => {
    const startTime = Date.now();
    const { playlistId } = req.params;

    Logger.requestStart('Playlist Details Request', {
      playlistId,
    });

    try {
      // Check authentication - Spotify is required, YouTube is optional
      const spotifyTokens: SpotifyTokens | null = parseSpotifyTokenCookie(
        req.cookies.spotify_tokens,
        res,
      );
      const youtubeTokens: YouTubeTokens | null = parseYouTubeTokenCookie(
        req.cookies.youtube_tokens,
        res,
      );

      if (!spotifyTokens) {
        const html = await ejs.renderFile(
          path.join(__dirname, '../../views/partials/error-message.ejs'),
          {
            type: 'warning',
            title: 'Spotify Authentication Required',
            message: 'Please connect to Spotify first',
            details: 'Use the Spotify connection button at the top of the page to authenticate.',
          },
        );
        return res.status(401).send(html);
      }

      // Through ensureValidSpotifyToken: the cookie's access token lasts about an hour, and this
      // panel is opened on a page that may have been sitting idle far longer. On 401 it refreshes
      // and rewrites the cookie; when the refresh token is dead too it throws SPOTIFY_AUTH_REQUIRED,
      // which the catch block renders as the reconnect frame.
      const accessToken = await ensureValidSpotifyToken(req as Request, res);

      // Initialize YouTube API (optional - only if user is connected). Through
      // ensureValidYouTubeToken: the cookie's access token lasts about an hour, and this panel is
      // opened on a page that may have been sitting idle far longer.
      const youtube = youtubeTokens
        ? (await ensureValidYouTubeToken(req as Request, res)).client
        : null;

      // Resolve the YouTube playlist id. The client may send the id it has cached
      // (X-YT-Playlist-Id); trusting it skips listing all of the user's playlists
      // plus a Spotify name lookup. Without it, resolve by the synced-playlist title.
      let youtubePlaylistId: string | undefined = undefined;
      const cachedYoutubePlaylistId = (
        req.headers['x-yt-playlist-id'] as string | undefined
      )?.trim();
      if (youtube && youtubeTokens) {
        if (cachedYoutubePlaylistId) {
          youtubePlaylistId = cachedYoutubePlaylistId;
        } else {
          const spotifyPlaylist = await getPlaylist(accessToken, playlistId);
          youtubePlaylistId =
            (await findSyncedYoutubePlaylist(youtube, spotifyPlaylist.name))?.id || undefined;
        }
      }

      // Fetch details. A cached id can be stale (the playlist was deleted/recreated):
      // if the fetch fails because the playlist is gone, resolve fresh and retry once.
      let playlistDetails;
      try {
        playlistDetails = await fetchPlaylistDetails(
          accessToken,
          youtube,
          playlistId,
          youtubePlaylistId,
        );
      } catch (error) {
        const notFound = (error as { code?: number }).code === 404;
        if (youtube && youtubeTokens && cachedYoutubePlaylistId && notFound) {
          const spotifyPlaylist = await getPlaylist(accessToken, playlistId);
          youtubePlaylistId =
            (await findSyncedYoutubePlaylist(youtube, spotifyPlaylist.name))?.id || undefined;
          playlistDetails = await fetchPlaylistDetails(
            accessToken,
            youtube,
            playlistId,
            youtubePlaylistId,
          );
        } else {
          throw error;
        }
      }

      // Return the authoritative YouTube playlist id so the client can cache it
      // (empty string clears a now-invalid cached id).
      if (youtube && youtubeTokens) {
        res.set('X-YT-Playlist-Id', youtubePlaylistId || '');
      }

      Logger.info('Playlist details fetched', {
        playlistId,
        totalTracks: playlistDetails.totalTracks,
        linkedCount: playlistDetails.linkedCount,
      });

      // Generate HTML response using shared template
      const viewsPath = path.join(__dirname, '../../views');
      const playlistDetailsHtml = await ejs.renderFile(
        path.join(viewsPath, 'partials/playlist-details.ejs'),
        {
          playlistId: playlistDetails.playlistId,
          playlistName: playlistDetails.playlistName,
          tracks: playlistDetails.tracks,
          linkedCount: playlistDetails.linkedCount,
          totalTracks: playlistDetails.totalTracks,
          hasYoutubeConnection: !!youtubeTokens,
          hasYoutubePlaylist: playlistDetails.hasYoutubePlaylist,
          needsResync: playlistDetails.needsResync,
        },
      );

      const duration = Date.now() - startTime;
      Logger.requestEnd('Playlist Details Request', duration, { playlistId });

      // Always revalidate: the rendered details must reflect the current playlist
      // state on every load (a refresh sends Cache-Control: no-cache to bust it).
      setCache(res, CacheDuration.NO_CACHE);
      return res.send(playlistDetailsHtml);
    } catch (error) {
      const duration = Date.now() - startTime;
      Logger.error('Error fetching playlist details', { playlistId, duration }, error);

      // A session that has run out is not "try again" - trying again is exactly what does not work.
      const expired = authExpired(error);
      if (expired) {
        signalAuthExpired(res, expired);
        return res.status(401).render('partials/auth-expired', { ...expired });
      }

      // 'quota' (daily budget gone) and 'rate-limit' (transient throttle) both mean YouTube
      // refused on limits; anything else is a real error.
      const failure = classifyYoutubeError(error);
      if (failure !== 'other') {
        Logger.warn('YouTube refused the read on limits - returning error partial for HTMX', {
          failure,
        });
        // Return error partial for HTMX instead of redirecting
        const html = await ejs.renderFile(
          path.join(__dirname, '../../views/partials/error-message.ejs'),
          {
            type: 'warning',
            title: 'YouTube Quota Exceeded',
            message: 'Your YouTube API quota has been exceeded. YouTube limits API usage per day.',
            details:
              'The quota resets at midnight Pacific Time. You can continue using the app with existing playlists, but cannot load new playlist details until the quota resets.',
          },
        );
        return res.status(403).send(html);
      }

      const html = await ejs.renderFile(
        path.join(__dirname, '../../views/partials/error-message.ejs'),
        {
          type: 'danger',
          title: 'Error loading playlist details',
          message: 'Unable to fetch playlist information. Please try again.',
          details: formatErrorDetails(error),
        },
      );
      return res.status(500).send(html);
    }
  },
);

// Search for alternative YouTube videos for a track
router.get(
  '/search/:trackId',
  validate({
    params: z.object({
      trackId: schemas.alphanumericId,
    }),
    query: z.object({
      trackName: schemas.trackName,
      artistName: schemas.artistName,
      playlistId: schemas.spotifyPlaylistId,
      currentVideoId: schemas.youtubeVideoId.optional().or(z.literal('')),
      searchQuery: schemas.searchQuery.optional(),
    }),
  }),
  async (
    req: ValidatedRequest<
      { trackId: string },
      {
        trackName: string;
        artistName: string;
        playlistId: string;
        currentVideoId?: string;
        searchQuery?: string;
      }
    >,
    res,
  ) => {
    const { trackId } = req.params;
    const { trackName, artistName, playlistId, currentVideoId, searchQuery } = req.query;

    Logger.requestStart('Track Video Search Request', {
      trackId,
      trackName,
      artistName,
      playlistId,
      currentVideoId,
    });

    try {
      const { query, videos: videosWithScores } = await searchCandidates(
        { id: trackId, name: trackName, artist: artistName },
        searchQuery,
      );

      // A manual re-search targets only the results list (HX-Target header), so we send
      // back just that fragment and leave the modal shell (header, search bar, footer)
      // in place. The initial open targets the whole modal and gets the full shell.
      const resultsOnly = req.get('HX-Target') === 'video-results-list';

      if (resultsOnly) {
        const resultsHtml = await ejs.renderFile(
          path.join(__dirname, '../../views/partials/video-results.ejs'),
          { videos: videosWithScores, searchQuery: query },
        );
        res.send(resultsHtml);
        return;
      }

      // Determine if this is for a new link or replacing an existing one
      const isReplacing = currentVideoId && currentVideoId !== '';
      const modalTitle = isReplacing ? 'Select Alternative Video' : 'Select Video';
      // Escape track and artist names to prevent XSS in HTML string construction
      const escapedTrackName = escapeHtml(trackName);
      const escapedArtistName = escapeHtml(artistName);
      const instructionText = isReplacing
        ? `Choose a different YouTube video for: <strong>${escapedTrackName}</strong> by <strong>${escapedArtistName}</strong>`
        : `Choose a YouTube video for: <strong>${escapedTrackName}</strong> by <strong>${escapedArtistName}</strong>`;

      // Render video selection modal from template
      const videoSelectionHtml = await ejs.renderFile(
        path.join(__dirname, '../../views/partials/video-selection-modal.ejs'),
        {
          trackId,
          modalTitle,
          instructionText,
          videos: videosWithScores,
          currentVideoId: currentVideoId || '',
          playlistId,
          trackName,
          artistName,
          searchQuery: query,
        },
      );

      res.send(videoSelectionHtml);
    } catch (error) {
      Logger.error(
        'Error searching for alternative videos',
        { trackId, trackName, artistName },
        error,
      );

      const html = await ejs.renderFile(
        path.join(__dirname, '../../views/partials/error-message.ejs'),
        {
          type: 'danger',
          title: 'Error searching for videos',
          message: 'Unable to search for alternative videos. Please try again.',
          details: formatErrorDetails(error),
        },
      );
      res.status(500).send(html);
    }
  },
);

// Replace a video in a YouTube playlist
router.post(
  '/replace/:trackId',
  csrfValidationMiddleware, // CSRF protection - re-enabled with improved logging
  validate({
    params: z.object({
      trackId: schemas.alphanumericId,
    }),
    body: z.object({
      newVideoId: schemas.youtubeVideoId,
      currentVideoId: schemas.youtubeVideoId.optional().or(z.literal('')),
      playlistId: schemas.spotifyPlaylistId,
    }),
  }),
  async (
    req: ValidatedRequest<
      { trackId: string },
      Record<string, unknown>,
      { newVideoId: string; currentVideoId?: string; playlistId: string }
    >,
    res,
  ) => {
    const { trackId } = req.params;
    const { newVideoId, currentVideoId, playlistId } = req.body;

    Logger.requestStart('Video Replacement Request', {
      trackId,
      currentVideoId,
      newVideoId,
      playlistId,
    });

    try {
      // Check authentication
      const youtubeTokens: YouTubeTokens | null = parseYouTubeTokenCookie(
        req.cookies.youtube_tokens,
        res,
      );
      const spotifyTokens: SpotifyTokens | null = parseSpotifyTokenCookie(
        req.cookies.spotify_tokens,
        res,
      );

      if (!youtubeTokens) {
        const html = await ejs.renderFile(
          path.join(__dirname, '../../views/partials/error-message.ejs'),
          {
            type: 'warning',
            title: 'YouTube Authentication Required',
            message: 'Please connect to YouTube first',
            details: 'Use the YouTube connection button at the top of the page to authenticate.',
          },
        );
        return res.status(401).send(html);
      }

      if (!spotifyTokens) {
        const html = await ejs.renderFile(
          path.join(__dirname, '../../views/partials/error-message.ejs'),
          {
            type: 'warning',
            title: 'Spotify Authentication Required',
            message: 'Please connect to Spotify first',
            details: 'Use the Spotify connection button at the top of the page to authenticate.',
          },
        );
        return res.status(401).send(html);
      }

      // Initialize YouTube API. Through ensureValidYouTubeToken: this is a WRITE, reached from a
      // modal on a page that may have been open for hours, and an hour-old token fails it for a
      // reason the user cannot act on ("Video replacement failed. Please try again").
      const youtube = (await ensureValidYouTubeToken(req as Request, res)).client;

      // Through ensureValidSpotifyToken for the same reason: this WRITE reads the Spotify playlist,
      // and an hour-old access token 401s here for a reason the user cannot act on. On 401 it
      // refreshes; a dead refresh token throws SPOTIFY_AUTH_REQUIRED and the catch renders reconnect.
      const spotifyAccessToken = await ensureValidSpotifyToken(req as Request, res);

      // Find the YouTube playlist mirroring this Spotify one, by the synced-title convention.
      const spotifyPlaylistData = await getPlaylist(spotifyAccessToken, playlistId);
      const expectedYouTubePlaylistName = syncedPlaylistTitle(spotifyPlaylistData.name);

      Logger.external('YouTube', 'Looking for playlist', { name: expectedYouTubePlaylistName });

      const targetPlaylist = await findSyncedYoutubePlaylist(youtube, spotifyPlaylistData.name);

      if (!targetPlaylist) {
        Logger.error('YouTube playlist not found', { name: expectedYouTubePlaylistName });
        const html = await ejs.renderFile(
          path.join(__dirname, '../../views/partials/error-message.ejs'),
          {
            type: 'danger',
            title: 'Playlist not found',
            message: `Could not find YouTube playlist: "${expectedYouTubePlaylistName}"`,
            details:
              'This playlist may not have been synced yet. Try syncing it from the Spotify playlists page first.',
          },
        );
        return res.status(404).send(html);
      }

      Logger.external('YouTube', 'Found target playlist', {
        title: targetPlaylist.snippet?.title,
        id: targetPlaylist.id,
      });

      let choice: VideoChoiceResult;
      try {
        choice = await applyVideoChoice({
          youtube,
          youtubePlaylistId: targetPlaylist.id!,
          spotifyAccessToken,
          spotifyPlaylistId: playlistId,
          trackId,
          newVideoId,
          currentVideoId,
        });
      } catch (error) {
        if (!(error instanceof VideoNotInPlaylistError)) throw error;

        const html = await ejs.renderFile(
          path.join(__dirname, '../../views/partials/error-message.ejs'),
          {
            type: 'danger',
            title: 'Video not found',
            message: `Could not find the video in the YouTube playlist after checking all ${error.itemsScanned} items.`,
            details:
              'The video may have been removed from the playlist, or the playlist data may be out of sync. Try refreshing the playlist details and trying again.',
          },
        );
        return res.status(404).send(html);
      }

      Logger.info('Video operation completed successfully', { operation: choice.mode });

      // A write that landed but could not be placed is not an error - the video is linked and in the
      // playlist. But it is not what was asked for either, and reporting it as success is how a
      // playlist ends up in an order nobody chose with nothing on screen having said so.
      const successMessage = !choice.placed
        ? 'Video linked, but it could not be moved into position - sync the playlist to fix the order.'
        : choice.mode === 'add'
          ? 'Video linked successfully!'
          : 'Video replaced successfully!';

      const html = await ejs.renderFile(
        path.join(__dirname, '../../views/partials/video-replace-success.ejs'),
        {
          message: successMessage,
        },
      );

      return res.send(html);
    } catch (error) {
      Logger.error('Error replacing video', { trackId, currentVideoId, newVideoId }, error);

      // "Please try again" is wrong advice for a session that has run out: the retry fails the same
      // way, and the one thing that would fix it is never offered.
      const expired = authExpired(error);
      if (expired) {
        signalAuthExpired(res, expired);
        return res.status(401).render('partials/auth-expired', { ...expired });
      }

      const html = await ejs.renderFile(
        path.join(__dirname, '../../views/partials/error-message.ejs'),
        {
          type: 'danger',
          title: 'Video replacement failed',
          message: 'Unable to update the playlist. Please try again.',
          details: formatErrorDetails(error),
        },
      );
      return res.status(500).send(html);
    }
  },
);

export { router as playlistDetailsRouter };
