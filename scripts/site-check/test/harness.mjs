// Shared test support for scripts/site-check. Import it FIRST in every test file:
//
//   import { installFetchGuard, fakeResponse, scriptedFetch, tempDir } from './harness.mjs';
//   installFetchGuard();
//
// installFetchGuard replaces globalThis.fetch with a function that throws, so a lib module that
// reaches the network by accident fails the suite instead of touching the store. Tests import
// lib/* only, never the three entry scripts, and every fixture is synthetic: public handles and
// prices are fine; no real cart tokens, customer data or order ids.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function installFetchGuard() {
  globalThis.fetch = () => { throw new Error('network is disabled in site-check unit tests'); };
}

/** A temp dir under the OS tmpdir; returns { dir, cleanup }. Never inside the checkout. */
export function tempDir(prefix = 'site-check-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Minimal Response stand-in covering what the storefront helpers read: status, url, headers.get,
 * headers.getSetCookie, text(), json().
 * @param {object} o
 * @param {number} [o.status]
 * @param {string} [o.url]
 * @param {string|object} [o.body]  a string, or an object serialised as JSON
 * @param {Record<string,string>} [o.headers]
 * @param {string[]} [o.setCookie]
 */
export function fakeResponse({ status = 200, url = 'https://example.test/', body = '', headers = {}, setCookie = [] } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: {
      get: (k) => lower[k.toLowerCase()] ?? null,
      getSetCookie: () => setCookie,
    },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/**
 * A scripted fetch: `script` is an array of { match: (url, init) => boolean, respond: (url, init) => Response|Error }
 * consulted in order; the first match wins. Unmatched calls throw. `calls` records every call
 * (url, method, headers, body) so a test can assert cookie continuity and ordering.
 */
export function scriptedFetch(script) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ?? null });
    const step = script.find((s) => s.match(String(url), init));
    if (!step) throw new Error(`scriptedFetch: no script entry for ${init.method || 'GET'} ${url}`);
    const out = step.respond(String(url), init);
    if (out instanceof Error) throw out;
    return out;
  };
  fn.calls = calls;
  return fn;
}

/** An in-memory io for lib/state.mjs createStore. */
export function memoryIo() {
  const files = new Map();
  return {
    files,
    async readdir(dir) {
      const out = [];
      for (const k of files.keys()) if (k.startsWith(`${dir}/`)) out.push(k.slice(dir.length + 1));
      if (!out.length) throw new Error('ENOENT');
      return out;
    },
    async readFile(p) { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
    async writeFile(p, text) { files.set(p, text); },
    async mkdir() {},
  };
}

/** A fixed clock for deterministic file names. */
export function fixedNow(iso = '2026-01-01T00:00:00.000Z') {
  let t = Date.parse(iso);
  const now = () => t;
  now.tick = (ms = 1000) => { t += ms; };
  return now;
}
