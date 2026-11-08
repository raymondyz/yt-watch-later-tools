// How thumbnails show Watch later: the mark on a video that is saved, and the
// button that saves or removes one, shown on hover. This file is the only
// place that decides their look: change an icon, color, size or corner here,
// and every thumbnail on YouTube follows. badges.js and quicksave.js only
// decide where they appear, and add or remove what this file makes.
(function (root) {
  const ns = root.__wlTools;
  const { el, icon, createSheet, adoptStyles } = ns.ui.kit;

  const BRAND = 'Watch Later Tools';
  const PURPLE = '#5b3df5';
  const DARK = 'rgba(0, 0, 0, 0.6)';
  const RED = '#c5221f';

  // Material icons: "schedule" (a clock, like YouTube's own Watch later
  // icon), "more_time", "close", "check" and "error_outline".
  const ICONS = Object.freeze({
    saved: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 '
      + '0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
    save: 'M10 8v6l4.7 2.9.8-1.2-4-2.4V8zM17.92 12c.05.33.08.66.08 1 0 3.9-3.1 7-7 7s-7-3.1-7-7 3.1-7 7-7c.7 0 '
      + '1.37.1 2 .29V4.23c-.64-.15-1.31-.23-2-.23-5 0-9 4-9 9s4 9 9 9 9-4 9-9c0-.34-.02-.67-.06-1h-2.02zM20 '
      + '5V2h-2v3h-3v2h3v3h2V7h3V5z',
    remove: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    done: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    failed: 'M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 '
      + '2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z'
  });

  // Each one's host element is an invisible strip across the top of the
  // thumbnail. YouTube's own styles can reach that element but not what is
  // inside it, so everything about the look is set inside, where percentages
  // are of the thumbnail's width.
  const HOST = `
    all: initial;
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 0;
    pointer-events: none;
  `;

  // Where the mark and the button sit, and how big they are: over the
  // thumbnail's top left corner, at the size of YouTube's own buttons on a
  // playing preview (mute, captions): a 40 px circle 8 px in from the corner,
  // with a 24 px icon. On small thumbnails, such as the recommendations beside
  // a video, they are 24 px, 6 px in, and in between they scale. Both use
  // this, so a button exactly covers the mark under it.
  const CORNER = `
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    margin: clamp(6px, calc(2.5% + 0.5px), 8px) 0 0 clamp(6px, calc(2.5% + 0.5px), 8px);
    width: clamp(24px, calc(20% - 20px), 40px);
    aspect-ratio: 1;
    border-radius: 50%;
    color: #ffffff;
  `;

  // The mark: a purple circle with a clock. It lets the pointer through, so
  // clicks and hover previews work as if it weren't there. Its colors stay the
  // same in both themes, because they sit on a picture.
  const MARK_STYLES = `
    :host { ${HOST} z-index: 2; }
    .mark { ${CORNER} background: ${PURPLE}; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4); }
    svg { width: 60%; height: 60%; fill: currentColor; }
  `;

  // The button. For a video that isn't saved, it is a dark see-through circle
  // like YouTube's own hover buttons, turning purple under the pointer. For a
  // saved one, it looks exactly like the mark it covers, and shows a cross
  // under the pointer, since a click then removes the video.
  const BUTTON_STYLES = `
    :host { ${HOST} z-index: 3; }
    button { ${CORNER} padding: 0; border: 0; background: ${DARK}; cursor: pointer; pointer-events: auto; }
    svg { width: 60%; height: 60%; fill: currentColor; }
    button:focus-visible { outline: 2px solid #ffffff; outline-offset: 2px; }
    button[data-state='save']:hover, button[data-state='done'] { background: ${PURPLE}; }
    button[data-state='remove'] { background: ${PURPLE}; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4); }
    button[data-state='remove']:hover { background: ${DARK}; }
    button[data-state='busy'] { cursor: progress; opacity: 0.7; }
    button[data-state='failed'] { background: ${RED}; }
    .on-hover { display: none; }
    button:hover .on-hover { display: block; }
    button:hover .off-hover:not(:only-child) { display: none; }
  `;

  // Per state: the icon, the icon under the pointer if it changes, and what
  // the button says in its tooltip and to screen readers.
  const BUTTON_STATES = Object.freeze({
    save: { icon: ICONS.save, label: () => 'Save to Watch later' },
    remove: { icon: ICONS.saved, hover: ICONS.remove, label: () => 'Remove from Watch later' },
    busy: { icon: ICONS.saved, label: () => 'Working...' },
    done: { icon: ICONS.done, label: () => 'Saved to Watch later' },
    failed: { icon: ICONS.failed, label: (message) => message }
  });

  // Events from the button stop at it, so the thumbnail's link and YouTube's
  // own handlers never see a press meant for the button.
  const CONTAINED_EVENTS = Object.freeze([
    'click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'
  ]);

  const sheets = new Map();

  function shadowHost(className, styles, attrs = {}) {
    if (!sheets.has(styles)) sheets.set(styles, createSheet(styles));
    const host = el('div', { class: className, ...attrs });
    const shadow = host.attachShadow({ mode: 'open' });
    adoptStyles(shadow, sheets.get(styles), styles);
    return { host, shadow };
  }

  // A new mark, ready to be added to a thumbnail.
  function createMark() {
    const { host, shadow } = shadowHost('wlt-saved-mark', MARK_STYLES, {
      role: 'img',
      'aria-label': `In your Watch later (${BRAND})`
    });
    shadow.append(el('div', { class: 'mark' }, [icon(ICONS.saved)]));
    return host;
  }

  // A new button. `onPress` runs when it is clicked; show(state, message)
  // switches it between 'save', 'remove', 'busy', 'done' and 'failed'.
  function createSaveButton(onPress) {
    const { host, shadow } = shadowHost('wlt-save-button', BUTTON_STYLES);
    const button = el('button', { type: 'button' });
    shadow.append(button);
    for (const type of CONTAINED_EVENTS) {
      host.addEventListener(type, (event) => {
        event.stopPropagation();
        if (type === 'click' || type === 'auxclick') event.preventDefault();
      });
    }
    button.addEventListener('click', () => onPress());
    function show(state, message = '') {
      if (button.dataset.state === state && button.dataset.message === message) return;
      const look = BUTTON_STATES[state];
      const label = `${look.label(message)} (${BRAND})`;
      button.dataset.state = state;
      button.dataset.message = message;
      button.disabled = state === 'busy';
      button.setAttribute('aria-label', label);
      button.title = label;
      const icons = [icon(look.icon, 'off-hover')];
      if (look.hover) icons.push(icon(look.hover, 'on-hover'));
      button.replaceChildren(...icons);
    }
    show('save');
    return { host, show };
  }

  ns.indicator = { createMark, createSaveButton };
})(globalThis);
