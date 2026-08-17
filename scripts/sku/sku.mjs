#!/usr/bin/env node
// sku: derive, audit and apply variant SKUs from the committed code tables.
//
// This tool writes to the LIVE store. There is no staging store, so the gates are not ceremony. The
// `sku` skill (.claude/skills/sku/SKILL.md) drives it and holds the operator approval STOPs; this
// file is the deterministic half.
//
//   audit   read-only health report: nulls, drift, unmapped values, collisions
//   plan    emit an immutable, hashed plan artifact from an audit (nulls only by default)
//   show    render an approved plan artifact for the approval gate (read-only)
//   apply   execute an approved artifact, and ONLY an artifact
//   verify  re-audit after an apply; the same read, framed as the exit check
//
// A SKU is always derived from a variant's own public option values through scripts/sku/tables.json.
// Read scripts/sku/README.md and docs/sku-scheme.md before using the write path.

import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { createAdminClient, assertScopes } from '../blank-inventory/lib/admin.mjs';
import { loadTables, hashTables, TABLES_PATH } from './lib/tables.mjs';
import { readCatalogue, readProductSkus, liveFetchers } from './lib/catalogue.mjs';
import { auditCatalogue, OK, MISMATCH, MISS, NULL_ACTIONABLE, NULL_EXEMPT } from './lib/audit.mjs';
import { buildPlan, PlanRefused } from './lib/planner.mjs';
import {
  createArtifact,
  verifyArtifact,
  assertTablesUnchanged,
  assertRenderablePlan,
  createReceipt,
  receiptTally,
  planPath,
  receiptPath,
  writeJsonAtomic,
  readJson,
  ROW_APPLIED,
  ROW_FAILED,
  ROW_SKIPPED,
} from './lib/artifact.mjs';
import { applyArtifact } from './lib/apply.mjs';
import { transcriptPath, withTranscript } from './lib/transcript.mjs';
import { setSkus } from './lib/mutations.mjs';
import { resolveWorkDir } from './lib/workdir.mjs';

/** Only what this tool actually uses. It never touches inventory levels or metafields. */
export const REQUIRED_SCOPES = ['write_products'];

const WORK_DIR = resolveWorkDir();

// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (val === undefined) {
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        val = next;
        i++;
      } else val = true;
    }
    opts[camel] = val;
  }
  return opts;
}

const fail = (msg) => {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
};

const heading = (s) => console.log(`\n${s}\n${'-'.repeat(s.length)}`);

/**
 * Read a flag that must carry a path.
 *
 * parseArgs gives a bare `--flag` the value `true`, so `--plan --dry-run` would otherwise reach
 * readFile as a boolean and surface as an unrelated type error rather than as the missing argument
 * it is.
 *
 * @param {string} flag
 * @param {unknown} raw
 * @param {(msg: string) => never} [onInvalid]
 * @returns {string}
 */
export function stringOpt(flag, raw, onInvalid = fail) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    onInvalid(`${flag} needs a value, got ${JSON.stringify(raw)}.`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
async function loadLiveAudit() {
  const tables = await loadTables();
  const client = createAdminClient();
  const { variants } = await readCatalogue(liveFetchers(client));
  return { tables, client, report: auditCatalogue(tables, variants), variants };
}

function renderAudit(report) {
  const c = report.counts;
  heading(`SKU audit: ${report.total} variant(s)`);
  console.log(`  correct .................. ${c[OK]}`);
  console.log(`  no SKU (actionable) ...... ${c[NULL_ACTIONABLE]}`);
  console.log(`  no SKU (exempt) .......... ${c[NULL_EXEMPT]}`);
  console.log(`  drift (SKU != derived) ... ${c[MISMATCH]}`);
  console.log(`  not derivable ............ ${c[MISS]}`);

  if (report.misses.length) {
    heading('Unmapped values and unknown products');
    console.log('Each needs a code in scripts/sku/tables.json. Copy the value verbatim; it is the table key.');
    for (const m of report.misses) {
      console.log(`  [${m.kind}] ${m.message}  (${m.variantCount} variant(s))`);
    }
  }
  if (report.duplicates.length) {
    heading('Duplicate expected SKUs (tables defect)');
    for (const d of report.duplicates) console.log(`  ${d.sku}: ${d.variantIds.length} variants in ${d.products.join(', ')}`);
  }
  if (report.collisions.length) {
    heading('Expected SKUs already live on another variant');
    for (const x of report.collisions) console.log(`  ${x.sku}: wanted by ${x.wantedBy} (${x.wantedByProduct}), held by ${x.heldBy} (${x.heldByProduct})`);
  }
  if (c[MISMATCH]) {
    heading('Drift');
    for (const r of report.rows.filter((r) => r.status === MISMATCH)) {
      console.log(`  ${r.variantId} ${r.productHandle}: has "${r.sku}", derives "${r.expected}"`);
    }
  }

  heading(report.ok ? 'Verdict: clean' : 'Verdict: work outstanding');
  for (const p of report.problems) console.log(`  - ${p}`);
  if (report.ok) console.log('  0 actionable nulls, no drift, no collisions.');
}

async function cmdAudit(opts) {
  const { report } = await loadLiveAudit();
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else renderAudit(report);
  process.exitCode = report.ok ? 0 : 1;
}

async function cmdVerify(opts) {
  const { report } = await loadLiveAudit();
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else renderAudit(report);
  if (!report.ok) {
    console.error(
      `\nVerify FAILED. This is not a partial success: the catalogue still has outstanding SKU work.\n` +
        `Start again at audit; do not re-run a spent plan artifact.\n`
    );
    process.exitCode = 1;
  } else {
    console.log('\nVerify passed: 0 actionable nulls.\n');
  }
}

async function cmdPlan(opts) {
  const { tables, report } = await loadLiveAudit();
  let built;
  try {
    built = buildPlan(report, { includeMismatches: Boolean(opts.includeMismatches) });
  } catch (err) {
    if (err instanceof PlanRefused) fail(err.message);
    throw err;
  }
  const artifact = createArtifact({
    rows: built.rows,
    refused: built.refused,
    mode: built.mode,
    tablesHash: hashTables(tables),
  });
  const file = planPath(WORK_DIR, artifact.planId);
  await writeJsonAtomic(file, artifact);
  heading('Plan written');
  console.log(`  rows ....... ${artifact.rows.length}`);
  console.log(`  refused .... ${artifact.refused.length}`);
  console.log(`  mode ....... ${artifact.mode}`);
  console.log(`  tables ..... ${artifact.tablesHash.slice(0, 12)}`);
  console.log(`  file ....... ${file}`);
  console.log(`\nNext: sku show --plan ${file}`);
}

async function loadPlan(opts) {
  const file = stringOpt('--plan', opts.plan);
  const artifact = verifyArtifact(await readJson(file));
  const tables = await loadTables();
  assertTablesUnchanged(artifact, hashTables(tables));
  assertRenderablePlan(artifact);
  return { file, artifact };
}

async function cmdShow(opts) {
  const { file, artifact } = await loadPlan(opts);
  heading(`Plan ${artifact.planId}`);
  console.log(`  file ....... ${file}`);
  console.log(`  created .... ${artifact.createdAt}`);
  console.log(`  mode ....... ${artifact.mode}`);
  console.log(`  tables ..... ${artifact.tablesHash.slice(0, 12)}`);
  console.log(`  rows ....... ${artifact.rows.length}`);

  const byProduct = new Map();
  for (const r of artifact.rows) {
    if (!byProduct.has(r.productHandle)) byProduct.set(r.productHandle, []);
    byProduct.get(r.productHandle).push(r);
  }
  for (const [handle, rows] of byProduct) {
    heading(`${handle} (${rows.length} row(s))`);
    for (const r of rows) {
      // Never truncated: a gate row that elides the size is a gate row the operator cannot check.
      console.log(`  ${pad(r.variantTitle ?? r.variantId, 52)} ${pad(fmt(r.baselineSku), 10)} -> ${r.expectedSku}`);
    }
  }
  if (artifact.refused.length) {
    heading(`Not in this plan (${artifact.refused.length})`);
    for (const r of artifact.refused) console.log(`  ${r.variantId ?? r.productHandle}: ${r.reason}`);
  }
  console.log(`\nThis artifact is the contract. apply writes exactly these rows and re-derives nothing.\n`);
}

async function cmdApply(opts) {
  const { file, artifact } = await loadPlan(opts);
  const dryRun = Boolean(opts.dryRun);
  const receiptFile = receiptPath(WORK_DIR, artifact.planId);

  if (!dryRun && existsSync(receiptFile)) {
    fail(
      `This plan has already been applied: ${receiptFile} exists. A plan artifact is single-use. ` +
        `Rows that landed are no longer at their recorded baseline, so re-running would skip them ` +
        `while retrying the rest against a store that has moved. Run audit, then plan, again.`
    );
  }

  const client = createAdminClient();
  // Capability is not authorization: this passing never substitutes for the operator's approval.
  await assertScopes(client, REQUIRED_SCOPES);
  const fetchers = liveFetchers(client);

  const receipt = createReceipt(artifact);
  // Everything from here on is gated output; tee it so the full verbatim record survives whatever
  // the invoking shell does to stdout (a pipe, a truncating harness). See lib/transcript.mjs.
  const transcriptFile = transcriptPath(WORK_DIR, artifact.planId, dryRun);
  await withTranscript(transcriptFile, async () => {
    heading(dryRun ? `DRY RUN: plan ${artifact.planId}` : `APPLYING plan ${artifact.planId}`);
    console.log(`  rows ....... ${artifact.rows.length}`);
    console.log(`  source ..... ${file}`);
    if (!dryRun) console.log(`  receipt .... ${receiptFile}`);
    console.log(`  transcript . ${transcriptFile}`);

    await applyArtifact(
      {
        artifact,
        receipt,
        readSkus: (productId) => readProductSkus(fetchers.fetchProductVariantsPage(productId)),
        write: (productId, rows) => setSkus(client, productId, rows),
      },
      {
        dryRun,
        persist: dryRun ? async () => {} : (r) => writeJsonAtomic(receiptFile, r),
        onProgress: (e) => {
          if (e.type === 'product') console.log(`  ${e.productId}: ${e.writable}/${e.planned} row(s) still at their baseline`);
          else console.error(`  ${e.type} on ${e.productId}: ${e.message}`);
        },
      }
    );

    const tally = receiptTally(receipt);
    heading(dryRun ? 'Dry run summary' : 'Apply summary');
    console.log(`  applied .... ${tally[ROW_APPLIED]}`);
    console.log(`  skipped .... ${tally[ROW_SKIPPED]}`);
    console.log(`  failed ..... ${tally[ROW_FAILED]}`);
    for (const r of receipt.rows.filter((r) => r.status === ROW_FAILED || (r.status === ROW_SKIPPED && !dryRun))) {
      console.log(`  [${r.status}] ${r.variantId} ${r.productHandle}: ${r.detail}`);
    }

    if (dryRun) {
      console.log(`\nNothing was written. Re-run without --dry-run to apply, after a separate approval.\n`);
      return;
    }
    console.log(`\nReceipt: ${receiptFile}`);
    console.log(`Each row records its prior SKU. There is no revert command by design: recovery is`);
    console.log(`applying those baselines back through the same gates. See docs/sku-scheme.md.`);
    if (tally[ROW_FAILED]) {
      console.error(
        `\n${tally[ROW_FAILED]} row(s) FAILED. Do not re-run this artifact; it is spent. If a whole ` +
          `product was refused by the API, that is the case docs/sku-scheme.md covers with ` +
          `"skuWritable": false. Otherwise start again at audit.\n`
      );
      process.exitCode = 1;
    }
    console.log('\nNext: sku verify\n');
  });
}

const pad = (s, n) => String(s ?? '').padEnd(n);
const fmt = (v) => (v === null || v === undefined ? '(none)' : v);

// ---------------------------------------------------------------------------
const USAGE = `
sku: derive, audit and apply variant SKUs.

  audit   [--json]                      read-only health report (exit 1 while work remains)
  plan    [--include-mismatches]        emit a hashed plan artifact (nulls only by default)
  show    --plan <artifact.json>        render a plan for the approval gate
  apply   --plan <artifact.json> [--dry-run]
  verify  [--json]                      re-audit after an apply

SKUs are derived from ${path.relative(process.cwd(), TABLES_PATH)}; that file is the source of truth.
Extending the scheme is a git edit and a PR, never a live write. See docs/sku-scheme.md.

Env: MYSHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET (via node --env-file=.env).
     SKU_WORK_DIR overrides the working directory.
Working directory: ${WORK_DIR}
     (outside the repo by default, so tool state never lands in this public checkout)
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const writeCommands = new Set(['apply']);
  const run = {
    audit: cmdAudit,
    plan: cmdPlan,
    show: cmdShow,
    apply: cmdApply,
    verify: cmdVerify,
  }[opts.command];

  if (!run) {
    console.log(USAGE);
    process.exit(opts.command ? 1 : 0);
  }
  // One write command, named rather than inferred from what each command happens to do.
  if (writeCommands.has(opts.command) && !opts.dryRun) {
    console.error('This command writes to the LIVE store. It executes an approved artifact and nothing else.');
  }
  await run(opts);
}

// Run as a script, but stay importable by the unit tests. import.meta.url is percent-encoded, so
// compare it against pathToFileURL(argv[1]) rather than a hand-built file:// string. Guarding the
// dereference keeps the module importable under `import()`, where argv[1] is undefined.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => fail(err.message));
}
