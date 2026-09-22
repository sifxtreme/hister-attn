#!/usr/bin/env node
// hister-attn — the counter behind the Hister attention fork.
//
// hister itself stores ONE document per URL and keeps no view count, no visit
// count, no dwell time (schema confirmed 2026-09-22). This service is the piece
// that adds them. The forked Chrome extension is the only writer; it POSTs:
//   POST /open  {url,title?}      one browser-visit of a page (server dedupes by cooldown)
//   POST /beat  {url,title?,ms}   a chunk of ACTIVE attention (focused window, not idle)
// and reads come back via:
//   GET  /stats?by=domain|url&metric=active|opens&days=N&limit=K
//   GET  /            health + totals
//
// Loopback only. Its DB lives in ~/hister-attn (a DEDICATED path, NOT a synced
// dir — same rule as ~/hister; a Syncthing-replicated DB means lost writes).
// Nothing here can recover history: counts start at zero on the day it goes live.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const PORT        = Number(process.env.HISTER_ATTN_PORT || 4434);
const HOST        = '127.0.0.1';
const DATA_DIR    = process.env.HISTER_ATTN_DIR || path.join(os.homedir(), 'hister-attn');
const OPEN_COOLDOWN_MS = 30 * 60 * 1000;   // same URL within 30 min = the same "open"
const MAX_BEAT_MS      = 30 * 60 * 1000;   // ignore an implausibly long single beat (SW/laptop slept)
const MAX_BODY         = 64 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'attn.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS pages (
    url        TEXT PRIMARY KEY,
    domain     TEXT,
    title      TEXT,
    opens      INTEGER NOT NULL DEFAULT 0,
    active_ms  INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER,
    last_open  INTEGER,
    last_seen  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pages_domain ON pages(domain);
  CREATE INDEX IF NOT EXISTS idx_pages_last_seen ON pages(last_seen);
`);

const upsert = db.prepare(`
  INSERT INTO pages (url, domain, title, first_seen, last_seen)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(url) DO UPDATE SET
    title     = COALESCE(excluded.title, pages.title),
    last_seen = excluded.last_seen`);
const getRow   = db.prepare(`SELECT url, opens, active_ms, last_open FROM pages WHERE url = ?`);
const bumpOpen = db.prepare(`UPDATE pages SET opens = opens + 1, last_open = ? WHERE url = ?`);
const addMs    = db.prepare(`UPDATE pages SET active_ms = active_ms + ?, last_seen = ? WHERE url = ?`);

const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '?'; } };
const normUrl  = (u) => {
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null; // reject chrome://, about:, file://…
    x.hash = '';
    return x.href;
  } catch { return null; }
};

function ensure(url, title, now) {
  upsert.run(url, domainOf(url), title || null, now, now);
}

// POST /open — one visit. Cooldown dedupe so the extension can fire liberally.
function onOpen({ url, title }) {
  const u = normUrl(url); if (!u) return { ok: false, reason: 'bad url' };
  const now = Date.now();
  ensure(u, title, now);
  const row = getRow.get(u);
  if (!row.last_open || now - row.last_open >= OPEN_COOLDOWN_MS) {
    bumpOpen.run(now, u);
    return { ok: true, counted: true, opens: row.opens + 1 };
  }
  return { ok: true, counted: false, opens: row.opens }; // within cooldown → same open
}

// POST /beat — a chunk of active attention time.
function onBeat({ url, title, ms }) {
  const u = normUrl(url); if (!u) return { ok: false, reason: 'bad url' };
  const add = Math.round(Number(ms) || 0);
  if (add <= 0 || add > MAX_BEAT_MS) return { ok: true, counted: false }; // clamp junk
  const now = Date.now();
  ensure(u, title, now);
  addMs.run(add, now, u);
  return { ok: true, counted: true };
}

function stats(q) {
  const by     = q.get('by') === 'url' ? 'url' : 'domain';
  const metric = q.get('metric') === 'opens' ? 'opens' : 'active';
  const limit  = Math.min(Math.max(Number(q.get('limit')) || 10, 1), 200);
  const days   = Number(q.get('days')) || 0;
  const since  = days > 0 ? Date.now() - days * 86400_000 : 0;
  const order  = metric === 'opens' ? 'op' : 'am';
  const where  = since ? `WHERE last_seen >= ${since}` : '';
  const sql = by === 'domain'
    ? `SELECT domain AS key, SUM(active_ms) am, SUM(opens) op, COUNT(*) pages,
              MAX(last_seen) last_seen FROM pages ${where}
       GROUP BY domain ORDER BY ${order} DESC LIMIT ${limit}`
    : `SELECT url AS key, title, active_ms am, opens op, last_seen
       FROM pages ${where} ORDER BY ${order} DESC LIMIT ${limit}`;
  const rows = db.prepare(sql).all().map(r => ({
    ...r,
    active_minutes: Math.round((r.am || 0) / 60000),
  }));
  return { by, metric, days, rows };
}

function totals() {
  const t = db.prepare(`SELECT COUNT(*) pages, COALESCE(SUM(opens),0) opens,
                        COALESCE(SUM(active_ms),0) active_ms FROM pages`).get();
  return {
    ok: true, service: 'hister-attn', port: PORT,
    pages: t.pages, opens: t.opens,
    active_hours: +(t.active_ms / 3600000).toFixed(2),
  };
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/')      return send(res, 200, totals());
  if (req.method === 'GET' && url.pathname === '/stats') return send(res, 200, stats(url.searchParams));

  if (req.method === 'POST' && (url.pathname === '/open' || url.pathname === '/beat')) {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > MAX_BODY) req.destroy(); });
    req.on('end', () => {
      let body; try { body = JSON.parse(buf || '{}'); } catch { return send(res, 200, { ok: false, reason: 'bad json' }); }
      try {
        const out = url.pathname === '/open' ? onOpen(body) : onBeat(body);
        send(res, 200, out);
      } catch (e) {
        // fail-open: never surface an error the extension might retry-storm on
        send(res, 200, { ok: false, reason: String(e && e.message || e) });
      }
    });
    return;
  }
  send(res, 404, { ok: false, reason: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`hister-attn listening on http://${HOST}:${PORT}  db=${path.join(DATA_DIR, 'attn.db')}`);
});
