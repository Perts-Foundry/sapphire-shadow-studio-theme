#!/usr/bin/env node
//
// surface.mjs -- public-surface / indexability check (mode: surface).
//
// WHY: sees the store exactly as a crawler does: ANONYMOUS, no password, no
// cookies. Pre-launch it reports the password gate as status (not failure);
// post-launch it is the regression check that nothing is accidentally blocked
// (surviving noindex), nothing serves the wrong host (a sitemap listing
// *.myshopify.com), and robots.txt still points at the canonical sitemap.
// Generalized from the launch-day checklist (B7) so it stays useful forever.
//
// SECURITY (public repo): deliberately takes NO password. Only URLs, statuses,
// hosts, and finding text are logged.
//
// USAGE: node scripts/seo-review/surface.mjs [--full] [--no-save] [--max <n>]

import { extractMetaByName, extractCanonical, parseSitemapLocs, parseSitemapChildren } from './lib/extract.mjs';
import { ERROR, WARN } from './lib/checks.mjs';
import { fetchPage, isLocked, landedOnPassword, sleep } from './lib/http.mjs';
import { finishRun } from './lib/report.mjs';

const BASE_URL = (process.env.BASE_URL || 'https://sapphireshadowstudio.com').replace(/\/+$/, '');
const EXPECTED_HOST = new URL(BASE_URL).host;

function arg(flag) { return process.argv.includes(flag); }
function argValue(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

async function main() {
  const maxUrls = Number(argValue('--max', '60')) || 60;
  const paceMs = 1500;
  const log = (l) => process.stdout.write(l + '\n');
  const findings = [];
  const add = (check, severity, url, detail) => findings.push({ check, severity, url, detail });

  log(`seo-review surface (anonymous): ${BASE_URL}`);

  // 1. Password gate status. Informational either way: locked pre-launch is
  // expected, public means the indexability checks below carry full weight.
  // isLocked reads the FINAL URL, because redirects are followed and a locked
  // root resolves to /password with a 200.
  const gated = await isLocked(BASE_URL);
  log(`password gate: ${gated ? 'ACTIVE (anonymous root resolves to the gate)' : 'off (root is public)'}`);

  // 2. robots.txt. Shopify auto-generates it; it should exist, disallow the
  // utility routes, and point Sitemap: at the canonical host.
  const robots = await fetchPage(`${BASE_URL}/robots.txt`, { anonymous: true });
  if (robots.status !== 200 || landedOnPassword(robots)) {
    add('robots-txt-unreachable', gated ? WARN : ERROR, `${BASE_URL}/robots.txt`,
      `${landedOnPassword(robots) ? 'redirects to the password gate' : `status ${robots.status ?? 'unreachable'}`}${gated ? ' (store is gated; recheck after launch)' : ''}`);
  } else {
    const sitemapLines = robots.body.split(/\r?\n/).filter((l) => /^sitemap:/i.test(l.trim()));
    if (sitemapLines.length === 0) {
      add('robots-no-sitemap', gated ? WARN : ERROR, `${BASE_URL}/robots.txt`,
        `no Sitemap: line${gated ? ' (store is gated; recheck after launch)' : ''}`);
    }
    for (const line of sitemapLines) {
      const url = line.replace(/^sitemap:\s*/i, '').trim();
      let host = null;
      try { host = new URL(url).host; } catch { /* flagged below */ }
      if (host !== EXPECTED_HOST) {
        add('robots-sitemap-host', ERROR, `${BASE_URL}/robots.txt`,
          `Sitemap: points at ${host || url}, expected ${EXPECTED_HOST}`);
      }
    }
  }

  // 3. Sitemap reachability and host consistency: every <loc> must live on
  // the canonical host, never *.myshopify.com.
  const urls = [];
  const idx = await fetchPage(`${BASE_URL}/sitemap.xml`, { anonymous: true });
  if (idx.status !== 200 || landedOnPassword(idx)) {
    add('sitemap-unreachable', gated ? WARN : ERROR, `${BASE_URL}/sitemap.xml`,
      `${landedOnPassword(idx) ? 'redirects to the password gate' : `status ${idx.status ?? 'unreachable'}`}${gated ? ' (store is gated; recheck after launch)' : ''}`);
  } else {
    const children = parseSitemapChildren(idx.body);
    const allLocs = [...parseSitemapLocs(idx.body)];
    for (const child of children) {
      const c = await fetchPage(child, { anonymous: true });
      if (c.status === 200) allLocs.push(...parseSitemapLocs(c.body));
    }
    let badHost = 0;
    for (const loc of allLocs) {
      let host = null;
      try { host = new URL(loc).host; } catch { continue; }
      if (host !== EXPECTED_HOST) badHost += 1;
      else if (!/\.xml$/.test(new URL(loc).pathname)) urls.push(loc);
    }
    if (badHost > 0) {
      add('sitemap-host', ERROR, `${BASE_URL}/sitemap.xml`,
        `${badHost} sitemap URL(s) on a non-canonical host (expected ${EXPECTED_HOST})`);
    }
    log(`sitemap: ${urls.length} page URL(s) on ${EXPECTED_HOST}`);
  }

  // 4. Per-page anonymous sweep: surviving noindex (meta or X-Robots-Tag) and
  // canonical host. Only meaningful when the gate is off; skipped when gated.
  if (gated) {
    log('per-page noindex/canonical sweep: SKIPPED (password gate active; anonymous fetches see only the gate)');
  } else {
    const targets = urls.slice(0, maxUrls);
    log(`sweeping ${targets.length} page(s) for noindex and canonical host...`);
    for (const url of targets) {
      await sleep(paceMs);
      const res = await fetchPage(url, { anonymous: true });
      if (res.status !== 200 || landedOnPassword(res)) {
        add('surface-page-status', ERROR, url,
          landedOnPassword(res)
            ? 'sitemap-listed URL redirects to the password gate'
            : `status ${res.status ?? 'unreachable'} for a sitemap-listed URL`);
        continue;
      }
      const robotsMeta = extractMetaByName(res.body, 'robots');
      const xRobots = res.headers ? res.headers.get('x-robots-tag') : null;
      if ((robotsMeta && /noindex/i.test(robotsMeta)) || (xRobots && /noindex/i.test(xRobots))) {
        add('surface-noindex', ERROR, url,
          `noindex on a sitemap-listed URL (${robotsMeta ? `meta "${robotsMeta}"` : `header "${xRobots}"`})`);
      }
      const canonical = extractCanonical(res.body);
      if (canonical) {
        let host = null;
        try { host = new URL(canonical).host; } catch { /* ignore */ }
        if (host && host !== EXPECTED_HOST) {
          add('surface-canonical-host', ERROR, url, `canonical on ${host}, expected ${EXPECTED_HOST}`);
        }
      }
    }
  }

  const exitCode = finishRun('surface', findings, {
    full: arg('--full'),
    noSave: arg('--no-save'),
    meta: { baseUrl: BASE_URL, gated, sitemapUrls: urls.length },
    log,
  });
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`seo-review surface: fatal (${e && e.name ? e.name : 'error'}: ${e && e.message ? e.message : ''})\n`);
  process.exit(1);
});
