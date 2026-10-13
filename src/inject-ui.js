// Page-side half of the injector. Evaluated once inside Antigravity's renderer.
//
// It is deliberately kept OUT of React's managed subtree: the host lives on
// <body> and is positioned over the composer footer with position:fixed. Adding
// children to the app's own nodes would fight React's reconciliation and can
// throw "node to be removed is not a child of this node".
(function () {
  // Bump when this file changes. The host checks it, so a stale build left in
  // the page by an earlier run gets replaced instead of silently kept.
  const VERSION = 'agcm-8';
  if (window.__agcm && window.__agcm.version === VERSION) return;

  const HOST_ID = 'agcm-inline-host';
  const ANCHOR = '[data-testid="permissions-selector-trigger"]';
  const GAP = 8;

  const css = `
    #${HOST_ID} {
      /* Must sit above the app's normal content (z-index 10) but BELOW its
         overlays: the modal backdrop is z-[5000] and toasts are z-[7000]. A
         huge value here (was 2147483000) left the chip undimmed on top of the
         settings dialog's backdrop, looking like it floated outside the modal. */
      position: fixed; z-index: 100;
      display: flex; align-items: center;
      font-family: "Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif;
      font-size: 11px; line-height: 1; color: #3f444b;
      pointer-events: auto;
    }
    #${HOST_ID} .chip {
      display: flex; align-items: center; gap: 6px;
      height: 22px; padding: 0 9px 0 8px;
      border: 1px solid #e3e6ea; border-radius: 999px;
      background: #ffffff; cursor: default;
      font-variant-numeric: tabular-nums; white-space: nowrap;
      transition: border-color .15s, background .15s, opacity .15s ease;
    }
    /* Encouragement: the numbers step aside for a sentence, then come back.
       The host is right-anchored, so the pill just grows leftwards. */
    #${HOST_ID} .msg { display: none; color: #3f444b; }
    #${HOST_ID} .chip.showing-msg .track,
    #${HOST_ID} .chip.showing-msg .txt,
    #${HOST_ID} .chip.showing-msg .pct { display: none; }
    #${HOST_ID} .chip.showing-msg .msg { display: inline; }
    @media (prefers-reduced-motion: reduce) {
      #${HOST_ID} .chip { transition: none; }
    }
    #${HOST_ID}:hover .chip { border-color: #cfd4da; background: #fbfcfd; }
    /* The injector pushes only on change, so a beat marks "still alive". Without
       this a dead injector left the last numbers frozen and looking current. */
    #${HOST_ID}.stale .chip { opacity: .4; }
    #${HOST_ID}.stale .track { opacity: .5; }
    #${HOST_ID} .track {
      position: relative; width: 30px; height: 4px;
      border-radius: 2px; background: #e8eaee; overflow: hidden; flex: none;
    }
    #${HOST_ID} .fill {
      position: absolute; inset: 0 auto 0 0; border-radius: 2px;
      transition: width .35s ease, background .35s ease;
    }
    #${HOST_ID} .txt { color: #3f444b; }
    #${HOST_ID} .pct { color: #8b929c; }

    #${HOST_ID} .tip {
      position: absolute; bottom: calc(100% + 6px); right: 0;
      min-width: 232px; padding: 8px 10px 7px;
      border: 1px solid #e3e6ea; border-radius: 10px;
      background: #fff; box-shadow: 0 6px 22px rgba(15,20,28,.13);
      display: none; flex-direction: column; gap: 1px;
    }
    #${HOST_ID}:hover .tip { display: flex; }
    #${HOST_ID} .tip-head {
      display: flex; justify-content: space-between; gap: 10px;
      padding-bottom: 5px; margin-bottom: 4px;
      border-bottom: 1px solid #eef0f3; color: #6b7280;
    }
    #${HOST_ID} .row { display: flex; align-items: center; gap: 7px; height: 18px; }
    #${HOST_ID} .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
    #${HOST_ID} .dot.hollow { background: none; box-shadow: inset 0 0 0 1.5px #b6bcc5; }
    #${HOST_ID} .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #${HOST_ID} .val { font-variant-numeric: tabular-nums; color: #3f444b; }
    #${HOST_ID} .shr { font-variant-numeric: tabular-nums; color: #8b929c; min-width: 40px; text-align: right; }
  `;

  function fmt(n) {
    if (n == null) return '—';
    if (n >= 1e6) { const v = n / 1e6; return (v >= 10 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')) + 'M'; }
    if (n >= 1e3) { const v = n / 1e3; return (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')) + 'k'; }
    return String(n);
  }

  let host = null;
  let tip = null;
  let timer = null;
  let latest = null;
  let hidden = false;
  let lastBeatAt = Date.now();
  let stale = false;
  let msgUntil = 0;

  const STALE_MS = 6000;
  const HOLD_MS = 3500;

  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Swaps the pill between numbers and a sentence behind a short opacity dip, so
  // it reads as a morph rather than a flicker. The text is written with
  // textContent - it arrives from a model, which is untrusted input.
  function swapTo(showing, text) {
    if (!host) return;
    const chip = host.querySelector('.chip');
    const msg = host.querySelector('.msg');
    if (!chip || !msg) return;

    const apply = () => {
      if (text !== undefined) msg.textContent = text;
      chip.classList.toggle('showing-msg', showing);
    };

    if (reducedMotion) {
      apply();
      return;
    }
    chip.style.opacity = '0';
    setTimeout(() => {
      apply();
      chip.style.opacity = '1';
    }, 150);
  }

  function touch() {
    lastBeatAt = Date.now();
    if (stale && host) {
      stale = false;
      host.classList.remove('stale');
    }
  }

  function ensure() {
    if (host && host.isConnected) return host;
    // Drop anything a previous build left behind, so two hosts never coexist.
    for (const stale of document.querySelectorAll('#' + HOST_ID)) stale.remove();
    host = document.createElement('div');
    host.id = HOST_ID;
    host.innerHTML = '<div class="chip"><span class="track"><span class="fill"></span></span><span class="txt"></span><span class="pct"></span><span class="msg"></span></div><div class="tip"></div>';
    const style = document.createElement('style');
    style.textContent = css;
    host.appendChild(style);
    tip = host.querySelector('.tip');
    document.body.appendChild(host);
    return host;
  }

  function place() {
    const anchor = document.querySelector(ANCHOR);
    if (!anchor || !host) return false;
    const r = anchor.getBoundingClientRect();
    if (!r.width) return false;
    host.style.top = Math.round(r.top + r.height / 2) + 'px';
    host.style.transform = 'translateY(-50%)';
    // Right-aligned against the Turbo control, inside the free space left of it.
    host.style.right = Math.round(window.innerWidth - r.left + GAP) + 'px';
    host.style.left = 'auto';
    host.style.display = 'flex';
    return true;
  }

  function levelColor(pct) {
    if (pct >= 95) return '#d64545';
    if (pct >= 85) return '#d99100';
    return '#4f7cff';
  }

  function paint() {
    if (!host || !latest) return;
    const pct = latest.percent;
    const col = levelColor(pct == null ? 0 : pct);
    const fill = host.querySelector('.fill');
    fill.style.width = Math.max(2, Math.min(100, pct == null ? 0 : pct)) + '%';
    fill.style.background = col;
    host.querySelector('.txt').textContent = fmt(latest.total) + ' / ' + fmt(latest.limit);
    const pctEl = host.querySelector('.pct');
    pctEl.textContent = pct == null ? '' : pct.toFixed(1) + '%';
    pctEl.style.color = pct == null ? '#8b929c' : col;

    // Built with DOM calls, never innerHTML: the conversation title is data from
    // the app, and interpolating it as markup let a title containing HTML render
    // as HTML (or worse) inside Antigravity's own renderer.
    tip.textContent = '';

    const head = document.createElement('div');
    head.className = 'tip-head';
    const titleEl = document.createElement('span');
    titleEl.textContent = (latest.title || 'Context window').slice(0, 40);
    const modelEl = document.createElement('span');
    modelEl.textContent = latest.model || '';
    head.append(titleEl, modelEl);
    tip.append(head);

    const addRow = (color, label, value, share, muted) => {
      const row = document.createElement('div');
      row.className = 'row';
      const dot = document.createElement('span');
      dot.className = muted ? 'dot hollow' : 'dot';
      if (!muted) dot.style.background = color;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = label;
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = value;
      const shr = document.createElement('span');
      shr.className = 'shr';
      shr.textContent = share;
      if (color === '#d64545') {
        name.style.color = color;
        val.style.color = color;
        shr.style.color = color;
      }
      row.append(dot, name, val, shr);
      tip.append(row);
    };

    for (const c of latest.categories || []) {
      addRow(c.color, c.label, fmt(c.tokens), c.percent.toFixed(1) + '%', false);
    }
    if (latest.overBy > 0) {
      addRow('#d64545', 'Over limit', '+' + fmt(latest.overBy), 'awaiting compaction', false);
    } else if (latest.freeSpace != null) {
      addRow(null, 'Free space', fmt(latest.freeSpace),
        latest.limit ? (latest.freeSpace / latest.limit * 100).toFixed(1) + '%' : '', true);
    }
  }

  // Replacing a previous build: drop its timer and its element first.
  if (window.__agcm && typeof window.__agcm.remove === 'function') {
    try {
      window.__agcm.remove();
    } catch {
      /* old build may be half-torn-down already */
    }
  }

  window.__agcm = {
    version: VERSION,
    set(payload) {
      latest = payload;
      hidden = false;
      touch();
      ensure();
      if (place()) paint();
      return true;
    },
    // Liveness only. Sent when nothing changed, so a frozen panel can show that
    // it is frozen instead of looking like current data.
    beat() {
      touch();
      return true;
    },
    // Encouragement, on its own channel: the numbers keep flowing underneath and
    // come back when the sentence has had its few seconds.
    say(phrase) {
      const text = phrase && phrase.text;
      if (!text) return false;
      ensure();
      touch();
      msgUntil = Date.now() + HOLD_MS;
      swapTo(true, String(text).slice(0, 60));
      return true;
    },
    // Called by the injector on its own clock. The page cannot be trusted to time
    // this: Chromium throttles timers in hidden pages (once a second, and once a
    // minute after five minutes hidden), so a sentence could otherwise sit on top
    // of the numbers far longer than intended. The 400ms interval below still
    // checks as a backstop, for the case where the injector dies mid-sentence.
    sayEnd() {
      if (!msgUntil) return false;
      msgUntil = 0;
      swapTo(false, '');
      return true;
    },
    // Shown when there is no conversation to report on (e.g. the new-conversation
    // screen) — better to show nothing than another conversation's numbers.
    hide() {
      hidden = true;
      if (host) host.style.display = 'none';
      return true;
    },
    remove() {
      if (timer) clearInterval(timer);
      timer = null;
      if (host) host.remove();
      host = null;
      latest = null;
    },
    // Diagnostics: `window.__agcm.__debug()` from DevTools. Worth keeping - the
    // panel has several early-return guards, and without this there is no way to
    // tell which one a silent no-op is stuck behind.
    __debug() {
      return {
        version: VERSION,
        hasPayload: !!latest,
        hidden,
        msgUntil,
        stale,
        timerActive: timer !== null,
        hostConnected: !!(host && host.isConnected),
      };
    },
  };

  // React re-renders do not remove us (we are outside its tree), but the composer
  // can be unmounted — e.g. on a page with no input box — so keep checking.
  timer = setInterval(() => {
    if (!latest || hidden) return;

    if (!stale && Date.now() - lastBeatAt > STALE_MS) {
      stale = true;
      if (host) host.classList.add('stale');
    }

    // The hold is checked here rather than on its own timer, so there is only
    // ever one interval running in the page.
    if (msgUntil && Date.now() > msgUntil) {
      msgUntil = 0;
      swapTo(false, '');
    }

    if (!document.querySelector(ANCHOR)) {
      if (host) host.style.display = 'none';
      return;
    }
    ensure();
    place();
  }, 400);

  return true;
})();
