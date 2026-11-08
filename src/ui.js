// Floating button and panel. All DOM is built with createElement because
// YouTube enforces Trusted Types, and it lives in a shadow root so YouTube's
// styles and ours never mix.
(function (root) {
  const ns = root.__wlShuffle;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Material "swap_vert": deliberately not the crossed-arrows icon YouTube
  // uses for shuffle play.
  const REORDER_ICON = 'M16 17.01V10h-2v7.01h-3L15 21l4-3.99h-3zM9 3 5 6.99h3V14h2V6.99h3L9 3z';
  const CLOSE_ICON = 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 '
    + '12 13.41 17.59 19 19 17.59 13.41 12z';

  const WORKING = new Set(['reading', 'running', 'verifying']);
  const ACTIVE = new Set([...WORKING, 'confirm', 'paused']);

  const STYLES = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    .wls {
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
    .wls[data-theme='dark'] {
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
    svg { flex: none; width: 22px; height: 22px; fill: currentColor; }
    p { margin: 0; }
    .fab {
      position: fixed;
      right: 24px;
      bottom: 24px;
      z-index: 2100;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      height: 44px;
      padding: 0 20px 0 14px;
      border: 0;
      border-radius: 22px;
      background: var(--accent);
      color: var(--accent-text);
      font-weight: 500;
      cursor: pointer;
      box-shadow: var(--shadow);
    }
    .fab:hover { background: var(--accent-hover); }
    .panel {
      position: fixed;
      right: 24px;
      bottom: 80px;
      z-index: 2100;
      box-sizing: border-box;
      width: 360px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 112px);
      overflow-y: auto;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--bg);
      box-shadow: var(--shadow);
    }
    header { display: flex; align-items: flex-start; gap: 8px; }
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
    .icon-btn svg { width: 20px; height: 20px; }
    .explain { margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: var(--accent-soft); }
    .target { margin-top: 12px; overflow-wrap: anywhere; }
    .target strong { font-weight: 500; }
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
      .fill { transition: none; }
    }
  `;

  let handlers = {};
  let ui = null;
  let state = { phase: 'idle', visible: false, backups: [] };
  let isOpen = false;
  let wasActive = false;
  let pending = null;
  let backupsKey = '';

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

  function icon(pathData) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathData);
    svg.append(path);
    return svg;
  }

  function button(label, className, onClick) {
    return el('button', { type: 'button', class: `btn ${className}`.trim(), text: label, click: onClick });
  }

  function applyStyles(shadow) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLES);
      shadow.adoptedStyleSheets = [sheet];
    } catch (err) {
      shadow.append(el('style', { text: STYLES }));
    }
  }

  function build() {
    const host = el('div', { id: 'wls-shuffle-root' });
    const shadow = host.attachShadow({ mode: 'open' });
    applyStyles(shadow);

    const fabLabel = el('span');
    const fab = el('button', {
      type: 'button',
      class: 'fab',
      'aria-controls': 'wls-panel',
      title: 'Watch Later Shuffle extension: permanently changes the order of this playlist on YouTube',
      click: () => setOpen(!isOpen)
    }, [icon(REORDER_ICON), fabLabel]);

    const close = el('button', {
      type: 'button',
      class: 'icon-btn',
      'aria-label': 'Close',
      title: 'Close',
      click: () => setOpen(false)
    }, [icon(CLOSE_ICON)]);

    const explain = el('p', {
      class: 'explain',
      text: 'Puts the videos in a new random order and saves it to the playlist on YouTube, so it '
        + 'shows on all your devices. This is not shuffle play: nothing starts playing.'
    });
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

    const shuffle = button('Shuffle order...', 'primary', () => handlers.onShuffle?.());
    const resume = button('Resume', 'primary', () => handlers.onResume?.());
    const retry = button('Retry', 'primary', () => handlers.onResume?.());
    const reload = button('Reload page', '', () => handlers.onReload?.());
    const stop = button('Stop', '', () => handlers.onStop?.());
    const actions = el('div', { class: 'row' }, [shuffle, resume, retry, reload, stop]);

    const backupList = el('ul');
    const backupEmpty = el('p', { class: 'empty muted', text: 'None yet.' });
    const backups = el('section', { class: 'backups' }, [
      el('h3', { text: 'Backups' }),
      el('p', {
        class: 'muted small',
        text: 'Saved automatically before each shuffle. Restoring puts the videos back in that order.'
      }),
      backupEmpty,
      backupList
    ]);

    const panel = el('section', {
      id: 'wls-panel',
      class: 'panel',
      role: 'region',
      'aria-label': 'Shuffle playlist order',
      keydown: onKeydown
    }, [
      el('header', {}, [
        el('div', { class: 'titles' }, [
          el('h2', { text: 'Shuffle playlist order' }),
          el('p', { class: 'byline muted small', text: 'Watch Later Shuffle extension, not part of YouTube' })
        ]),
        close
      ]),
      explain,
      targetLine,
      notice,
      busyNote,
      confirmBox,
      status,
      progress,
      actions,
      backups
    ]);

    const wrap = el('div', { class: 'wls' }, [panel, fab]);
    shadow.append(wrap);
    return {
      host,
      wrap,
      fab,
      fabLabel,
      panel,
      explain,
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
      shuffle,
      resume,
      retry,
      reload,
      stop,
      backups,
      backupList,
      backupEmpty
    };
  }

  function setOpen(open) {
    isOpen = open;
    renderNow();
    if (!open) ui.fab.focus();
  }

  function answer(value) {
    pending?.resolve(value);
  }

  function onKeydown(event) {
    if (event.key !== 'Escape') return;
    if (pending) answer(false);
    else setOpen(false);
  }

  function fabText() {
    if (pending) return 'Waiting for you to confirm';
    switch (state.phase) {
      case 'reading': return 'Reading playlist...';
      case 'running': return `Moving ${state.done} / ${state.total}`;
      case 'verifying': return 'Checking the new order...';
      case 'paused': return 'Paused';
      default:
        if (state.busyElsewhere) return 'Busy in another tab';
        if (state.interrupted) return state.interrupted.title;
        return 'Shuffle playlist order';
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

    // Put the panel back if the page ever removes it.
    if (!ui.host.isConnected && document.body) document.body.append(ui.host);
    ui.host.style.display = state.visible || confirming ? '' : 'none';
    ui.wrap.dataset.theme = document.documentElement.hasAttribute('dark') ? 'dark' : 'light';
    ui.fabLabel.textContent = fabText();
    ui.fab.setAttribute('aria-expanded', String(isOpen));
    ui.panel.hidden = !isOpen;

    ui.target.textContent = state.playlistLabel ?? '';
    ui.targetLine.hidden = !state.playlistLabel;

    // The question repeats the explanation, so show only one of them.
    ui.explain.hidden = confirming;
    ui.confirmBox.hidden = !confirming;
    if (confirming) renderConfirm();

    ui.status.textContent = state.status ?? '';
    ui.status.className = `status ${state.statusKind ?? 'info'}`;
    ui.status.hidden = confirming || !state.status;
    renderProgress(!confirming && (WORKING.has(phase) || phase === 'paused') && state.total > 0);

    const idle = !active;
    const notice = idle ? state.interrupted : null;
    ui.notice.hidden = !notice;
    if (notice) {
      ui.noticeTitle.textContent = notice.title;
      ui.noticeMessage.textContent = notice.message;
    }
    ui.busyNote.hidden = !(idle && state.busyElsewhere);
    ui.shuffle.disabled = Boolean(state.busyElsewhere);
    ui.shuffle.hidden = !idle;
    ui.resume.hidden = confirming || phase !== 'paused';
    ui.retry.hidden = !idle || !state.canRetry;
    ui.reload.hidden = !idle || (phase !== 'done' && phase !== 'partial');
    ui.stop.hidden = confirming || !(WORKING.has(phase) || phase === 'paused');
    ui.actions.hidden = [ui.shuffle, ui.resume, ui.retry, ui.reload, ui.stop].every((b) => b.hidden);
    ui.backups.hidden = !idle;
    if (idle) renderBackups();
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
      ui.confirmNo.focus();
    });
  }

  function mount(nextHandlers) {
    handlers = nextHandlers;
    if (ui || !document.body) return;
    ui = build();
    document.body.append(ui.host);
    new MutationObserver(renderNow).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['dark']
    });
    renderNow();
  }

  ns.ui = { mount, render, confirm };
})(globalThis);
