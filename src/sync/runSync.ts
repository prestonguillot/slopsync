import { YtPlaylist, YtPlaylistItem } from '../youtube/client';
import { sleep } from '../lib/delay';
import { ensureValidYouTubeToken } from '../youtube/auth';
import { fetchAllPlaylistItems } from '../spotify/playlistItems';
import { fetchAllYoutubePlaylistItems, findSyncedYoutubePlaylist } from '../youtube/playlist';
import { syncedPlaylistTitle } from '../youtube/playlist';
import { youtubeWrite } from '../youtube/writes';
import { reconcilePlaylist, buildSyncDesiredVideoIds } from './playlistReconcile';
import { Logger } from '../lib/logger';
import { renderPartial } from '../lib/renderPartial';
import { fetchPlaylistDetails } from './playlistDetailsService';
import { searchTracksForVideos, TrackSearchResult } from './videoSearch';
import { classifyTracksForSync } from './trackClassification';
import { getPlaylist } from '../spotify/client';
import { ProgressUpdate } from '../types/progress';
import { syncLeases, withLease, type Lease, type LeaseStore } from '../lib/leases';

type YoutubeClient = Awaited<ReturnType<typeof ensureValidYouTubeToken>>['client'];

export interface SyncDeps {
  playlistId: string;
  batchSizeRaw: string | undefined;
  spotifyAccessToken: string;
  youtube: YoutubeClient;
  initialQuotaUsed: number;
  emit: (html: string) => void;
  emitProgress: (update: ProgressUpdate) => Promise<void>;
  /** Aborted when the client disconnects mid-sync. */
  signal?: AbortSignal;
  /** Injectable so a test can watch two syncs contend; defaults to the process-wide store. */
  leases?: LeaseStore;
}

// Total progress phases: search (70%) + playlist operations (30%)
const SEARCH_PHASE_WEIGHT = 0.7;
const PLAYLIST_PHASE_WEIGHT = 0.3;

/**
 * How long a sync holds its playlist between progress reports.
 *
 * Sized off the longest gap the sync can legitimately go without reporting, which is one track's
 * search ladder: five queries, each a 10s fetch timeout plus a 1s sleep, so about 55s. Everything
 * else is far smaller - write retries total 3.5s of backoff, the deliberate sleeps are 1-3s. Two
 * minutes clears that with room, and still frees a dead worker's playlist in minutes rather than
 * holding it for the length of a sync nobody is running.
 */
const SYNC_LEASE_TTL_MS = 120_000;

/** The create section is one list plus one insert, so it neither needs nor deserves longer. */
const CREATE_LEASE_TTL_MS = 30_000;

/** A loser waits for the winner's create rather than failing: it needs to see what was created. */
const CREATE_LEASE_WAIT_MS = 30_000;

/** Held for the whole sync. The id is globally unique, so this needs no per-user scoping. */
const syncLeaseKey = (youtubePlaylistId: string) => `sync:playlist:${youtubePlaylistId}`;

/**
 * Held across the check-and-create only.
 *
 * Keyed on the title because that is the one name a playlist has before it exists - there is no id
 * to key on yet, and the first sync is exactly when two runs would otherwise create two copies.
 * Titles are unique per account rather than globally, so two people creating the same title
 * serialize briefly. That is over-broad, not wrong: each still looks up in their own account.
 */
const createLeaseKey = (title: string) => `sync:create:${title}`;

/** Carries the lease back to `runSync`'s finally through the body's many early returns. */
interface LeaseSlot {
  current: Lease | null;
}

/** The video ids the playlist should hold, in the Spotify playlist's track order. */
function desiredOrder(
  tracks: unknown[],
  matchPairs: Parameters<typeof buildSyncDesiredVideoIds>[1],
  searchResults: TrackSearchResult[],
): string[] {
  const orderedTrackIds = tracks
    .map((item) => (item as { track?: { id?: string } }).track?.id)
    .filter((id): id is string => !!id);
  return buildSyncDesiredVideoIds(orderedTrackIds, matchPairs, searchResults);
}

/** What the playlist holds now, as reconcile wants it: an item without both ids cannot be moved. */
function currentItemsOf(existingItemsMap: Map<string, YtPlaylistItem>) {
  return Array.from(existingItemsMap.values())
    .filter((item) => item.snippet?.resourceId?.videoId && item.id)
    .map((item) => ({ videoId: item.snippet!.resourceId!.videoId!, playlistItemId: item.id! }));
}

/** Percentage through the playlist phase, which starts where the search phase ends. */
const playlistPhasePercentage = (done: number, total: number) =>
  Math.round((SEARCH_PHASE_WEIGHT + (done / Math.max(total, 1)) * PLAYLIST_PHASE_WEIGHT) * 100);

/**
 * Runs the whole sync, streaming progress + the final result via the provided callbacks. Throws on
 * real failures (the caller renders the error frame); the "nothing to sync" cases emit an error
 * partial and return.
 *
 * The callbacks are the seam: this knows what to say and the caller knows how to send it, so the
 * sync can be run without an SSE stream to attach to.
 */
export async function runSync(deps: SyncDeps): Promise<void> {
  const lease: LeaseSlot = { current: null };
  try {
    await performSync(deps, lease);
  } finally {
    // The single release point: this runs on success, on a throw, and on the client disconnect
    // that aborts mid-sync, so no path can strand a playlist until its TTL runs out.
    await lease.current?.release();
  }
}

async function performSync(deps: SyncDeps, lease: LeaseSlot): Promise<void> {
  const {
    playlistId,
    batchSizeRaw,
    spotifyAccessToken,
    youtube,
    initialQuotaUsed,
    emit,
    signal,
    leases = syncLeases,
  } = deps;

  /**
   * Reporting progress is what renews the lease, so it lasts exactly as long as the sync is doing
   * something. A timer would renew for as long as the process was alive, which a hung sync also is.
   *
   * A lost lease is reported, not thrown: by the time it is noticed a write may already be in
   * flight, and abandoning a reconcile part-way leaves a worse playlist than finishing it.
   */
  const emitProgress = async (update: ProgressUpdate): Promise<void> => {
    await deps.emitProgress(update);
    const held = lease.current;
    if (held && !(await held.touch())) {
      Logger.warn('Sync lease lost - another sync may now hold this playlist', { key: held.key });
    }
  };

  const startTime = Date.now();

  let apiCallCount = 0;
  let totalQuotaUsed = initialQuotaUsed;
  // Always assigned below before it is read: the lookup either sets it or throws.
  let existingPlaylist: YtPlaylist | null;

  await emitProgress({
    type: 'progress',
    message: 'Starting sync...',
    details: 'Fetching Spotify playlist details...',
  });

  // Get playlist details
  Logger.external('Spotify', 'Fetching playlist details');
  const playlist = await getPlaylist(spotifyAccessToken, playlistId);
  Logger.external('Spotify', 'Playlist details fetched', {
    name: playlist.name,
    totalTracks: playlist.trackTotal ?? 0,
  });

  // Get batch size, default to 1 if not provided
  let batchSize = 1;
  if (batchSizeRaw) {
    if (batchSizeRaw === 'all') {
      batchSize = playlist.trackTotal || 999;
    } else {
      batchSize = parseInt(batchSizeRaw);
    }
  }
  const trackLimit = batchSize;
  Logger.info('Using user-selected batch size', { batchSize, trackLimit });

  await emitProgress({
    type: 'progress',
    message: `Found playlist: "${playlist.name}"`,
    details: `Fetching tracks (limit: ${trackLimit})...`,
  });
  Logger.external('Spotify', 'Fetching all tracks for analysis');

  // Fetch all tracks via the /items endpoint (/tracks was removed in Feb 2026).
  const allItems = await fetchAllPlaylistItems(spotifyAccessToken, playlistId);
  const tracks: unknown[] = allItems.filter((item: unknown) => {
    const typedItem = item as { track: { type?: string } | null };
    return typedItem.track && typedItem.track.type === 'track';
  });
  Logger.info('Found valid tracks to analyze', {
    count: tracks.length,
    totalPlaylistTracks: playlist.trackTotal ?? 0,
  });

  await emitProgress({
    type: 'progress',
    message: `Processing ${tracks.length} tracks`,
    details: 'Searching for existing YouTube playlist...',
  });

  if (tracks.length === 0) {
    Logger.warn('No tracks to sync');
    emit(
      await renderPartial('sync-error.ejs', {
        playlistId,
        title: 'No Tracks Found',
        message: 'This playlist appears to be empty or contains only unplayable tracks.',
      }),
    );
    return;
  }

  const logApiCall = (operation: string, quotaCost: number) => {
    apiCallCount++;
    totalQuotaUsed += quotaCost;
    Logger.external('YouTube', `API call: ${operation}`, {
      callNumber: apiCallCount,
      quotaCost,
      totalQuotaUsed,
    });
  };

  // STEP 1: Check if a YouTube playlist already exists FIRST
  const playlistTitle = syncedPlaylistTitle(playlist.name);
  Logger.external('YouTube', 'Checking for existing playlist before video search', {
    title: playlistTitle,
  });

  let youtubePlaylistId = '';
  const existingVideoIds: Set<string> = new Set();
  const existingItemsMap: Map<string, YtPlaylistItem> = new Map();
  let isUpdateMode = false;

  try {
    existingPlaylist = await findSyncedYoutubePlaylist(youtube, playlist.name);
    logApiCall('playlist search', 1);

    if (existingPlaylist) {
      youtubePlaylistId = existingPlaylist.id!;
      isUpdateMode = true;

      // Taken before the playlist is read, not merely before it is written: the plan and the
      // writes derived from it have to see one consistent playlist, and the read is where that
      // starts. Refusing here also spares the loser the whole search phase.
      lease.current = await leases.acquire(syncLeaseKey(youtubePlaylistId), SYNC_LEASE_TTL_MS);
      if (!lease.current) {
        Logger.warn('Refused a sync for a playlist that is already syncing', {
          title: playlistTitle,
          id: youtubePlaylistId,
        });
        emit(
          await renderPartial('sync-error.ejs', {
            playlistId,
            title: 'This playlist is already syncing',
            message: 'Another sync is running for this playlist right now.',
            details: 'Wait for it to finish, then start this one again.',
          }),
        );
        return;
      }

      Logger.external('YouTube', 'Found existing playlist - entering UPDATE mode', {
        title: playlistTitle,
        id: youtubePlaylistId,
      });

      const existingItems = await fetchAllYoutubePlaylistItems(
        youtube,
        youtubePlaylistId,
        ['id', 'snippet'],
        () => logApiCall('get existing items', 1),
      );

      for (const item of existingItems) {
        if (item.snippet?.resourceId?.videoId) {
          const videoId = item.snippet.resourceId.videoId;
          existingVideoIds.add(videoId);
          existingItemsMap.set(videoId, item);
        }
      }

      Logger.info('Found existing videos in playlist', { count: existingItems.length });
    } else {
      Logger.info('No existing playlist found - entering CREATE mode');
    }
  } catch (error) {
    // Never continue on a partial view of the playlist - the outer handler renders an error frame.
    //
    // If the search failed, whether a synced playlist already exists is unknown, and falling
    // through to CREATE would build a second copy of it. If the item pagination failed part-way,
    // isUpdateMode/youtubePlaylistId are already set but existingItemsMap holds only the pages that
    // arrived: the UPDATE reconcile would then treat the videos it never saw as missing and
    // re-insert them, duplicating them and scrambling the order. A transient read must not be able
    // to corrupt the user's playlist.
    Logger.error(
      'Error resolving the existing YouTube playlist - aborting before any write',
      { isUpdateMode, youtubePlaylistId, existingItemsSeen: existingItemsMap.size },
      error,
    );
    throw error;
  }

  // STEP 2: Classify tracks - update mode matches existing videos to find which
  // tracks still need one; create mode takes from the top. Both capped at trackLimit.
  if (isUpdateMode) {
    await emitProgress({
      type: 'progress',
      message: 'Analyzing playlist for updates',
      details: `Found ${existingVideoIds.size} existing videos, matching tracks to identify unsynced ones...`,
      percentage: 5,
    });
  }
  const { tracksToSearch, unsyncedTracks, existingMatchPairs } = classifyTracksForSync(
    tracks,
    existingItemsMap,
    { isUpdateMode, trackLimit },
  );

  // STEP 3: Search YouTube (quota-free scraper) for a video per track, in order
  const { videoIds, searchResults } = await searchTracksForVideos(tracksToSearch, {
    isUpdateMode,
    existingVideoCount: existingVideoIds.size,
    totalTrackCount: tracks.length,
    searchPhaseWeight: SEARCH_PHASE_WEIGHT,
    emitProgress: (payload) => emitProgress(payload),
    signal,
  });

  // If the client disconnected during the search, stop before any YouTube write -
  // never modify the user's playlist for a sync they've navigated away from.
  if (signal?.aborted) return;

  await emitProgress({
    type: 'progress',
    message: `Found ${videoIds.length} music videos`,
    details: 'Checking for existing YouTube playlist...',
    percentage: Math.round(SEARCH_PHASE_WEIGHT * 100),
  });

  // STEP 4: Create or update YouTube playlist
  await emitProgress({
    type: 'progress',
    message: isUpdateMode
      ? `Updating existing playlist: "${playlistTitle}"`
      : 'Creating new YouTube playlist',
    details: isUpdateMode ? 'Processing playlist updates...' : 'Setting up new playlist...',
    percentage: Math.round(SEARCH_PHASE_WEIGHT * 100),
  });

  /** The result frame: feedback + the refreshed details panel + the button, as one response. */
  const emitResult = async (
    feedback: Record<string, unknown>,
    response: Record<string, unknown>,
  ) => {
    const syncFeedbackHtml = await renderPartial('sync-feedback.ejs', {
      playlistId,
      ...feedback,
    });
    const playlistDetails = await fetchPlaylistDetails(
      spotifyAccessToken,
      youtube,
      playlistId,
      youtubePlaylistId,
    );
    const playlistDetailsHtml = await renderPartial('playlist-details.ejs', {
      playlistId: playlistDetails.playlistId,
      playlistName: playlistDetails.playlistName,
      tracks: playlistDetails.tracks,
      linkedCount: playlistDetails.linkedCount,
      totalTracks: playlistDetails.totalTracks,
      hasYoutubeConnection: true,
      hasYoutubePlaylist: playlistDetails.hasYoutubePlaylist,
      needsResync: playlistDetails.needsResync,
    });
    emit(
      await renderPartial('sync-response.ejs', {
        playlistId,
        syncFeedbackHtml,
        playlistDetailsHtml,
        buttonText: 'Update YouTube Playlist',
        buttonClass: 'btn-outline-success',
        playlistName: playlist.name,
        spotifyUrl: playlist.spotifyUrl,
        youtubeUrl: `https://www.youtube.com/playlist?list=${youtubePlaylistId}`,
        ...response,
      }),
    );
  };

  // Update with no unsynced tracks: still reconcile (order may have changed), then done.
  if (isUpdateMode && unsyncedTracks.length === 0 && videoIds.length === 0) {
    Logger.info('Playlist already fully synced, no new videos to add', { playlistId });

    await reconcilePlaylist(
      youtube,
      youtubePlaylistId,
      desiredOrder(tracks, existingMatchPairs, searchResults),
      currentItemsOf(existingItemsMap),
    );

    await emitResult(
      {
        isUpdate: true,
        isFullySynced: true,
        videosFound: 0,
        totalSearched: 0,
        isLimited: false,
        unlinkedTracks: [],
      },
      { isUpdate: true, trackCount: playlist.trackTotal ?? 0 },
    );
    return;
  }

  // Only error on "no videos" for a NEW playlist. An update with nothing new is
  // valid (it may still reorder existing videos), so it falls through to reconcile.
  if (!isUpdateMode && videoIds.length === 0) {
    Logger.warn('No videos found for new sync');
    emit(
      await renderPartial('sync-error.ejs', {
        playlistId,
        title: 'No videos found',
        message: 'Could not find any YouTube videos for the tracks in this playlist.',
      }),
    );
    return;
  }

  // Create playlist if it doesn't exist
  if (!existingPlaylist) {
    /**
     * The check and the create are one guarded step, and the check is made again inside it. The
     * `existingPlaylist` answer above was taken before the search phase - minutes and a whole
     * scrape ago - so a sync that started alongside this one may have created this very playlist
     * since. Guarding only the insert would protect nothing: both runs would arrive still carrying
     * their own stale "it does not exist", take the lease in turn, and create one copy each.
     *
     * Null means somebody else got there first.
     */
    const createdId = await withLease(
      leases,
      createLeaseKey(playlistTitle),
      { ttlMs: CREATE_LEASE_TTL_MS, waitMs: CREATE_LEASE_WAIT_MS },
      async () => {
        const raced = await findSyncedYoutubePlaylist(youtube, playlist.name);
        logApiCall('playlist search', 1);
        if (raced) return null;

        const playlistResponse = await youtubeWrite('playlists.insert', () =>
          youtube.playlists.insert({
            part: ['snippet', 'status'],
            requestBody: {
              snippet: {
                title: playlistTitle,
                description: `Synced from Spotify playlist: ${playlist.name}`,
              },
              status: { privacyStatus: 'private' },
            },
          }),
        );
        logApiCall('playlist creation', 50);
        return playlistResponse.data.id!;
      },
    );

    if (createdId === null) {
      // This sync's plan was computed against a playlist that did not exist, so its "current
      // items" are empty and reconciling would insert every video into a playlist that already
      // holds them. Re-run and it takes the update path instead.
      Logger.warn('Another sync created this playlist first - stopping before any write', {
        title: playlistTitle,
      });
      emit(
        await renderPartial('sync-error.ejs', {
          playlistId,
          title: 'Another sync got here first',
          message: 'Another sync created this YouTube playlist while this one was searching.',
          details: 'Start this sync again and it will update that playlist instead.',
        }),
      );
      return;
    }

    youtubePlaylistId = createdId;
    // No refusal to handle: the id was minted a moment ago, so nothing else can be holding it.
    lease.current = await leases.acquire(syncLeaseKey(youtubePlaylistId), SYNC_LEASE_TTL_MS);
    Logger.external('YouTube', 'Created new playlist', {
      title: playlistTitle,
      id: youtubePlaylistId,
    });
    await emitProgress({
      type: 'progress',
      message: `Created playlist: "${playlistTitle}"`,
      details: 'Adding videos to new playlist...',
      percentage: Math.round(SEARCH_PHASE_WEIGHT * 100),
    });

    // A brand-new playlist isn't immediately writable - wait before the first insert.
    await sleep(2000);

    const reconcileResult = await reconcilePlaylist(
      youtube,
      youtubePlaylistId,
      desiredOrder(tracks, [], searchResults),
      [],
      (done, total) =>
        emitProgress({
          type: 'progress',
          message: 'Adding videos to playlist',
          details: `Adding videos (${done}/${total})`,
          percentage: playlistPhasePercentage(done, total),
        }),
    );
    logApiCall('reconcile new playlist', reconcileResult.inserted * 50);
    Logger.info('CREATE mode reconcile complete', { ...reconcileResult });
  } else {
    // UPDATE MODE: reconcile existing matches + this batch's new searches into order.
    Logger.info('UPDATE MODE: Adding videos for next unsynced tracks', {
      videosFoundForNextTracks: videoIds.length,
    });
    await emitProgress({
      type: 'progress',
      message: 'Adding new tracks to playlist',
      details: `Adding ${videoIds.length} new videos from next unsynced tracks...`,
      percentage: Math.round(SEARCH_PHASE_WEIGHT * 100),
    });

    const reconcileResult = await reconcilePlaylist(
      youtube,
      youtubePlaylistId,
      desiredOrder(tracks, existingMatchPairs, searchResults),
      currentItemsOf(existingItemsMap),
      (done, total) =>
        emitProgress({
          type: 'progress',
          message: 'Updating playlist',
          details: `Updating playlist (${done}/${total})`,
          percentage: playlistPhasePercentage(done, total),
        }),
    );
    logApiCall(
      'reconcile update',
      (reconcileResult.inserted + reconcileResult.moved + reconcileResult.deleted) * 50,
    );
    Logger.info('UPDATE mode reconcile complete', { ...reconcileResult });
  }

  Logger.requestEnd('Sync Request Completed', Date.now() - startTime);

  const videosFound = searchResults.filter((r) => r.found).length;
  await emitProgress({
    type: 'complete',
    message: `Playlist ${existingPlaylist ? 'updated' : 'created'} successfully!`,
    details: `Found ${videosFound} out of ${searchResults.length} tracks${tracks.length > trackLimit ? ` (limited from ${tracks.length} total)` : ''}`,
    percentage: 100,
  });

  Logger.info('YouTube API Quota Usage Summary', {
    totalApiCalls: apiCallCount,
    totalQuotaUsed,
    operationType: existingPlaylist ? 'UPDATE' : 'SYNC',
    playlistName: playlist.name,
    playlistId,
    tracksProcessed: searchResults.length,
    videosFound,
    quotaSaved: searchResults.length * 100,
  });

  await emitResult(
    {
      isUpdate: !!existingPlaylist,
      videosFound,
      totalSearched: searchResults.length,
      isLimited: tracks.length > trackLimit,
      totalTracks: tracks.length,
      unlinkedTracks: searchResults
        .filter((r) => !r.found)
        .map((r) => ({ track: r.track, artist: r.artist })),
    },
    { trackCount: tracks.length },
  );
}
