# hister-attn

**View count + active-attention time for [Hister](https://github.com/asciimoo/hister), the private personal web index.**

Hister stores **one document per URL** and keeps **no view count, no visit count, and
no dwell time** — a page you opened 100 times and one you opened once are indistinguishable
in its index. `hister-attn` adds the two metrics Hister throws away:

| Metric | Meaning |
|---|---|
| **opens** | how many times you pulled a page up (deduped: reopening the same URL within 30 min is one open) |
| **active_ms** | time the page spent as the **active tab of a focused browser window while you were not idle** |

A **background tab accrues zero time** — it is never the active tab of a focused window, so the
"active attention, not background" rule holds by construction. Walking away is handled by
`chrome.idle` (default: 120 s of no keyboard/mouse → the clock pauses).

> ⚠️ **No history.** Hister never recorded repeats, so nothing here can reconstruct the past.
> Counts start at **zero on install** and only grow forward.

## Not a fork of Hister's code

This is an **additive add-on**, not a hard fork of Hister's source:

- The **counter** (`service/`) is original code you can license freely.
- `extension/attention.append.js` is a small module that is **appended** to a *local copy* of
  the Hister browser extension by `apply-fork.sh`. Hister's own capture code is never edited.
- The built extension (`extension/build/`) is **git-ignored** — this repo distributes **none of
  Hister's code**. You build it locally against your own installed copy.

Because it plugs into an AGPLv3 app, this project is licensed **AGPL-3.0-or-later** to match.

## How it works

```
Forked Hister extension  ──POST /open, /beat──▶  hister-attn service  ──▶  ~/hister-attn/attn.db
(background service worker,                       (127.0.0.1:4434, Node,        (SQLite; a DEDICATED
 event-driven, fail-open)                          node:sqlite, zero deps)       non-synced path)
```

- **Active-attention is background-only and event-driven** (no ticking timer), so it survives
  MV3 service-worker sleep. `tabs.onActivated` / `windows.onFocusChanged` / `idle.onStateChanged`
  each *settle* the elapsed span; a 1-minute alarm flushes progress during a long read; a woken
  service worker does **not** count the gap while it was asleep.
- **Fail-open everywhere.** If the counter is down, the extension's `fetch` throws and is
  swallowed — browsing and Hister's own capture are never blocked.
- **The DB lives outside any synced folder.** A Syncthing/Dropbox-replicated SQLite file means
  lost writes; keep `~/hister-attn` local (the same rule Hister follows with `~/hister`).

## Install (macOS)

Requires Node **≥ 22.5** (for the built-in `node:sqlite`) and the Hister extension installed
in Chrome.

```bash
./install.sh          # generates + loads the LaunchAgent, then builds the extension fork
```

Then load the fork in Chrome — the one manual step (Chrome can't script "Load unpacked"):

1. Open `chrome://extensions`
2. Enable **Developer mode**, and **disable the Web-Store "Hister"** (running both = double-capture)
3. **Load unpacked** → select `extension/build`

The fork keeps Hister's extension ID, so your existing Hister config (server URL, token) carries over.

## Query

```bash
curl -s 127.0.0.1:4434/                                    # health + totals
curl -s '127.0.0.1:4434/stats?by=domain&metric=active'     # top domains by attention minutes
curl -s '127.0.0.1:4434/stats?by=domain&metric=opens'      # top domains by opens
curl -s '127.0.0.1:4434/stats?by=url&metric=active&limit=10&days=3'
```

Rows carry `key, am (active_ms), op (opens), active_minutes, last_seen` (+`pages` for `by=domain`).

## Write API (extension → service)

- `POST /open {url, title?}` — one visit; the server applies the 30-minute cooldown.
- `POST /beat {url, title?, ms}` — a chunk of active ms; clamped to `(0, 30 min]`.
- Non-`http(s)` URLs (`chrome://`, `about:`, `file://`) are rejected.

## Config

Environment (set on the LaunchAgent): `HISTER_ATTN_PORT` (4434), `HISTER_ATTN_DIR` (`~/hister-attn`).
The idle cutoff (120 s) and alarm cadence live in `extension/attention.append.js`.

## Credits

Built on [Hister](https://github.com/asciimoo/hister) by asciimoo (AGPL-3.0). An
active-attention + open-count capability like this may be worth proposing upstream rather than
maintaining as a separate add-on.
