// Where YouTube shows video thumbnails, and which video each one shows.
// Shared by the marks on saved videos (badges.js) and the save button that
// appears on hover (quicksave.js).
(function (root) {
  const ns = root.__wlTools;
  const { core } = ns;

  // YouTube's own element names, kept here so a redesign is a one-place fix.
  // Each is a thumbnail, and its video comes from the link inside it or
  // around it.
  const YOUTUBE_THUMBNAILS = Object.freeze([
    // Most of YouTube: home, subscriptions, channels, search, recommendations
    // and playlists.
    'yt-thumbnail-view-model',
    // Older layouts, such as some search results and the playlist panel.
    'ytd-thumbnail',
    // Shorts.
    'ytm-shorts-lockup-view-model',
    // Inside the player: the wall of suggestions at the end of a video, the
    // creator's end-screen cards, and the autoplay countdown.
    'a.ytp-videowall-still',
    '.ytp-ce-video',
    '.ytp-autonav-endscreen-upnext-thumbnail'
  ]);
  const SELECTOR = YOUTUBE_THUMBNAILS.join(', ');
  // Thumbnails that stand for a playlist or a mix rather than one video.
  const COLLECTIONS = 'yt-collection-thumbnail-view-model, ytd-playlist-thumbnail';
  // The preview YouTube plays over a thumbnail while the pointer rests on it.
  const PREVIEW = 'ytd-video-preview';
  // YouTube's own Watch later button, which some thumbnails show on hover.
  const OWN_SAVE_BUTTON = 'yt-thumbnail-hover-overlay-toggle-actions-view-model, ytd-thumbnail-overlay-toggle-button-renderer';

  // thumbnail -> { href, skipList, videoId }
  const known = new WeakMap();

  function all() {
    return document.querySelectorAll(SELECTOR);
  }

  function linkOf(thumbnail) {
    return thumbnail.querySelector('a[href]') ?? thumbnail.closest('a[href]');
  }

  // The video a thumbnail shows, or null for a playlist, a mix, a link into
  // `skipList`, or anything else. Worked out again whenever its link changes,
  // because YouTube reuses thumbnails for other videos.
  function videoOf(thumbnail, skipList = null) {
    const href = linkOf(thumbnail)?.getAttribute('href') ?? '';
    const cached = known.get(thumbnail);
    if (cached?.href === href && cached.skipList === skipList) return cached.videoId;
    const collection = thumbnail.matches(COLLECTIONS) || thumbnail.closest(COLLECTIONS) !== null;
    const videoId = collection ? null : core.videoIdFromHref(href, skipList);
    known.set(thumbnail, { href, skipList, videoId });
    return videoId;
  }

  function sameBox(a, b) {
    const one = a.getBoundingClientRect();
    const two = b.getBoundingClientRect();
    return Math.abs(one.left - two.left) < 3 && Math.abs(one.top - two.top) < 3
      && Math.abs(one.width - two.width) < 3 && Math.abs(one.height - two.height) < 3;
  }

  // The thumbnail at a point on the screen, and the surface showing it: the
  // thumbnail itself, or the preview YouTube is playing over it.
  function at(x, y) {
    let preview = null;
    for (const node of document.elementsFromPoint(x, y)) {
      if (preview === null && node.matches(PREVIEW)) preview = node;
      const thumbnail = node.closest(SELECTOR);
      if (thumbnail) return { thumbnail, surface: preview && sameBox(preview, thumbnail) ? preview : thumbnail };
    }
    return null;
  }

  function hasOwnSaveButton(thumbnail) {
    return thumbnail.querySelector(OWN_SAVE_BUTTON) !== null;
  }

  ns.thumbnails = { all, videoOf, at, hasOwnSaveButton };
})(globalThis);
