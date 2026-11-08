// Marks the thumbnail of every video in your Watch later, wherever YouTube
// shows one: home, subscriptions, search, channels, the recommendations beside
// a video, other playlists, Shorts, and the suggestions in the player at the
// end of a video. Watch later's own rows are left alone.
//
// This file only decides which thumbnails get a mark. Where thumbnails are
// comes from thumbnails.js, what the mark looks like from indicator.js, and
// which videos are saved from watchlater.js; main.js hands them in.
(function (root) {
  const ns = root.__wlTools;
  const SCAN_EVERY_MS = 500;

  // { saved, thumbnails, createMark, skipList }, from mount().
  let source = null;
  // thumbnail -> its mark, made once and reused.
  const marks = new WeakMap();
  // Thumbnails carrying a mark right now.
  const marked = new Set();

  function update(thumbnail) {
    const videoId = source.thumbnails.videoOf(thumbnail, source.skipList);
    if (videoId !== null && source.saved.has(videoId)) {
      let mark = marks.get(thumbnail);
      if (!mark) {
        mark = source.createMark();
        marks.set(thumbnail, mark);
      }
      if (mark.parentNode !== thumbnail) thumbnail.append(mark);
      marked.add(thumbnail);
    } else if (marked.delete(thumbnail)) {
      marks.get(thumbnail)?.remove();
    }
  }

  function clear() {
    for (const thumbnail of marked) marks.get(thumbnail)?.remove();
    marked.clear();
  }

  function scan() {
    if (document.hidden) return;
    for (const thumbnail of marked) {
      if (!thumbnail.isConnected) marked.delete(thumbnail);
    }
    if (source.saved.size() === 0) {
      clear();
      return;
    }
    for (const thumbnail of source.thumbnails.all()) update(thumbnail);
  }

  // `saved` answers has(videoId), size() and subscribe(listener); `thumbnails`
  // finds thumbnails and their videos; `createMark` makes a new mark;
  // `skipList` is the playlist whose own rows go unmarked.
  function mount(next) {
    if (source) return;
    source = next;
    source.saved.subscribe(scan);
    setInterval(scan, SCAN_EVERY_MS);
    scan();
  }

  ns.badges = { mount };
})(globalThis);
