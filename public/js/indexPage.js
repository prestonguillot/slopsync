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
