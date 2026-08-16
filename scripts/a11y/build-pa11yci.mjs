#!/usr/bin/env node
// Build the pa11y-ci config for one preview theme, on stdout.
//
// Defaults are borrowed from perts-foundry-website/.pa11yci, the sibling repo
// where pa11y-ci already runs as a hard WCAG 2.1 AA gate. What does NOT port is
// that repo's plumbing: it builds a static site and serves it on localhost,
// whereas this theme's only rendered HTML lives behind a password-gated
// storefront, so every URL here is an authenticated remote request.
//
// The config is written to disk with a session cookie in it. It must never be
// uploaded as an artifact or echoed into a log; preview.yml writes it to
// $RUNNER_TEMP and reads it once.
//
// Usage: BASE_URL=... THEME_ID=... [COOKIE=...] node scripts/a11y/build-pa11yci.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PATHS_FILE = join(HERE, 'paths.json');

// Chrome comes from the RUNNER, not from puppeteer. `npm ci --ignore-scripts`
// (setup-shopify-cli) blocks puppeteer's install script, so the bundled
// Chromium is never downloaded; ubuntu-24.04 ships google-chrome-stable at this
// path. That is deliberate, not a workaround: every open npm-audit high in this
// tree lives in puppeteer's download path, and never running it is what keeps
// them unreachable. `--no-sandbox` is required because the runner executes as
// root in a container, where Chrome's sandbox refuses to start.
export const CHROME_PATH = '/usr/bin/google-chrome';

/**
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {string} o.themeId
 * @param {string} [o.cookie]   Cookie header; empty in PUBLIC mode
 * @param {object} [o.paths]    parsed paths.json; defaults to the committed file
 * @param {number} [o.timeout]
 * @param {number} [o.concurrency]
 * @returns {object} a pa11y-ci config object
 * @example
 *   buildConfig({ baseUrl: 'https://x.example', themeId: '1', cookie: 'a=b' })
 */
export function buildConfig({
  baseUrl,
  themeId,
  cookie = '',
  paths = JSON.parse(readFileSync(PATHS_FILE, 'utf8')),
  // Generous per-URL timeout: these are authenticated remote requests to a
  // storefront behind bot management, not localhost.
  timeout = 60000,
  // Deliberately serial. Shopify rate-limits the storefront and a burst of
  // parallel headless page loads is exactly the shape bot management reacts to;
  // a 429 would surface as a spurious accessibility failure.
  concurrency = 1,
} = {}) {
  if (!baseUrl) throw new Error('baseUrl is required');
  if (!/^\d+$/.test(String(themeId))) throw new Error('themeId must be numeric');

  const entries = paths?.paths;
  if (!Array.isArray(entries) || entries.length === 0) {
    // Fail closed: a config with no URLs makes pa11y-ci exit 0 having audited
    // nothing, which would read as a green accessibility check.
    throw new Error('paths.json contains no paths');
  }

  const headers = {};
  if (cookie) headers.Cookie = cookie;

  return {
    defaults: {
      standard: 'WCAG2AA',
      runners: ['axe'],
      // `target-size` is an axe rule outside the default WCAG2AA set. It is
      // included because CLAUDE.md makes 44x44 touch targets a project rule,
      // and a footer-link touch-target fix has already shipped once (PR #99).
      rules: ['target-size'],
      timeout,
      headers,
      chromeLaunchConfig: {
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        executablePath: CHROME_PATH,
      },
    },
    concurrency,
    urls: entries.map((entry) => {
      const url = new URL(entry.path, baseUrl);
      // Every URL carries the theme pin. The auth cookie also pins the session,
      // but the query parameter survives a cookie the storefront decides to
      // rotate mid-run, and costs nothing.
      url.searchParams.set('preview_theme_id', String(themeId));
      const built = { url: url.href };
      // Pass-through escape hatches for third-party embeds; see paths.json.
      if (entry.ignore) built.ignore = entry.ignore;
      if (entry.hideElements) built.hideElements = entry.hideElements;
      if (entry.actions) built.actions = entry.actions;
      return built;
    }),
  };
}

function main() {
  const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '');
  const themeId = process.env.THEME_ID || '';
  const cookie = process.env.COOKIE || '';
  process.stdout.write(`${JSON.stringify(buildConfig({ baseUrl, themeId, cookie }), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
