
/* ===================================================================== *
 *  hister-attn fork — active-attention + open-count                     *
 *  Appended to Hister's service worker by apply-fork.sh. Does NOT touch  *
 *  hister's own capture logic above; it runs alongside it.              *
 *                                                                        *
 *  "Active attention" = a Chrome window is focused AND you are not idle  *
 *  AND this is the active tab. A background tab is, by construction,     *
 *  never the active tab of a focused window, so it accrues ZERO time.    *
 *                                                                        *
 *  Event-driven (no ticking timer) so it survives MV3 service-worker     *
 *  sleep: every focus/tab/idle change settles the elapsed span; a 1-min  *
 *  alarm flushes progress during a long uninterrupted read. State is     *
 *  mirrored to session storage so a woken SW resumes without double-     *
 *  counting the time it was asleep.                                      *
 * ===================================================================== */
(() => {
  const COUNTER   = 'http://127.0.0.1:4434';
  const IDLE_SECS = 120;   // no keyboard/mouse for this long → "walked away", stop counting
  const ALARM     = 'histerAttnFlush';
  const MAX_SPAN  = 30 * 60 * 1000; // never attribute a single span longer than this (SW/laptop slept)

  let cur = null;           // { url, title, since }  — the page currently being attended
  let winFocused = true;    // is any Chrome window focused?
  let idleState = 'active'; // 'active' | 'idle' | 'locked'

  const attendable = (u) => !!u && /^https?:/.test(u);
  const norm = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return null; } };

  async function post(pathname, body) {
    try {
      await fetch(COUNTER + pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch { /* fail-open: the counter being down must never affect browsing or capture */ }
  }

  async function save() { try { await chrome.storage.session.set({ _attnCur: cur }); } catch {} }

  // Flush the time accrued on the currently-attended page and reset its clock.
  async function settle(now) {
    if (cur && cur.since) {
      const ms = now - cur.since;
      cur.since = now;
      if (ms > 0 && ms < MAX_SPAN) await post('/beat', { url: cur.url, title: cur.title, ms });
    }
  }

  // Decide what is being actively attended right now and reconcile with `cur`.
  async function recompute() {
    const now = Date.now();
    let want = null;
    if (winFocused && idleState === 'active') {
      try {
        const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (t && attendable(t.url)) want = { url: norm(t.url), title: t.title || '' };
      } catch {}
    }
    const same = (cur && cur.url) === (want && want.url);
    if (same) {                 // still the same page → just advance its clock
      if (cur) { if (want) cur.title = want.title; await settle(now); }
      await save();
      return;
    }
    await settle(now);          // attention moved → bank the old page's time
    cur = want ? { url: want.url, title: want.title, since: now } : null;
    if (want) await post('/open', { url: want.url, title: want.title }); // server applies the cooldown
    await save();
  }

  chrome.idle.setDetectionInterval(IDLE_SECS);
  chrome.tabs.onActivated.addListener(() => recompute());
  chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.status === 'complete') recompute(); });
  chrome.windows.onFocusChanged.addListener((w) => { winFocused = w !== chrome.windows.WINDOW_ID_NONE; recompute(); });
  chrome.idle.onStateChanged.addListener((s) => { idleState = s; recompute(); });
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) recompute(); });

  // Service worker (re)start: rehydrate, but do NOT count the gap while it slept.
  (async () => {
    try { const r = await chrome.storage.session.get('_attnCur'); cur = r._attnCur || null; } catch {}
    if (cur) cur.since = Date.now();
    try { winFocused = (await chrome.windows.getLastFocused()).focused; } catch {}
    try { idleState = await chrome.idle.queryState(IDLE_SECS); } catch {}
    recompute();
  })();
})();
