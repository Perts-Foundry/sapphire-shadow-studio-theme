#!/usr/bin/env node
//
// config.mjs: Tier A2 of the site-check skill. Read-only Admin GraphQL reads (shipping profiles,
// products and variants, policies, locales, markets, menus, shop) classified against the
// committed catalogue and the theme's effective settings.
//
// Side effects: none on the store. The Admin client is wrapped by lib/admin-readonly.mjs, which
// refuses any mutation document before it reaches the network. Baseline runs are saved under
// SITE_CHECK_STATE_DIR (default ~/.local/state/site-check), never in the repo.
//
// USAGE: node scripts/site-check/config.mjs [--full] [--no-save] [--strict] [--json] [--public]
//                                           [--surface <id>] [--help]
//   Requires MYSHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET.
//
// This is the one file in the tier that reads process.env, process.argv and the filesystem; the
// lib modules it calls are pure and tested without a network.

import { readFileSync, readdirSync } from 'node:fs';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { readCommittedCatalogue } from '../lib/catalogue-manifest.mjs';
import { checksForSurface, isSurfaceId, SURFACES } from './lib/registry.mjs';
import { sortFindings } from './lib/finding.mjs';
import { createRedactor } from './lib/redact.mjs';
import { createStore, diffFindings, partitionAccepted, exitCodeFor } from './lib/state.mjs';
import { READS, REQUIRED_SCOPES } from './lib/admin-queries.mjs';
import { createReadOnlyClient, readOrSkip } from './lib/admin-readonly.mjs';
import {
  flattenProducts, flattenDeliveryProfiles, marketCountries, partialFinding, dollarAmounts,
  classifyDeliveryProfiles, classifyVariants, classifyProducts, classifyPolicies, classifyShop,
} from './lib/admin-checks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const MODE = 'config';
const ENV_NAMES = ['MYSHOPIFY_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'];
const A2_SURFACES = ['shipping', 'products-admin', 'policies', 'locales', 'admin-config', 'navigation', 'checkout', 'accounts'];

const USAGE = `usage: node scripts/site-check/config.mjs [options]

Tier A2: read-only Admin configuration checks. Never writes to the store.

  --full             print unchanged findings and accepted risks too
  --no-save          do not save this run as the next baseline
  --strict           exit 1 on any unaccepted ERROR, not only new ones
  --json             print the findings as JSON instead of the report
  --public           compare against and save the PUBLIC baseline (storefront password off)
  --surface <id>     run only the reads feeding one surface; implies --no-save
                     (${A2_SURFACES.join(' | ')})
  --help             this text

env: ${ENV_NAMES.join(', ')} (required); SITE_CHECK_STATE_DIR (optional)
required Admin scopes: ${REQUIRED_SCOPES.join(', ')}
`;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { full: false, noSave: false, strict: false, json: false, public: false, surface: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') out.full = true;
    else if (a === '--no-save') out.noSave = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--json') out.json = true;
    else if (a === '--public') out.public = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--surface') { out.surface = argv[i + 1] ?? null; i += 1; }
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.surface !== null) {
    if (!isSurfaceId(out.surface) || !A2_SURFACES.includes(out.surface)) {
      throw new Error(`--surface must be one of ${A2_SURFACES.join(', ')} (registered surfaces: ${SURFACES.map((s) => s.id).join(', ')})`);
    }
    out.noSave = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Theme-side inputs
// ---------------------------------------------------------------------------

/** Shopify JSON may start with a `/* ... *\/` banner; strip it before parsing. */
export function parseShopifyJson(text) {
  return JSON.parse(String(text).replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''));
}

/** settings_data.json `current` merged over settings_schema.json defaults. */
export function effectiveSettings(schemaText, dataText) {
  const defaults = {};
  for (const section of parseShopifyJson(schemaText)) {
    for (const s of section.settings || []) if (s.id && 'default' in s) defaults[s.id] = s.default;
  }
  const data = parseShopifyJson(dataText);
  const current = typeof data.current === 'string' ? (data.presets || {})[data.current] || {} : data.current || {};
  const { sections: _sections, blocks: _blocks, ...flat } = current;
  return { ...defaults, ...flat };
}

/** The header section's `show_country` from sections/header-group.json (false when absent). */
export function headerShowCountry(groupText) {
  const group = parseShopifyJson(groupText);
  for (const section of Object.values(group.sections || {})) {
    if (section && section.type === 'header') return Boolean(section.settings && section.settings.show_country);
  }
  return false;
}

/** `$` amounts and rate words from the announcement bar and the JSON templates. */
function themeCopy() {
  const texts = [];
  const push = (p) => { try { texts.push(readFileSync(p, 'utf8')); } catch { /* optional */ } };
  push(join(REPO_ROOT, 'sections', 'header-group.json'));
  let templates = [];
  try { templates = readdirSync(join(REPO_ROOT, 'templates')).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  for (const f of templates) push(join(REPO_ROOT, 'templates', f));
  const all = texts.join('\n');
  const amounts = [...new Set(dollarAmounts(all))];
  const tokens = [...new Set((all.toLowerCase().match(/\b(flat|free|expedited|standard|economy|express|priority|ground|overnight)\b(?=[^\n]{0,40}shipping)/g) || []))];
  return { amounts, tokens };
}

// ---------------------------------------------------------------------------
// Classification per read
// ---------------------------------------------------------------------------

function classifyRead(name, data, ctx) {
  const findings = [];
  const partial = partialFinding(name, data);
  if (partial) findings.push(partial);
  switch (name) {
    case 'deliveryProfiles':
      findings.push(...classifyDeliveryProfiles({ profiles: flattenDeliveryProfiles(data), settings: ctx.settings, copyAmounts: ctx.copy.amounts, copyTokens: ctx.copy.tokens }));
      break;
    case 'products': {
      const products = flattenProducts(data);
      findings.push(...classifyProducts({ products, catalogue: ctx.catalogue }));
      findings.push(...classifyVariants({ products, catalogue: ctx.catalogue }));
      ctx.meta.products = products.length;
      ctx.meta.variants = products.reduce((n, p) => n + p.variants.length, 0);
      break;
    }
    case 'shopPolicies':
      findings.push(...classifyPolicies({ policies: (data.shop && data.shop.shopPolicies) || [], settings: ctx.settings }));
      break;
    case 'shopLocales':
      findings.push(...classifyShop({ locales: data.shopLocales || [], settings: ctx.settings }));
      break;
    case 'markets':
      findings.push(...classifyShop({ markets: marketCountries(data), showCountry: ctx.showCountry, settings: ctx.settings }));
      break;
    case 'menus':
      findings.push(...classifyShop({ menus: (data.menus && data.menus.edges ? data.menus.edges.map((e) => e.node) : []), settings: ctx.settings }));
      break;
    case 'shop':
      findings.push(...classifyShop({ shop: data.shop, sellsGiftCard: ctx.sellsGiftCard, settings: ctx.settings }));
      break;
    default:
      break;
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function printReport(log, { fresh, accepted, previous, diff, full }) {
  log('');
  log(`== site-check ${MODE}: ${fresh.length} finding(s), ${accepted.length} accepted risk(s) ==`);
  if (previous) log(`baseline: ${previous.generated} (${diff.added.length} new, ${diff.resolved.length} resolved, ${diff.skipped.length} skipped, ${diff.unchanged.length} unchanged)`);
  else log('baseline: none (first run; all findings are new)');
  const printList = (label, list) => {
    if (!list.length) return;
    log(`\n${label}:`);
    for (const f of sortFindings(list)) {
      log(`  [${f.severity}] ${f.check} ${f.subject}\n      ${f.message}${f.evidence ? `\n      evidence: ${f.evidence}` : ''}`);
    }
  };
  printList('NEW since baseline', diff.added);
  printList('RESOLVED since baseline', diff.resolved);
  printList('SKIPPED this run (baseline findings whose check did not run)', diff.skipped);
  printList('SKIPPED reads', fresh.filter((f) => f.severity === 'SKIPPED'));
  if (full) {
    printList('UNCHANGED (still present)', diff.unchanged);
    if (accepted.length) {
      log('\nACCEPTED RISKS (known, deliberate):');
      for (const f of accepted) log(`  [${f.severity}] ${f.check} ${f.subject}\n      ${f.message}\n      accepted ${f.accepted_on}: ${f.note}`);
    }
  } else {
    if (diff.unchanged.length) log(`\n(${diff.unchanged.length} unchanged finding(s) suppressed; run with --full to see them)`);
    if (accepted.length) log(`(${accepted.length} accepted risk(s) suppressed; run with --full to see them)`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) { process.stdout.write(USAGE); return 0; }

  const missingEnv = ENV_NAMES.filter((n) => !process.env[n]);
  if (missingEnv.length) {
    process.stderr.write(`config.mjs needs ${ENV_NAMES.join(', ')}; missing: ${missingEnv.join(', ')}\n`);
    return 2;
  }

  const client = createReadOnlyClient(createAdminClient(
    process.env.SHOPIFY_API_VERSION ? { apiVersion: process.env.SHOPIFY_API_VERSION } : {},
  ));
  const ownRedact = createRedactor([process.env.SHOPIFY_CLIENT_SECRET]);
  const redact = (s) => ownRedact(client.redact(s));
  const log = (line) => { if (!args.json) process.stdout.write(`${redact(line)}\n`); };
  const lockState = args.public ? 'PUBLIC' : 'LOCKED';

  log(`site-check ${MODE} (read-only): ${process.env.MYSHOPIFY_DOMAIN}, API ${client.apiVersion}, baseline ${lockState}`);

  const granted = await client.scopes();
  const grantedSet = new Set(granted);
  log(`scopes: ${REQUIRED_SCOPES.map((s) => `${s}${grantedSet.has(s) ? ' (granted)' : ' (MISSING)'}`).join(', ')}`);

  const catalogue = readCommittedCatalogue();
  const ctx = {
    catalogue,
    settings: effectiveSettings(
      readFileSync(join(REPO_ROOT, 'config', 'settings_schema.json'), 'utf8'),
      readFileSync(join(REPO_ROOT, 'config', 'settings_data.json'), 'utf8'),
    ),
    showCountry: headerShowCountry(readFileSync(join(REPO_ROOT, 'sections', 'header-group.json'), 'utf8')),
    sellsGiftCard: [...catalogue.products.values()].some((p) => p.template === 'gift-card'),
    copy: themeCopy(),
    meta: { host: process.env.MYSHOPIFY_DOMAIN, apiVersion: client.apiVersion, reads: [] },
  };

  const surfaceChecks = args.surface ? new Set(checksForSurface(args.surface).map((c) => c.id)) : null;
  const reads = surfaceChecks ? READS.filter((r) => r.checks.some((c) => surfaceChecks.has(c))) : READS;
  if (args.surface) log(`surface ${args.surface}: ${reads.map((r) => r.name).join(', ') || 'no reads'}`);

  const findings = [];
  for (const read of reads) {
    const result = await readOrSkip({ client, read, granted, redact });
    findings.push(...result.findings);
    ctx.meta.reads.push({ name: read.name, skipped: result.skipped, failed: Boolean(result.error) });
    if (result.skipped) { log(`read ${read.name}: SKIPPED (${result.missing.join(', ')} not granted)`); continue; }
    if (result.error) { log(`read ${read.name}: FAILED`); continue; }
    const out = classifyRead(read.name, result.data, ctx);
    findings.push(...out);
    log(`read ${read.name}: ${out.length} finding(s)`);
  }

  let acceptedRisks = [];
  try { acceptedRisks = JSON.parse(readFileSync(join(HERE, 'accepted-risks.json'), 'utf8')); } catch { acceptedRisks = []; }
  const { fresh, accepted } = partitionAccepted(findings, acceptedRisks);

  const dir = process.env.SITE_CHECK_STATE_DIR || join(homedir(), '.local', 'state', 'site-check');
  const store = createStore({
    io: {
      readdir: (d) => readdir(d),
      readFile: (p) => readFile(p, 'utf8'),
      writeFile: (p, text) => writeFile(p, redact(text)),
      mkdir: (d) => mkdir(d, { recursive: true }),
    },
    dir,
  });
  const previous = await store.loadLatest(MODE, lockState);
  const diff = diffFindings(previous ? previous.findings : null, fresh);

  if (args.json) {
    process.stdout.write(`${redact(JSON.stringify({ mode: MODE, lockState, meta: ctx.meta, findings: sortFindings(fresh), accepted, diff }, null, 2))}\n`);
  } else {
    printReport(log, { fresh, accepted, previous, diff, full: args.full });
  }

  if (!args.noSave) {
    const path = await store.save(MODE, lockState, fresh, ctx.meta);
    log(`\nsaved run -> ${path}`);
  } else if (args.surface) {
    log('\n(surface run; not saved)');
  }

  const code = exitCodeFor({ fresh, added: diff.added, hasBaseline: Boolean(previous), strict: args.strict });
  log(`exit ${code} (${args.strict ? 'blocks on any unaccepted ERROR' : 'blocks only on ERROR findings new since the baseline'})`);
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((e) => {
    let msg = String(e && e.message ? e.message : 'error');
    const secret = process.env.SHOPIFY_CLIENT_SECRET;
    if (secret) msg = msg.split(secret).join('[redacted]');
    process.stderr.write(`site-check config: fatal (${msg})\n`);
    process.exit(1);
  });
}
