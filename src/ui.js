// The extension's UI: a button in YouTube's playlist header that opens the
// Watch Later Tools panel. When that header can't be found, for example on
// other pages during a run or after a YouTube redesign, a floating button
// takes its place so progress and Stop are always reachable.
//
// All DOM is built with createElement because YouTube enforces Trusted Types,
// and lives in shadow roots so YouTube's styles and ours never mix.
(function (root) {
  const ns = root.__wlTools;

  // YouTube's own element names, kept here so a redesign is a one-place fix.
  // The button goes on its own line after the first visible match.
  const YOUTUBE_DOM = Object.freeze({
    headerActions: Object.freeze([
      'yt-flexible-actions-view-model',
      'ytd-playlist-header-renderer .metadata-buttons-wrapper'
    ])
  });
  // How long to wait for YouTube to draw a playlist header before falling
  // back to the floating button.
  const HEADER_WAIT_MS = 3000;
  const PLACE_EVERY_MS = 500;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Material icons. The puzzle piece is the usual sign for "an extension".
  const EXTENSION_ICON = 'M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 '
    + '2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 '
    + '2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z';
  // "swap_vert", deliberately not the crossed arrows YouTube uses for shuffle play.
  const REORDER_ICON = 'M16 17.01V10h-2v7.01h-3L15 21l4-3.99h-3zM9 3 5 6.99h3V14h2V6.99h3L9 3z';
  const CHEVRON_ICON = 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z';
  const CLOSE_ICON = 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 '
    + '12 13.41 17.59 19 19 17.59 13.41 12z';
  const TOOLTIP = 'Watch Later Tools extension, not part of YouTube';

  const WORKING = new Set(['reading', 'running', 'verifying']);
  const ACTIVE = new Set([...WORKING, 'confirm', 'paused']);

  // Colors, buttons and base rules, shared with the Remove buttons in rows.js.
  const BASE_STYLES = `
    .wlt {
      --bg: #ffffff;
      --surface: #f2f2f2;
      --surface-hover: #e5e5e5;
      --text: #0f0f0f;
      --muted: #606060;
      --border: rgba(0, 0, 0, 0.1);
      --accent: #5b3df5;
      --accent-hover: #4a2ee0;
      --accent-text: #ffffff;
      --accent-soft: #efebff;
      --focus: #0f0f0f;
      --danger: #c5221f;
      --warn-bg: #fff4e0;
      --warn-text: #6b4300;
      --shadow: 0 4px 24px rgba(0, 0, 0, 0.16), 0 1px 4px rgba(0, 0, 0, 0.08);
      font-family: Roboto, Arial, sans-serif;
      font-size: 14px;
      line-height: 20px;
      color: var(--text);
    }
    .wlt[data-theme='dark'] {
      --bg: #212121;
      --surface: #383838;
      --surface-hover: #454545;
      --text: #f1f1f1;
      --muted: #aaaaaa;
      --border: rgba(255, 255, 255, 0.12);
      --accent: #a594ff;
      --accent-hover: #b8aaff;
      --accent-text: #0f0f0f;
      --accent-soft: #2f2a4a;
      --focus: #f1f1f1;
      --danger: #ff8a80;
      --warn-bg: #3a2c10;
      --warn-text: #ffd38a;
      --shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
    }
    button { font: inherit; }
    button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    svg { flex: none; width: 20px; height: 20px; fill: currentColor; }
    [hidden] { display: none !important; }
    .btn {
      height: 36px;
      padding: 0 16px;
      border: 0;
      border-radius: 18px;
      background: var(--surface);
      color: var(--text);
      font-weight: 500;
      cursor: pointer;
    }
    .btn:hover { background: var(--surface-hover); }
    .btn.primary { background: var(--accent); color: var(--accent-text); }
    .btn.primary:hover { background: var(--accent-hover); }
    .btn:disabled { opacity: 0.5; cursor: default; }
    .btn:disabled:hover { background: var(--surface); }
    .btn.primary:disabled:hover { background: var(--accent); }
  `;

  const STYLES = `
    :host { all: initial; display: block; }
    ${BASE_STYLES}
    p { margin: 0; }
    .launcher, .fab {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 0;
      background: var(--accent);
      color: var(--accent-text);
      font-weight: 500;
      cursor: pointer;
    }
    .launcher:hover, .fab:hover { background: var(--accent-hover); }
    .launcher {
      height: 36px;
      margin-top: 12px;
      padding: 0 10px 0 12px;
      border-radius: 18px;
    }
    .launcher .chevron { margin-left: -2px; transition: transform 0.15s ease; }
    .launcher[aria-expanded='true'] .chevron { transform: rotate(180deg); }
    .fab {
      position: fixed;
      right: 24px;
      bottom: 24px;
      z-index: 2100;
      height: 44px;
      padding: 0 20px 0 14px;
      border-radius: 22px;
      box-shadow: var(--shadow);
    }
    .panel {
      position: fixed;
      right: 24px;
      bottom: 80px;
      z-index: 2100;
      box-sizing: border-box;
      width: 360px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 32px);
      overflow-y: auto;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--bg);
      box-shadow: var(--shadow);
    }
    .panel:focus { outline: none; }
    header { display: flex; align-items: flex-start; gap: 10px; }
    .brand { width: 24px; height: 24px; margin-top: 1px; color: var(--accent); }
    .titles { flex: 1; min-width: 0; }
    h2 { margin: 0; font-size: 16px; line-height: 22px; font-weight: 500; }
    h3 { margin: 0; font-size: 14px; line-height: 20px; font-weight: 500; }
    .muted { color: var(--muted); }
    .small { font-size: 12px; line-height: 16px; }
    .byline { margin-top: 2px; }
    .icon-btn {
      display: inline-flex;
      margin: -6px -6px 0 0;
      padding: 6px;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
    }
    .icon-btn:hover { background: var(--surface); color: var(--text); }
    .target { margin-top: 12px; overflow-wrap: anywhere; }
    .target strong { font-weight: 500; }
    .tool { margin-top: 12px; padding: 12px; border-radius: 8px; background: var(--accent-soft); }
    .tool-title { display: flex; align-items: center; gap: 8px; }
    .tool-title svg { color: var(--accent); }
    .tool p { margin-top: 6px; }
    .confirm { margin-top: 12px; padding: 12px; border: 1px solid var(--accent); border-radius: 8px; }
    .confirm > * + * { margin-top: 8px; }
    .confirm .row { justify-content: flex-end; margin-top: 12px; }
    .warning, .status.warn { padding: 8px 10px; border-radius: 6px; background: var(--warn-bg); color: var(--warn-text); }
    .status { margin-top: 12px; overflow-wrap: anywhere; }
    .status.error { color: var(--danger); }
    .progress { margin-top: 8px; }
    .bar { height: 6px; overflow: hidden; border-radius: 3px; background: var(--surface); }
    .fill { width: 0; height: 100%; background: var(--accent); transition: width 0.2s ease; }
    .hint { margin-top: 6px; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .notice { margin-top: 12px; padding: 12px; border-radius: 8px; background: var(--warn-bg); color: var(--warn-text); }
    .notice > * + * { margin-top: 6px; }
    .notice .row { margin-top: 10px; }
    .note { margin-top: 12px; }
    .backups { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
    .backups .small { margin-top: 2px; }
    ul { margin: 4px 0 0; padding: 0; list-style: none; }
    li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; }
    li + li { border-top: 1px solid var(--border); }
    .meta { display: flex; flex-direction: column; min-width: 0; }
    .empty { margin-top: 8px; }
    @media (max-width: 480px) {
      .fab { right: 16px; bottom: 16px; }
      .panel { right: 16px; bottom: 72px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .fill, .launcher .chevron { transition: none; }
    }
  `;

  let handlers = {};
  let ui = null;
  let state = { phase: 'idle', visible: false, backups: [] };
  let isOpen = false;
  let wasActive = false;
  let pending = null;
  let backupsKey = '';
  // Where the button is: 'header', 'floating', or 'none'.
  let mode = 'none';
  let pageId = null;
  let pageSince = 0;
  let positionQueued = false;

  // Attributes whose value is a function become event listeners.
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'text') node.textContent = value;
      else if (name === 'class') node.className = value;
      else if (typeof value === 'function') node.addEventListener(name, value);
      else node.setAttribute(name, value);
    }
    node.append(...children);
    return node;
  }

  function icon(pathData, className = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathData);
    svg.append(path);
    return svg;
  }

  function button(label, className, onClick) {
    return el('button', { type: 'button', class: `btn ${className}`.trim(), text: label, click: onClick });
  }

  function createSheet(text = STYLES) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      return sheet;
    } catch (err) {
      return null;
    }
  }

  function currentTheme() {
    return document.documentElement.hasAttribute('dark') ? 'dark' : 'light';
  }

  function createHost(id, sheet) {
    const host = el('div', { id });
    const shadow = host.attachShadow({ mode: 'open' });
    if (sheet) shadow.adoptedStyleSheets = [sheet];
    else shadow.append(el('style', { text: STYLES }));
    const wrap = el('div', { class: 'wlt' });
    shadow.append(wrap);
    return { host, wrap };
  }

  // The panel's first tool. Further tools go next to it as more sections.
  function buildShuffleTool() {
    const start = button('Shuffle order...', 'primary', () => handlers.onShuffle?.());
    const section = el('section', { class: 'tool' }, [
      el('div', { class: 'tool-title' }, [icon(REORDER_ICON), el('h3', { text: 'Shuffle order' })]),
      el('p', {
        text: 'Puts the videos in a new random order and saves it to the playlist on YouTube, so it '
          + 'shows on all your devices. This is not shuffle play: nothing starts playing.'
      }),
      el('div', { class: 'row' }, [start])
    ]);
    return { section, start };
  }

  function build() {
    const sheet = createSheet();
    const panelRoot = createHost('wlt-root', sheet);
    const headerRoot = createHost('wlt-header-button', sheet);

    const launcherLabel = el('span');
    const launcher = el('button', {
      type: 'button',
      class: 'launcher',
      'aria-haspopup': 'dialog',
      title: TOOLTIP,
      click: () => setOpen(!isOpen)
    }, [icon(EXTENSION_ICON), launcherLabel, icon(CHEVRON_ICON, 'chevron')]);
    headerRoot.wrap.append(launcher);

    const fabLabel = el('span');
    const fab = el('button', {
      type: 'button',
      class: 'fab',
      'aria-haspopup': 'dialog',
      title: TOOLTIP,
      click: () => setOpen(!isOpen)
    }, [icon(EXTENSION_ICON), fabLabel]);

    const close = el('button', {
      type: 'button',
      class: 'icon-btn',
      'aria-label': 'Close',
      title: 'Close',
      click: () => setOpen(false)
    }, [icon(CLOSE_ICON)]);

    const target = el('strong');
    const targetLine = el('p', { class: 'target' }, [el('span', { class: 'muted', text: 'Playlist: ' }), target]);

    const noticeTitle = el('h3');
    const noticeMessage = el('p');
    const notice = el('section', { class: 'notice', role: 'status' }, [
      noticeTitle,
      noticeMessage,
      el('div', { class: 'row' }, [button('Dismiss', '', () => handlers.onDismiss?.())])
    ]);
    const busyNote = el('p', {
      class: 'note muted',
      text: 'Another YouTube tab is shuffling or restoring a playlist, or waiting for you to confirm one. '
        + 'You can start here when it finishes.'
    });

    const confirmTitle = el('h3');
    const confirmMessage = el('p');
    const confirmWarning = el('p', { class: 'warning' });
    const confirmNo = button('Cancel', '', () => answer(false));
    const confirmYes = button('Confirm', 'primary', () => answer(true));
    const confirmBox = el('section', { class: 'confirm', role: 'alertdialog', 'aria-label': 'Confirm' }, [
      confirmTitle,
      confirmMessage,
      confirmWarning,
      el('div', { class: 'row' }, [confirmNo, confirmYes])
    ]);

    const status = el('p', { class: 'status', role: 'status' });
    const fill = el('div', { class: 'fill' });
    const bar = el('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Progress', 'aria-valuemin': '0' }, [fill]);
    const progress = el('div', { class: 'progress' }, [
      bar,
      el('p', { class: 'hint muted small', text: 'Keep this tab open until it finishes.' })
    ]);

    const resume = button('Resume', 'primary', () => handlers.onResume?.());
    const retry = button('Retry', 'primary', () => handlers.onResume?.());
    const reload = button('Reload page', '', () => handlers.onReload?.());
    const stop = button('Stop', '', () => handlers.onStop?.());
    const actions = el('div', { class: 'row' }, [resume, retry, reload, stop]);

    const shuffleTool = buildShuffleTool();
    const tools = el('div', { class: 'tools' }, [shuffleTool.section]);

    const backupList = el('ul');
    const backupEmpty = el('p', { class: 'empty muted', text: 'None yet.' });
    const backups = el('section', { class: 'backups' }, [
      el('h3', { text: 'Backups' }),
      el('p', {
        class: 'muted small',
        text: 'Saved automatically before each change. Restoring puts the videos back in that order.'
      }),
      backupEmpty,
      backupList
    ]);

    const panel = el('section', {
      class: 'panel',
      role: 'dialog',
      'aria-label': 'Watch Later Tools',
      tabindex: '-1',
      keydown: onKeydown
    }, [
      el('header', {}, [
        icon(EXTENSION_ICON, 'brand'),
        el('div', { class: 'titles' }, [
          el('h2', { text: 'Watch Later Tools' }),
          el('p', { class: 'byline muted small', text: 'Extension, not part of YouTube' })
        ]),
        close
      ]),
      targetLine,
      notice,
      busyNote,
      confirmBox,
      status,
      progress,
      actions,
      tools,
      backups
    ]);
    panelRoot.wrap.append(panel, fab);

    return {
      panelHost: panelRoot.host,
      headerHost: headerRoot.host,
      wraps: [panelRoot.wrap, headerRoot.wrap],
      launcher,
      launcherLabel,
      fab,
      fabLabel,
      panel,
      target,
      targetLine,
      notice,
      noticeTitle,
      noticeMessage,
      busyNote,
      confirmBox,
      confirmTitle,
      confirmMessage,
      confirmWarning,
      confirmNo,
      confirmYes,
      status,
      progress,
      bar,
      fill,
      actions,
      resume,
      retry,
      reload,
      stop,
      tools,
      shuffle: shuffleTool.start,
      backups,
      backupList,
      backupEmpty
    };
  }

  function isShown(node) {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findHeaderActions() {
    for (const selector of YOUTUBE_DOM.headerActions) {
      const match = [...document.querySelectorAll(selector)].find(isShown);
      if (match) return match;
    }
    return null;
  }

  // Puts the button in YouTube's header when there is one, and otherwise in
  // the corner. On a fresh playlist page it waits briefly for the header.
  function placeLaunchers() {
    if (state.playlistId !== pageId) {
      pageId = state.playlistId;
      pageSince = Date.now();
    }
    const confirming = pending !== null;
    const wanted = state.visible || confirming;
    const actionsRow = wanted && state.playlistId ? findHeaderActions() : null;
    const waiting = Boolean(state.playlistId) && !confirming && !ACTIVE.has(state.phase)
      && Date.now() - pageSince < HEADER_WAIT_MS;
    if (!wanted) mode = 'none';
    else if (actionsRow) mode = 'header';
    else mode = waiting ? 'none' : 'floating';

    if (mode === 'header') {
      if (ui.headerHost.previousElementSibling !== actionsRow) actionsRow.after(ui.headerHost);
    } else if (ui.headerHost.isConnected) {
      ui.headerHost.remove();
    }
    if (!ui.panelHost.isConnected && document.body) document.body.append(ui.panelHost);
    ui.fab.hidden = mode !== 'floating';
    ui.panel.hidden = !isOpen || mode === 'none';
  }

  // Below the header button, or above it when only that fits. When neither
  // fits, the side with more room is used and the panel scrolls, so it never
  // covers the button. The floating button's position comes from the CSS.
  function positionPanel() {
    const { panel } = ui;
    const anchored = mode === 'header' && !panel.hidden;
    panel.style.maxHeight = '';
    if (!anchored) {
      for (const side of ['top', 'left', 'right', 'bottom']) panel.style[side] = '';
      return;
    }
    const margin = 16;
    const gap = 8;
    const anchor = ui.launcher.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = panel;
    const below = root.innerHeight - anchor.bottom - gap - margin;
    const above = anchor.top - gap - margin;
    let top;
    if (height <= below || below >= above) {
      top = anchor.bottom + gap;
      if (height > below) panel.style.maxHeight = `${Math.max(below, 160)}px`;
    } else {
      if (height > above) panel.style.maxHeight = `${above}px`;
      top = anchor.top - gap - Math.min(height, above);
    }
    const left = Math.max(margin, Math.min(anchor.left, root.innerWidth - width - margin));
    Object.assign(panel.style, { top: `${top}px`, left: `${left}px`, right: 'auto', bottom: 'auto' });
  }

  function queuePosition() {
    if (positionQueued || !ui || ui.panel.hidden) return;
    positionQueued = true;
    root.requestAnimationFrame(() => {
      positionQueued = false;
      positionPanel();
    });
  }

  function activeLauncher() {
    return mode === 'floating' ? ui.fab : ui.launcher;
  }

  function setOpen(open, { focus = true } = {}) {
    isOpen = open;
    renderNow();
    if (!focus) return;
    if (open) ui.panel.focus({ preventScroll: true });
    else activeLauncher().focus({ preventScroll: true });
  }

  function answer(value) {
    pending?.resolve(value);
  }

  function onKeydown(event) {
    if (event.key !== 'Escape') return;
    if (pending) answer(false);
    else setOpen(false);
  }

  // A click anywhere else closes the panel, like YouTube's own menus. An open
  // question stays pending, and the button says so.
  function onPointerDown(event) {
    if (!isOpen || !ui) return;
    const path = event.composedPath();
    if (path.includes(ui.panelHost) || path.includes(ui.headerHost)) return;
    setOpen(false, { focus: false });
  }

  function launcherText() {
    if (pending) return 'Waiting for you to confirm';
    switch (state.phase) {
      case 'reading': return 'Reading playlist...';
      case 'running': return `Moving ${state.done} / ${state.total}`;
      case 'verifying': return 'Checking the new order...';
      case 'paused': return 'Paused';
      default:
        if (state.busyElsewhere) return 'Busy in another tab';
        if (state.interrupted) return state.interrupted.title;
        return 'Watch Later Tools';
    }
  }

  function restoreButton(backup) {
    const node = el('button', {
      type: 'button',
      class: 'btn',
      text: 'Restore',
      'aria-label': `Restore the order saved on ${backup.label}`,
      click: () => handlers.onRestore?.(backup.id)
    });
    node.disabled = Boolean(state.busyElsewhere);
    return node;
  }

  function renderBackups() {
    const backups = state.backups ?? [];
    const key = JSON.stringify([backups, Boolean(state.busyElsewhere)]);
    if (key === backupsKey) return;
    backupsKey = key;
    ui.backupEmpty.hidden = backups.length > 0;
    ui.backupList.replaceChildren(...backups.map((backup) => el('li', {}, [
      el('div', { class: 'meta' }, [
        el('span', { text: backup.label }),
        el('span', {
          class: 'muted small',
          text: `${backup.count} videos${backup.note ? `, ${backup.note}` : ''}`
        })
      ]),
      restoreButton(backup)
    ])));
  }

  function renderConfirm() {
    const { request } = pending;
    ui.confirmTitle.textContent = request.title;
    ui.confirmMessage.textContent = request.message;
    ui.confirmWarning.textContent = request.warning ?? '';
    ui.confirmWarning.hidden = !request.warning;
    ui.confirmYes.textContent = request.confirmLabel ?? 'Confirm';
  }

  function renderProgress(show) {
    ui.progress.hidden = !show;
    if (!show) return;
    const percent = Math.round((state.done / state.total) * 100);
    ui.fill.style.width = `${percent}%`;
    ui.bar.setAttribute('aria-valuemax', String(state.total));
    ui.bar.setAttribute('aria-valuenow', String(state.done));
  }

  function renderNow() {
    if (!ui) return;
    const { phase } = state;
    const confirming = pending !== null;
    const active = confirming || ACTIVE.has(phase);
    // Open the panel when a run starts, even one started from the console.
    if (active && !wasActive) isOpen = true;
    wasActive = active;

    const theme = currentTheme();
    for (const wrap of ui.wraps) wrap.dataset.theme = theme;
    const label = launcherText();
    ui.launcherLabel.textContent = label;
    ui.fabLabel.textContent = label;
    ui.launcher.setAttribute('aria-expanded', String(isOpen));
    ui.fab.setAttribute('aria-expanded', String(isOpen));

    ui.target.textContent = state.playlistLabel ?? '';
    ui.targetLine.hidden = !state.playlistLabel;

    const idle = !active;
    const notice = idle ? state.interrupted : null;
    ui.notice.hidden = !notice;
    if (notice) {
      ui.noticeTitle.textContent = notice.title;
      ui.noticeMessage.textContent = notice.message;
    }
    ui.busyNote.hidden = !(idle && state.busyElsewhere);

    ui.confirmBox.hidden = !confirming;
    if (confirming) renderConfirm();

    ui.status.textContent = state.status ?? '';
    ui.status.className = `status ${state.statusKind ?? 'info'}`;
    ui.status.hidden = confirming || !state.status;
    renderProgress(!confirming && (WORKING.has(phase) || phase === 'paused') && state.total > 0);

    ui.resume.hidden = confirming || phase !== 'paused';
    ui.retry.hidden = !idle || !state.canRetry;
    ui.reload.hidden = !idle || (phase !== 'done' && phase !== 'partial');
    ui.stop.hidden = confirming || !(WORKING.has(phase) || phase === 'paused');
    ui.actions.hidden = [ui.resume, ui.retry, ui.reload, ui.stop].every((b) => b.hidden);

    ui.tools.hidden = !idle;
    ui.shuffle.disabled = Boolean(state.busyElsewhere);
    ui.backups.hidden = !idle;
    if (idle) renderBackups();

    placeLaunchers();
    positionPanel();
  }

  function render(next) {
    state = next;
    renderNow();
  }

  // Resolves to true or false. Aborting `signal` answers false.
  function confirm(request, signal) {
    if (!ui) {
      const text = [request.title, request.message, request.warning].filter(Boolean).join('\n\n');
      return Promise.resolve(root.confirm(text));
    }
    answer(false);
    return new Promise((resolve) => {
      const onAbort = () => entry.resolve(false);
      const entry = {
        request,
        resolve(value) {
          if (pending !== entry) return;
          pending = null;
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
          renderNow();
        }
      };
      pending = entry;
      if (signal?.aborted) {
        entry.resolve(false);
        return;
      }
      signal?.addEventListener('abort', onAbort);
      isOpen = true;
      renderNow();
      ui.confirmNo.focus({ preventScroll: true });
    });
  }

  function mount(nextHandlers) {
    handlers = nextHandlers;
    if (ui || !document.body) return;
    ui = build();
    document.body.append(ui.panelHost);
    new MutationObserver(renderNow).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['dark']
    });
    // YouTube draws and redraws its header on its own schedule, so keep
    // checking where the button belongs.
    setInterval(() => {
      if (!state.visible && !pending && mode === 'none') return;
      placeLaunchers();
      positionPanel();
    }, PLACE_EVERY_MS);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('scroll', queuePosition, { capture: true, passive: true });
    root.addEventListener('resize', queuePosition);
    renderNow();
  }

  ns.ui = {
    mount,
    render,
    confirm,
    // For other parts of the extension's UI, so they look the same.
    kit: { el, icon, createSheet, currentTheme, BASE_STYLES, EXTENSION_ICON, TOOLTIP }
  };
})(globalThis);
