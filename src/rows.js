// Buttons on each video of a playlist page, beside YouTube's own menu: move
// to the top and move to the bottom, stacked, and remove. Each takes one
// click instead of going through the menu. The playlist panel next to a
// playing video gets the remove button.
//
// A moved row is moved in YouTube's list as well, so the page shows the new
// order without a reload. A removed row turns into a bar with Undo.
//
// Rows are YouTube's elements. The extension adds its own elements next to
// them, moves a row within its list, and hides a row whose video is no longer
// in the part of the list on the page; it never changes YouTube's own
// content. YouTube reuses row elements for other videos, so which video a row
// holds is read from its link on every check.
(function (root) {
  const ns = root.__wlTools;
  const { el, icon, createSheet, adoptStyles, currentTheme, BASE_STYLES, EXTENSION_ICON, TOOLTIP } = ns.ui.kit;

  // YouTube's own element names, kept here so a redesign is a one-place fix.
  // `menu` is YouTube's menu, `menuButton` the ⋮ the buttons line up with,
  // and `list` the list a row belongs to.
  const YOUTUBE_ROWS = Object.freeze([
    // The older playlist row is a flex row: the buttons go before its menu.
    Object.freeze({
      row: 'ytd-playlist-video-renderer',
      before: ':scope > #menu',
      menu: ':scope > #menu',
      menuButton: ':scope > #menu yt-icon-button#button',
      title: '#video-title',
      list: 'ytd-playlist-video-list-renderer',
      actions: Object.freeze(['top', 'bottom', 'remove'])
    }),
    // The newer playlist row floats its menu over its top right corner, so
    // the buttons go after the title and details, kept clear of the menu.
    Object.freeze({
      row: 'yt-lockup-view-model',
      after: '.ytLockupMetadataViewModelTextContainer',
      menu: '.ytLockupMetadataViewModelMenuButton',
      menuButton: '.ytLockupMetadataViewModelMenuButton button',
      title: '.ytLockupMetadataViewModelTitle',
      list: 'ytd-browse',
      actions: Object.freeze(['top', 'bottom', 'remove'])
    }),
    // The panel beside a playing video. Like YouTube's ⋮ there, the button
    // shows when the pointer is over the row. The panel can start partway
    // through a long playlist.
    Object.freeze({
      row: 'ytd-playlist-panel-video-renderer',
      before: ':scope > #menu',
      menu: ':scope > #menu',
      menuButton: ':scope > #menu yt-icon-button#button',
      title: '#video-title',
      list: 'ytd-playlist-panel-renderer',
      actions: Object.freeze(['remove']),
      onHover: true,
      windowed: true
    })
  ]);
  const ROW_SELECTOR = YOUTUBE_ROWS.map((kind) => kind.row).join(', ');
  // Sits at the end of a list while YouTube has more of it to load.
  const CONTINUATION = 'yt-continuation-item-view-model, ytd-continuation-item-renderer';
  const SCAN_EVERY_MS = 500;
  // Material "vertical_align_top", "vertical_align_bottom" and "delete".
  const ACTIONS = Object.freeze({
    top: Object.freeze({
      icon: 'M8 11h3v10h2V11h3l-4-4-4 4zM4 3v2h16V3H4z',
      label: (playlist) => `Move to the top of ${playlist}`
    }),
    bottom: Object.freeze({
      icon: 'M16 13h-3V3h-2v10H8l4 4 4-4zM4 19v2h16v-2H4z',
      label: (playlist) => `Move to the bottom of ${playlist}`
    }),
    remove: Object.freeze({
      icon: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
      label: (playlist) => `Remove from ${playlist}`
    })
  });
  // A removed row shows a bar with Undo in these states.
  const BAR = new Set(['removed', 'undoing', 'undoFailed']);
  // In these, the row's video is not in that place, so the row is hidden.
  // 'away' is a video moved to a bottom that isn't on the page yet.
  const HIDDEN = new Set([...BAR, 'away']);

  const HOVER_ROWS = YOUTUBE_ROWS.filter((kind) => kind.onHover).map((kind) => `:host-context(${kind.row}:hover) .act`);

  const STYLES = `
    :host { all: initial; display: flex; flex: none; align-self: flex-start; }
    :host(.wlt-on-hover[data-status='ready']) .act { opacity: 0; }
    ${[...HOVER_ROWS, '.act:focus-visible'].join(', ')} { opacity: 1 !important; }
    :host(.wlt-row-bar) { display: block; align-self: auto; margin: 4px 0; }
    ${BASE_STYLES}
    .wlt { display: flex; align-items: center; }
    p { margin: 0; }
    .act {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--accent);
      cursor: pointer;
    }
    .act:hover { background: var(--accent-soft); }
    .act:disabled { opacity: 0.5; cursor: default; }
    .act:disabled:hover { background: transparent; }
    .stack { display: flex; flex-direction: column; }
    .stack .act { width: 28px; height: 28px; }
    .msg { max-width: 220px; margin-right: 4px; font-size: 12px; line-height: 16px; color: var(--muted); }
    .msg.error { color: var(--danger); }
    .bar {
      box-sizing: border-box;
      height: 100%;
      gap: 12px;
      padding: 8px 8px 8px 12px;
      border: 1px solid var(--accent);
      border-radius: 8px;
    }
    .bar .brand { color: var(--accent); }
    .bar .text { flex: 1; min-width: 0; }
    .bar .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar .title { font-weight: 500; }
    .bar .msg { max-width: none; margin: 0; }
  `;

  let handlers = {};
  let page = { playlistId: null, removable: false, label: 'this playlist' };
  let sheet = null;
  let theme = null;
  let timer = null;
  // Row element -> what the extension knows and shows for it.
  const tracked = new Map();

  function createHost(className) {
    sheet ??= createSheet(STYLES);
    const host = el('div', { class: className });
    const shadow = host.attachShadow({ mode: 'open' });
    adoptStyles(shadow, sheet, STYLES);
    return { host, shadow };
  }

  // The move buttons sit one above the other, with remove beside them.
  function buildTools(state) {
    const { host, shadow } = createHost('wlt-row-tools');
    const prepare = () => {
      if (state.status === 'ready') handlers.onPrepare?.({ playlistId: state.playlistId, videoId: state.videoId });
    };
    const button = (name) => el('button', {
      type: 'button',
      class: `act ${name}`,
      'aria-label': ACTIONS[name].label(state.label),
      title: `${ACTIONS[name].label(state.label)}. ${TOOLTIP}.`,
      click: () => onActionClick(state, name),
      pointerenter: prepare,
      focus: prepare
    }, [icon(ACTIONS[name].icon)]);
    const moves = state.kind.actions.filter((name) => name !== 'remove').map(button);
    const remove = button('remove');
    const msg = el('span', { class: 'msg', role: 'status' });
    const wrap = el('div', { class: 'wlt' }, [msg]);
    if (moves.length > 0) wrap.append(el('div', { class: 'stack' }, moves));
    wrap.append(remove);
    shadow.append(wrap);
    if (state.kind.onHover) host.classList.add('wlt-on-hover');
    host.addEventListener('click', (event) => event.stopPropagation());
    return { host, wrap, msg, buttons: [...moves, remove], remove };
  }

  function buildBar(state) {
    const { host, shadow } = createHost('wlt-row-bar');
    const title = el('span', { class: 'title' });
    const msg = el('p', { class: 'msg' });
    const undo = el('button', { type: 'button', class: 'btn', text: 'Undo', click: () => onUndoClick(state) });
    const wrap = el('div', { class: 'wlt bar', role: 'status', title: TOOLTIP }, [
      icon(EXTENSION_ICON, 'brand'),
      el('div', { class: 'text' }, [el('p', { class: 'what' }, [el('span', { text: 'Removed ' }), title]), msg]),
      undo
    ]);
    shadow.append(wrap);
    host.addEventListener('click', (event) => event.stopPropagation());
    return { host, wrap, title, msg, undo };
  }

  // The video a row holds, from its link to this playlist, or null.
  function videoOf(row, playlistId) {
    for (const link of row.querySelectorAll('a[href*="watch?"]')) {
      let url;
      try {
        url = new URL(link.href);
      } catch (err) {
        continue;
      }
      if (url.pathname !== '/watch' || url.searchParams.get('list') !== playlistId) continue;
      const videoId = url.searchParams.get('v');
      const index = Number(url.searchParams.get('index')) || null;
      if (videoId) return { videoId, index, link, href: link.getAttribute('href') };
    }
    return null;
  }

  function holdsSameVideo(state) {
    const { row, link } = state;
    if (link.isConnected && row.contains(link) && link.getAttribute('href') === state.href) return true;
    const now = videoOf(row, state.playlistId);
    if (now?.videoId !== state.videoId) return false;
    Object.assign(state, { link: now.link, href: now.href, index: now.index });
    return true;
  }

  function readTitle(state) {
    const text = state.row.querySelector(state.kind.title)?.textContent.trim();
    return text || 'this video';
  }

  function setStyle(node, name, value) {
    if (node.style[name] !== value) node.style[name] = value;
  }

  function showMessage(node, text, kind) {
    node.hidden = !text;
    node.textContent = text;
    node.className = `msg ${kind}`.trim();
  }

  function applyTheme(state) {
    state.tools.wrap.dataset.theme = theme;
    if (state.bar) state.bar.wrap.dataset.theme = theme;
  }

  // The newer row's menu floats over the corner, so leave it that much room.
  function keepClearOfMenu(state) {
    if (state.clearance !== null) return;
    const menu = state.row.querySelector(state.kind.menu);
    if (!menu || menu.offsetWidth === 0) return;
    state.clearance = (parseFloat(getComputedStyle(menu).right) || 0) + menu.offsetWidth;
    Object.assign(state.tools.host.style, { marginLeft: 'auto', marginRight: `${state.clearance}px` });
  }

  // How far the remove button's middle is from the middle of YouTube's ⋮, or
  // null when either can't be measured. Measuring works whatever the layout.
  function misalignment(state) {
    if (HIDDEN.has(state.status) || !state.tools.host.isConnected) return null;
    const target = state.row.querySelector(state.kind.menuButton) ?? state.row.querySelector(state.kind.menu);
    if (!target) return null;
    const menu = target.getBoundingClientRect();
    const own = state.tools.remove.getBoundingClientRect();
    if (menu.height === 0 || own.height === 0) return null;
    return (menu.top + menu.height / 2) - (own.top + own.height / 2);
  }

  // Measures every row first and then moves the ones that are off, so the
  // page is laid out once per check rather than once per row.
  function align(states) {
    const off = [];
    for (const state of states) {
      const delta = misalignment(state);
      if (delta !== null && Math.abs(delta) >= 0.5) off.push([state, delta]);
    }
    for (const [state, delta] of off) {
      state.shiftY = Math.round(state.shiftY + delta);
      state.tools.host.style.marginTop = `${state.shiftY}px`;
    }
  }

  // Puts the extension's elements where they belong. YouTube redraws rows on
  // its own schedule, so this runs on every check.
  function place(state) {
    const { row, kind, tools, bar } = state;
    if (HIDDEN.has(state.status)) {
      if (!BAR.has(state.status)) bar?.host.remove();
      else if (bar.host.nextSibling !== row) row.before(bar.host);
      setStyle(row, 'display', 'none');
      return;
    }
    bar?.host.remove();
    setStyle(row, 'display', state.saved.display);
    if (kind.before) {
      const anchor = row.querySelector(kind.before);
      if (anchor && tools.host.nextElementSibling !== anchor) anchor.before(tools.host);
      if (!anchor && tools.host.parentNode !== row) row.append(tools.host);
      return;
    }
    const anchor = row.querySelector(kind.after);
    if (!anchor) {
      tools.host.remove();
      return;
    }
    if (anchor.nextElementSibling !== tools.host) anchor.after(tools.host);
    keepClearOfMenu(state);
  }

  // The room a row takes up, so its Removed bar can take exactly the same and
  // nothing below it moves. Measured while the row is still on the page.
  function measureSpace(row) {
    const { height } = row.getBoundingClientRect();
    if (height === 0) return null;
    const { marginTop, marginBottom } = getComputedStyle(row);
    return { height: `${height}px`, marginTop, marginBottom };
  }

  function render(state) {
    const { tools, status } = state;
    tools.host.dataset.status = status;
    for (const button of tools.buttons) {
      button.disabled = status === 'busy';
      button.setAttribute('aria-busy', String(status === 'busy'));
    }
    showMessage(tools.msg, HIDDEN.has(status) ? '' : state.message, state.messageKind);
    setStyle(state.row, 'opacity', status === 'busy' ? '0.5' : state.saved.opacity);
    if (BAR.has(status)) {
      state.bar ??= buildBar(state);
      const { bar } = state;
      if (state.space) Object.assign(bar.host.style, state.space);
      bar.title.textContent = state.title;
      bar.undo.disabled = status === 'undoing';
      bar.undo.textContent = status === 'undoFailed' ? 'Try again' : 'Undo';
      const note = status === 'undoing' ? 'Adding it back...' : status === 'undoFailed' ? state.message : '';
      showMessage(bar.msg, note, status === 'undoFailed' ? 'error' : '');
    }
    applyTheme(state);
    place(state);
  }

  function setStatus(state, status, message = '', messageKind = '') {
    Object.assign(state, { status, message, messageKind });
    render(state);
  }

  function isCurrent(state) {
    return tracked.get(state.row) === state;
  }

  // The row's list, and its own item in it: the row itself, or the wrapper
  // YouTube puts around it.
  function findItem(state) {
    for (let item = state.row; item.parentElement; item = item.parentElement) {
      const list = item.parentElement;
      if (list.querySelectorAll(state.kind.row).length > 1) return { list, item };
    }
    return null;
  }

  // Shows a moved video in its new place in YouTube's list. Returns 'moved',
  // 'away' when its new place is further down than the page has loaded, or
  // null when the list can't be found.
  function relocate(state, to) {
    const found = findItem(state);
    if (!found) return null;
    const { list, item } = found;
    const items = [...list.children].filter((child) => child.matches(state.kind.row) || child.querySelector(state.kind.row));
    if (to === 'top') {
      if (items[0] !== item) list.insertBefore(item, items[0]);
      return 'moved';
    }
    if (list.querySelector(CONTINUATION)) return 'away';
    if (items.at(-1) !== item) items.at(-1).after(item);
    return 'moved';
  }

  async function onActionClick(state, name) {
    if (state.status !== 'ready') return;
    const focused = state.tools.host.shadowRoot.activeElement;
    const { playlistId, videoId } = state;
    state.title = readTitle(state);
    setStatus(state, 'busy');
    try {
      if (name === 'remove') {
        await handlers.onRemove({ playlistId, videoId });
        if (!isCurrent(state)) return;
        state.space = measureSpace(state.row);
        setStatus(state, 'removed');
        if (focused) state.bar.undo.focus({ preventScroll: true });
        return;
      }
      await handlers.onMove({ playlistId, videoId, to: name });
      if (!isCurrent(state)) return;
      const where = relocate(state, name);
      if (where === 'away') {
        setStatus(state, 'away');
        return;
      }
      setStatus(state, 'ready', where === 'moved' ? '' : 'Moved. Reload to see it in its new place.');
      // Moving an element in the page takes focus off it.
      if (focused) focused.focus({ preventScroll: true });
    } catch (err) {
      if (isCurrent(state)) setStatus(state, 'ready', err.message, 'error');
    }
  }

  // The nearest video above this row, in the same list, that is still in
  // that part of the playlist. With none shown above it, null means the top
  // of the playlist, and undefined means unknown: the panel beside a playing
  // video can start partway through a long playlist.
  function videoAbove(state) {
    const list = state.row.closest(state.kind.list);
    let above = null;
    for (const row of document.querySelectorAll(ROW_SELECTOR)) {
      if (row === state.row) break;
      const other = tracked.get(row);
      if (!other || other.playlistId !== state.playlistId || HIDDEN.has(other.status)) continue;
      if (row.closest(other.kind.list) === list) above = other.videoId;
    }
    if (above !== null || !state.kind.windowed) return above;
    return state.index === 1 ? null : undefined;
  }

  // Undo for a removal: adds the video back after the video now above it.
  async function onUndoClick(state) {
    if (state.status === 'undoing') return;
    const hadFocus = state.bar.host.shadowRoot.activeElement !== null;
    const afterVideoId = videoAbove(state);
    setStatus(state, 'undoing');
    try {
      const { placed } = await handlers.onUndo({ playlistId: state.playlistId, videoId: state.videoId, afterVideoId });
      if (!isCurrent(state)) return;
      setStatus(state, 'ready', placed ? '' : 'Added back, but not in its old place. Reload to see where.');
      if (hadFocus) state.tools.remove.focus({ preventScroll: true });
    } catch (err) {
      if (isCurrent(state)) setStatus(state, 'undoFailed', err.message, 'error');
    }
  }

  function track(row) {
    const kind = YOUTUBE_ROWS.find((candidate) => row.matches(candidate.row));
    const video = kind ? videoOf(row, page.playlistId) : null;
    if (!video) return null;
    const state = {
      row,
      kind,
      playlistId: page.playlistId,
      label: page.label,
      ...video,
      title: '',
      status: 'ready',
      message: '',
      messageKind: '',
      clearance: null,
      shiftY: 0,
      space: null,
      saved: { display: row.style.display, opacity: row.style.opacity },
      bar: null
    };
    state.tools = buildTools(state);
    tracked.set(row, state);
    render(state);
    return state;
  }

  // Takes the extension's elements back out and shows the row again.
  function release(state) {
    tracked.delete(state.row);
    state.tools.host.remove();
    state.bar?.host.remove();
    setStyle(state.row, 'display', state.saved.display);
    setStyle(state.row, 'opacity', state.saved.opacity);
  }

  function scan() {
    const nextTheme = currentTheme();
    const themeChanged = nextTheme !== theme;
    theme = nextTheme;
    for (const state of [...tracked.values()]) {
      const keep = page.removable && state.playlistId === page.playlistId
        && state.row.isConnected && holdsSameVideo(state);
      if (!keep) release(state);
      else if (themeChanged) applyTheme(state);
    }
    if (!page.removable) return;
    const placed = [];
    for (const row of document.querySelectorAll(ROW_SELECTOR)) {
      const state = tracked.get(row) ?? track(row);
      if (!state) continue;
      place(state);
      placed.push(state);
    }
    align(placed);
  }

  // main.js says which playlist is open and whether its videos can be changed.
  function show(next) {
    page = {
      playlistId: next.playlistId ?? null,
      removable: next.removable === true,
      label: next.label ?? 'this playlist'
    };
    scan();
  }

  function mount(nextHandlers) {
    handlers = nextHandlers;
    if (timer !== null) return;
    timer = setInterval(scan, SCAN_EVERY_MS);
    scan();
  }

  ns.rows = { mount, show };
})(globalThis);
