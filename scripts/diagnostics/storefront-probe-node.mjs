#!/usr/bin/env node
//
// storefront-probe-node.mjs -- prove the smoke-test design against the real store.
//
// WHY: The curl-based probe hits a 429 on content routes because Shopify/Cloudflare
// bot-management flags curl's TLS/HTTP fingerprint. node's fetch (undici) is NOT
// flagged. This script uses node fetch to verify the ONE remaining unknown:
//   with the store password, can we authenticate past /password and get REAL 200
//   content pages while the store is locked?
// If yes, the durable smoke = node fetch + auto-detect + password secret.
//
// SECURITY (public repo): the password is read with hidden input (or STORE_PW env),
// never logged. Only cookie NAMES, statuses, pageType, theme id, <title> and boolean
// markers are logged. The log is scrubbed for the literal password before writing and
// is gitignored.
//
// USAGE:  node scripts/diagnostics/storefront-probe-node.mjs
//         (or)  STORE_PW='...' node scripts/diagnostics/storefront-probe-node.mjs
// Then hand over: scripts/diagnostics/storefront-probe-node.log

import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DOMAIN = process.env.DOMAIN || 'https://sapphireshadowstudio.com';
const MYSHOP = process.env.MYSHOP || 'https://sapphire-shadow-studio.myshopify.com';
const LIVE_THEME_ID = process.env.LIVE_THEME_ID || '181702754604';
const LOG = join(dirname(fileURLToPath(import.meta.url)), 'storefront-probe-node.log');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSER_HEADERS = {
  'user-agent': UA,
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'upgrade-insecure-requests': '1',
};

const out = [];
const log = (...a) => out.push(a.join(' '));

// --- tiny cookie jar over fetch's getSetCookie ---
function updateJar(jar, res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
}
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const jarNames = (jar) => [...jar.keys()].sort().join(', ');

const st = (res, re) => ((res.headers.get('server-timing') || '').match(re) || [''])[0];

async function probe(label, url, { jar, follow = false } = {}) {
  const headers = { ...BROWSER_HEADERS };
  if (jar && jar.size) headers.cookie = cookieHeader(jar);
  let res;
  try {
    res = await fetch(url, { headers, redirect: follow ? 'follow' : 'manual' });
  } catch (e) {
    log(`[node] ${label.padEnd(30)} -> ERR ${e.message}`);
    return null;
  }
  if (jar) updateJar(jar, res);
  const loc = res.headers.get('location');
  const locShort = loc ? loc.replace(/^https:\/\/[^/]+/, '') : '';
  log(`[node] ${label.padEnd(30)} -> ${res.status}` +
      `${follow ? ` final=${res.url.replace(/^https:\/\/[^/]+/, '')}` : (locShort ? ` loc=${locShort}` : '')}` +
      ` ra=${res.headers.get('retry-after') || '-'}` +
      ` ${st(res, /pageType;desc="[^"]+"/)} ${st(res, /theme;desc="\d+"/)}`);
  return res;
}

async function bodyMarkers(label, url, jar) {
  const headers = { ...BROWSER_HEADERS };
  if (jar && jar.size) headers.cookie = cookieHeader(jar);
  let res, text = '';
  try { res = await fetch(url, { headers, redirect: 'follow' }); text = await res.text(); }
  catch (e) { log(`[body] ${label.padEnd(30)} -> ERR ${e.message}`); return ''; }
  const title = (text.match(/<title>([^<]*)<\/title>/i) || [, '<none>'])[1].trim();
  const pw = /name="password"|form_type=storefront_password|storefront-password/i.test(text) ? 'yes' : 'no';
  const sf = /cdn\.shopify\.com|Shopify\.shop|shopify-section|window\.Shopify/i.test(text) ? 'yes' : 'no';
  log(`[body] ${label.padEnd(30)} -> status=${res.status} title="${title}" password_form=${pw} storefront_markers=${sf} bytes=${text.length}`);
  return text;
}

// Hidden password entry. Uses STORE_PW env if present, else raw-mode stdin.
function readSecret(prompt) {
  if (process.env.STORE_PW) return Promise.resolve(process.env.STORE_PW);
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) { resolve(''); return; }
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      const code = ch.charCodeAt(0);
      if (ch === '\n' || ch === '\r' || code === 4) {          // Enter / Ctrl-D
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
        process.stderr.write('\n'); resolve(buf);
      } else if (code === 3) {                                  // Ctrl-C
        process.stderr.write('\n'); process.exit(1);
      } else if (code === 127 || code === 8) {                  // Backspace
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const PATHS = ['/', '/cart', '/collections/all', '/collections', '/search?q=test'];

(async () => {
  const PW = await readSecret('Store password (hidden, blank to skip auth): ');

  log('================================================================');
  log(' storefront-probe-node.log');
  log(` generated: ${new Date().toISOString()}`);
  log(` domain: ${DOMAIN}   live_theme_id: ${LIVE_THEME_ID}`);
  log(` node: ${process.version}`);
  log(' note: passwords + cookie values are never logged; bodies are not dumped.');
  log('================================================================');

  log('\n### 1. Fingerprint proof: curl vs node fetch on / (same host, back to back)');
  let curlCode = '000';
  try {
    curlCode = execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-A', UA, `${DOMAIN}/`],
      { encoding: 'utf8', timeout: 25000 }).trim();
  } catch { /* ignore */ }
  log(`[curl] /                              -> ${curlCode}`);
  await probe('/ (node)', `${DOMAIN}/`);
  log('# Expectation if fingerprint theory holds: curl=429, node=302->/password');

  log('\n### 2. UNAUTHENTICATED node probes (redirect manual)');
  for (const p of [...PATHS, '/password']) await probe(`unauth ${p}`, `${DOMAIN}${p}`);

  let root = null;
  try { root = await fetch(`${DOMAIN}/`, { headers: { ...BROWSER_HEADERS }, redirect: 'manual' }); } catch {}
  const locked = !root || root.status === 429 ||
    (root.status >= 300 && root.status < 400 && /\/password/.test(root.headers.get('location') || ''));
  log(`\n### 3. Lock detection: store is ${locked ? 'LOCKED' : 'PUBLIC'} (root / status ${root ? root.status : 'ERR'})`);

  if (locked && PW) {
    log('\n### 4. Authenticate via POST /password (node fetch), then probe REAL pages');
    const jar = new Map();
    try { updateJar(jar, await fetch(`${DOMAIN}/password`, { headers: BROWSER_HEADERS, redirect: 'manual' })); } catch {}
    try {
      const postRes = await fetch(`${DOMAIN}/password`, {
        method: 'POST',
        headers: { ...BROWSER_HEADERS, cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password: PW }).toString(),
        redirect: 'manual',
      });
      updateJar(jar, postRes);
      log(`[post] POST /password -> ${postRes.status} loc=${(postRes.headers.get('location') || '').replace(/^https:\/\/[^/]+/, '')}`);
      log(`[post] jar cookie names: ${jarNames(jar)}`);
    } catch (e) { log(`[post] POST /password ERR ${e.message}`); }

    log('-- authenticated probes (redirect manual; expect 200, NOT 302->/password) --');
    for (const p of ['/', '/cart', '/collections/all', '/collections', '/search?q=test']) {
      await probe(`authed ${p}`, `${DOMAIN}${p}`, { jar });
    }
    log('-- authenticated body markers (real page vs password page?) --');
    const homeText = await bodyMarkers('authed /', `${DOMAIN}/`, jar);
    const collText = await bodyMarkers('authed /collections/all', `${DOMAIN}/collections/all`, jar);

    log('\n### 5. Real product page (authenticated)');
    const handle = process.env.PRODUCT_HANDLE ||
      (collText.match(/\/products\/([a-z0-9][a-z0-9-]*)/) || [])[1] ||
      (homeText.match(/\/products\/([a-z0-9][a-z0-9-]*)/) || [])[1];
    if (handle) {
      log(`# using product handle: ${handle}`);
      await probe(`authed /products/${handle}`, `${DOMAIN}/products/${handle}`, { jar });
      await bodyMarkers(`authed /products/${handle}`, `${DOMAIN}/products/${handle}`, jar);
    } else {
      log('# no product handle found (store may have no listed products yet)');
    }
  } else if (!locked) {
    log('\n### 4. Store is PUBLIC; probing real pages directly');
    for (const p of PATHS) await probe(`public ${p}`, `${DOMAIN}${p}`, { follow: true });
  } else {
    log('\n### 4-5 SKIPPED (locked but no password provided)');
  }

  log('\n### 6. Summary questions this answers');
  log('#  - Does node fetch dodge the curl 429? (section 1)');
  log('#  - Locked now? (section 3)');
  log('#  - Does POST /password + node fetch yield REAL 200 content while locked?');
  log('#    -> section 4 authed / should be 200 pageType=index, storefront_markers=yes, password_form=no');
  log('#  - Theme-id header present on real pages for the deploy-landed assertion? (all lines)');
  log('================================ END ============================');

  // Defense in depth: scrub the literal password from the log before writing.
  let text = out.join('\n') + '\n';
  if (PW) text = text.split(PW).join('[REDACTED-PW]');
  writeFileSync(LOG, text);
  process.stderr.write(`\nDone. Redacted log: ${LOG}\n`);
})();
