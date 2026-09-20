/**
 * Index page init:
 * - Shows the connection-error <dialog> for OAuth errors passed via query params.
 * - Opens YouTube video thumbnails in a new tab on click / keyboard activation.
 * The dialog closes via the shared [data-dialog-close] handler in videoModal.js.
 */
document.addEventListener('DOMContentLoaded', function () {
  const params = new URLSearchParams(window.location.search);
  const errorService = params.get('error');
  const errorReason = params.get('reason');

  if (errorService) {
    let errorMessage = 'Connection failed. Please try again.';
    const serviceDisplay = errorService.charAt(0).toUpperCase() + errorService.slice(1);

    if (errorReason === 'quota_exceeded') {
      errorMessage = `${serviceDisplay} API quota exceeded. Please wait and try again later.`;
    } else if (errorReason === 'rate_limited') {
      errorMessage = `Rate limited by ${serviceDisplay}. Please wait a moment and try again.`;
    } else if (errorReason === 'auth_error') {
      errorMessage = `${serviceDisplay} authentication failed. Please try reconnecting.`;
    } else if (errorReason === 'service_unavailable') {
      errorMessage = `${serviceDisplay} service is temporarily unavailable. Please try again soon.`;
    } else if (errorReason === 'state_mismatch') {
      // Names an attack, but is almost always a connect that took over ten minutes or a stale tab
      // reusing a one-time cookie. Say what to do, not what it could theoretically have been.
      errorMessage = `That ${serviceDisplay} connection attempt expired. Start it again.`;
    }

    document.getElementById('connectionErrorLabel').textContent =
      `${serviceDisplay} Connection Failed`;
    document.getElementById('connectionErrorMessage').textContent = errorMessage;
    document.getElementById('connectionErrorModal').showModal();

    // Clean up URL after showing the dialog
    window.history.replaceState({}, document.title, window.location.pathname);
  }
});

/**
 * Open a clickable thumbnail's video in a new tab.
 *
 * noopener,noreferrer is not optional: without it the opened YouTube tab receives a live
 * window.opener pointing at this app and can navigate it somewhere else (reverse tabnabbing).
 * The url comes from a data attribute on arbitrary rendered DOM.
 *
 * @returns true if a thumbnail was opened, so the caller can decide about preventDefault.
 */
function openThumbnailVideo(target) {
  const thumbnail = target.closest('.youtube-video__thumbnail--clickable');
  if (!thumbnail) return false;

  const url = thumbnail.dataset.videoUrl;
  if (!url) return false;

  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

document.addEventListener('click', function (e) {
  openThumbnailVideo(e.target);
});

// Thumbnails are role=button/tabindex=0, so they must activate from the keyboard too.
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (openThumbnailVideo(e.target)) {
    e.preventDefault(); // stop space from scrolling the page
  }
});

/**
 * Stop offering actions YouTube is currently refusing.
 *
 * The server disables these when it renders (see the playlist-button route and
 * partials/playlist-details.ejs), which covers a page loaded while writes are already blocked. This
 * covers the other case: a limit hit part-way through a session, where every sync and edit control
 * already on screen would otherwise keep inviting a click whose only outcome is the same error.
 *
 * Done here rather than by re-fetching each control: a library of sixty playlists would be sixty
 * requests to learn one fact the page has already been told. Disabling is UI state, which is the
 * client's job.
 */
document.body.addEventListener('youtube-blocked', function () {
  document.querySelectorAll('.sync-btn:not([disabled])').forEach(function (button) {
    button.disabled = true;
    button.title = 'YouTube is not accepting changes right now.';
  });

  // The edit/link stamps: anything that opens the video picker ends in a write.
  document
    .querySelectorAll('.track-stamps button[hx-get]:not([disabled])')
    .forEach(function (button) {
      button.disabled = true;
      button.title = 'YouTube is not accepting changes right now.';
    });
});

/**
 * Raise the same event for content that arrives through the SSE stream.
 *
 * A sync reports its own failure inside a stream whose headers went out before the sync started,
 * so the server cannot send the HX-Trigger it uses elsewhere. It marks the partial instead, and
 * this turns that marker into the event the handler above already listens for - one code path
 * disabling the controls whichever way the news arrives.
 */
document.body.addEventListener('htmx:afterSwap', function (e) {
  const swapped = e.target;
  if (!swapped || !swapped.querySelector) return;
  if (
    swapped.matches?.('[data-youtube-blocked]') ||
    swapped.querySelector('[data-youtube-blocked]')
  ) {
    document.body.dispatchEvent(new CustomEvent('youtube-blocked'));
  }
});
