// A button on the thumbnail under the pointer, the way YouTube shows its own
// hover buttons: it saves the video to Watch later, or, for a video that is
// already saved, removes it. It sits in the corner where the saved mark is,
// covering it exactly, and stays away from thumbnails that already show
// YouTube's own Watch later button. Watch later's own rows never get one.
//
// While YouTube plays a preview over a thumbnail, the button moves onto the
// preview, so it stays on top and pointing at it doesn't end the preview.
//
// This file only decides when and where the button shows. Its look comes from
// indicator.js; main.js hands in that and everything else it uses.
(function (root) {
  const ns = root.__wlTools;
  // While the button shows, how often to check that it is still in the right
  // place: YouTube starts its preview without the pointer moving.
  const RECHECK_MS = 250;

  // { saved, thumbnails, createButton, canSave, save, remove, skipList }, from mount().
  let source = null;
  let button = null;
  // The video whose thumbnail the button is on.
  let current = null;
  // videoId -> { state, message } while a save or removal is under way, and
  // after a save or a failure, for as long as it stays pointed at.
  const outcomes = new Map();
  let pointer = null;
  let frame = 0;
  let timer = null;

  function hide() {
    button.host.remove();
    // A finished save's check mark or error only lasts while it is pointed at.
    if (current && outcomes.get(current)?.state !== 'busy') outcomes.delete(current);
    current = null;
    clearInterval(timer);
    timer = null;
  }

  function show(surface, videoId) {
    if (current !== videoId) {
      if (current && outcomes.get(current)?.state !== 'busy') outcomes.delete(current);
      current = videoId;
    }
    const idle = { state: source.saved.has(videoId) ? 'remove' : 'save', message: '' };
    const outcome = outcomes.get(videoId) ?? idle;
    button.show(outcome.state, outcome.message);
    if (button.host.parentNode !== surface) surface.append(button.host);
    timer ??= setInterval(update, RECHECK_MS);
  }

  function update() {
    frame = 0;
    const hit = pointer && source.canSave() ? source.thumbnails.at(pointer.x, pointer.y) : null;
    const videoId = hit ? source.thumbnails.videoOf(hit.thumbnail, source.skipList) : null;
    const shown = videoId !== null && !source.thumbnails.hasOwnSaveButton(hit.thumbnail);
    if (shown) show(hit.surface, videoId);
    else hide();
  }

  function schedule() {
    frame ||= requestAnimationFrame(update);
  }

  async function press() {
    const videoId = current;
    if (!videoId || outcomes.get(videoId)?.state === 'busy') return;
    const removing = source.saved.has(videoId);
    outcomes.set(videoId, { state: 'busy', message: '' });
    update();
    try {
      if (removing) {
        await source.remove(videoId);
        // The button goes back to saving, which also undoes a slip.
        outcomes.delete(videoId);
      } else {
        await source.save(videoId);
        outcomes.set(videoId, { state: 'done', message: '' });
      }
    } catch (err) {
      outcomes.set(videoId, { state: 'failed', message: err.message });
    }
    // The pointer may have moved on while the request was out.
    if (current !== videoId && outcomes.get(videoId)?.state === 'done') outcomes.delete(videoId);
    update();
  }

  // `saved` answers has(videoId); `thumbnails` finds the thumbnail under the
  // pointer; `createButton(onPress)` makes the button; `canSave()` says
  // whether saving is possible at all; `save(videoId)` and `remove(videoId)`
  // do the work; and `skipList` is the playlist whose own rows never get the
  // button.
  function mount(next) {
    if (source) return;
    source = next;
    button = source.createButton(press);
    document.addEventListener('pointermove', (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      schedule();
    }, { capture: true, passive: true });
    // The pointer left the window.
    root.addEventListener('mouseout', (event) => {
      if (event.relatedTarget !== null) return;
      pointer = null;
      schedule();
    });
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    // A save made elsewhere, for example by YouTube's own buttons.
    source.saved.subscribe(schedule);
  }

  ns.quickSave = { mount };
})(globalThis);
