// Patch a copy of Hister's manifest.json into the attention fork.
// Adds the two permissions the attention module needs, marks the fork, and
// removes update_url so Chrome never silently replaces our unpacked build with
// the Web Store version. The `key` is kept on purpose: it preserves the
// extension ID, so the fork inherits the existing Hister config (server URL,
// token, cookies) that live under that ID's storage.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: patch-manifest.mjs <manifest.json>'); process.exit(1); }

const m = JSON.parse(readFileSync(file, 'utf8'));
m.name = 'Hister (attention)';
m.description = (m.description || '') + ' — active-attention + open-count fork';
m.permissions = Array.from(new Set([...(m.permissions || []), 'idle', 'alarms']));
delete m.update_url;

writeFileSync(file, JSON.stringify(m, null, 3) + '\n');
console.log('patched manifest:', m.name, '| permissions:', m.permissions.join(', '));
