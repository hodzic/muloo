// Bump the app version: YYYY-MM-DD (US Pacific) plus a letter that counts releases that day (a, b, c…).
// Writes APP_VERSION in js/settings-ui.js and the cache name in sw.js. Usage: npm run bump
import fs from 'node:fs';
const root = new URL('..', import.meta.url), ui = new URL('js/settings-ui.js', root), sw = new URL('sw.js', root);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date()); // 2026-10-27
const cur = fs.readFileSync(sw, 'utf8').match(/muloo-(\d{4}-\d\d-\d\d)([a-z])/);
const next = today + (cur && cur[1] === today ? String.fromCharCode(cur[2].charCodeAt(0) + 1) : 'a');
fs.writeFileSync(ui, fs.readFileSync(ui, 'utf8').replace(/export const APP_VERSION = '[^']*'/, `export const APP_VERSION = '${next}'`));
fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace(/const CACHE = '[^']*'/, `const CACHE = 'muloo-${next}'`));
console.log(next);
