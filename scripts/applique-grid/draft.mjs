#!/usr/bin/env node
// The naming gate's working draft, and the only tool that writes the pattern block of
// patterns.json. Before this, the 18-pattern registry was hand-authored twice and 18 confirmed
// operator decisions survived a session boundary only via a hand-written ledger and two
// hand-written handoff prompts.
//
//   --init-from-registry  import the committed registry into a draft (also the resume path for a
//                         run interrupted after the registry write)
//   --validate            assemble a candidate registry, run the REAL validator, write nothing
//   --table               the narrow inline choice table, plus the wide gate-table.md, both
//                         carrying a content digest of exactly what was rendered
//   --write               merge the draft's threads and patterns into patterns.json
//
// --write is the dangerous one, and its rails are mechanisms rather than prose:
//   - a MERGE, never a whole-file write. `published`, `chart`, and `product` are structurally
//     untouchable; a whole-file write from a draft with no concept of `published` would drop the
//     chart media GIDs and spec hashes, and the next publish would re-create chart media with
//     nothing to reconcile against. That is a live-store regression from a local command.
//   - refuses on the default branch and on a dirty patterns.json. The skill has said
//     "feature-branch only" since it was written, and a run read it, announced compliance, and did
//     not comply. A rule that already failed does not get a fourth restatement; it gets a refusal.
//   - prints a unified diff and refuses without --confirm. Validity is not approval.
//   - recomputes the gate-table digest and refuses on mismatch, naming the changed rows.
//   - atomic write: a truncated patterns.json breaks every other tool in this module.

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CANDIDATE_ANGLES, candidateRegistry, detailTable, digestProblems, draftProblems, emptyDraft,
  keyFor, narrowTable, tableDigest, tableRows, threadUsage, validationProblems,
} from './lib/draft.mjs';
import { load as loadRegistry, serialize, REGISTRY_PATH } from './lib/registry.mjs';
import { unifiedDiff } from './lib/text-diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_OUT_DIR = 'product-images/applique';
const OUT_DIR_RE = /(^|[\\/])product-images([\\/]|$)/;
const LEDGER_NAME = 'grouping-ledger.md';

export const HELP = `Usage: node scripts/applique-grid/draft.mjs <mode> [options]

Modes (exactly one):
  --init-from-registry   Import the committed registry into draft.json (also the resume path).
  --validate             Run the real registry validator over the assembled draft; write nothing.
  --table                Print the narrow choice table and write gate-table.md, both digested.
  --write                Merge the draft's threads + patterns into patterns.json.

Options:
  --confirm                     Required by --write, after reviewing the printed diff.
  --allow-pattern-set-change    Required by --write when the draft adds or removes patterns.
  --out-dir <dir>               Working directory (default ${DEFAULT_OUT_DIR}; must be under product-images/).
  --help                        This text.

The draft (product-images/applique/draft.json) is AUTHORITATIVE for the decisions.
${LEDGER_NAME} is human-readable notes with no authority, and audit.mjs --local is a step pointer,
not a record. On disagreement the draft wins and the ledger is corrected.
`;

export function parseArgs(argv) {
  const opts = {
    initFromRegistry: false,
    validate: false,
    table: false,
    write: false,
    confirm: false,
    allowPatternSetChange: false,
    help: false,
    outDir: DEFAULT_OUT_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === 'help') { opts.help = true; continue; }
    if (a === 'init-from-registry') { opts.initFromRegistry = true; continue; }
    if (a === 'validate') { opts.validate = true; continue; }
    if (a === 'table') { opts.table = true; continue; }
    if (a === 'write') { opts.write = true; continue; }
    if (a === 'confirm') { opts.confirm = true; continue; }
    if (a === 'allow-pattern-set-change') { opts.allowPatternSetChange = true; continue; }
    if (a === 'out-dir') { opts.outDir = val ?? argv[++i]; continue; }
    throw new Error(`Unknown option --${a}`);
  }
  if (opts.help) return opts;
  const modes = [opts.initFromRegistry, opts.validate, opts.table, opts.write].filter(Boolean);
  if (modes.length !== 1) throw new Error('pick exactly one mode: --init-from-registry, --validate, --table, or --write');
  return opts;
}

// ---------------------------------------------------------------------------
// git rails. Exported so the refusals are testable without a repo.
// ---------------------------------------------------------------------------

function git(args, cwd = REPO_ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * The repository's default branch name, best effort. Falls back through the conventional names,
 * because a wrong answer here must fail CLOSED (refusing a legitimate branch) rather than open.
 * @param {(args: string[]) => string} [run]
 * @returns {string}
 */
export function defaultBranch(run = git) {
  try {
    return run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  } catch {
    for (const name of ['main', 'master']) {
      try { run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]); return name; } catch { /* next */ }
    }
    return 'main';
  }
}

/**
 * Why the working tree is not in a state where patterns.json may be rewritten, or null.
 * @param {object} input
 * @param {string} input.branch - current branch
 * @param {string} input.defaultName - the repo's default branch
 * @param {string} input.status - `git status --porcelain -- patterns.json` output
 * @returns {string | null}
 */
export function treeProblem({ branch, defaultName, status }) {
  if (!branch || branch === 'HEAD') return 'HEAD is detached; check out a feature branch before writing the registry';
  if (branch === defaultName) {
    return `refusing to write patterns.json on the default branch (${branch}); create a feature branch first`;
  }
  if (status.trim()) return 'patterns.json already has uncommitted changes; commit or discard them so this diff stands alone';
  return null;
}

// ---------------------------------------------------------------------------

/**
 * Write via a temp file in the SAME directory, then rename. A failure anywhere before the rename
 * leaves the target untouched; a truncated patterns.json would break every other tool here. The fs
 * calls are injectable so the mid-write failure is testable rather than assumed.
 * @param {string} target
 * @param {string} contents
 * @param {{writeFile?: Function, rename?: Function, suffix?: string}} [io]
 * @returns {Promise<void>}
 */
export async function atomicWrite(target, contents, io = {}) {
  const w = io.writeFile ?? writeFile;
  const r = io.rename ?? rename;
  const tmp = `${target}.tmp-${io.suffix ?? process.pid}`;
  await w(tmp, contents);
  await r(tmp, target);
}

const draftPath = (outDir) => path.join(outDir, 'draft.json');

async function readDraft(outDir) {
  const p = draftPath(outDir);
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`no draft at ${p}; run draft.mjs --init-from-registry, or write one at the grouping gate`);
    throw new Error(`draft is unreadable (${e.message}); fix or delete ${p}`);
  }
}

async function writeDraft(outDir, draft) {
  await mkdir(outDir, { recursive: true });
  await writeFile(draftPath(outDir), `${JSON.stringify(draft, null, 2)}\n`);
  return draftPath(outDir);
}

function printProblems(problems, ok) {
  if (!problems.length) { console.log(ok); return true; }
  console.log(`${problems.length} problem(s):`);
  problems.forEach((p) => console.log(`  - ${p}`));
  return false;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function modeInit({ outDir }) {
  const registry = await loadRegistry(REGISTRY_PATH);
  const draft = {
    ...emptyDraft(),
    threads: [...registry.threads],
    patterns: registry.patterns.map((p) => ({
      id: p.id,
      name: p.name,
      thread: p.thread,
      status: p.status,
      sources: [...p.sources],
      hero: p.hero,
      crop: { ...p.crop },
      position: p.position,
    })),
  };
  const p = await writeDraft(outDir, draft);
  console.log(`Wrote ${p} from the committed registry: ${draft.patterns.length} pattern(s), ${draft.threads.length} thread(s).`);
  console.log('This is also the resume path for a run interrupted after the registry write.');
}

async function modeValidate({ outDir }) {
  const draft = await readDraft(outDir);
  const existing = await loadRegistry(REGISTRY_PATH);
  const problems = validationProblems(draft, existing);
  const ok = printProblems(problems, `Draft assembles into a valid registry (${draft.patterns?.length ?? 0} pattern(s)). Nothing written.`);

  const usage = threadUsage(draft);
  console.log(`\nThreads in use (${usage.length}):`);
  for (const t of usage) {
    console.log(`  ${String(t.count).padStart(3)} x ${t.thread}${t.singleton ? '   (singleton)' : ''}${t.declared ? '' : '   (not in the declared palette)'}`);
  }
  console.log('\nNear-duplicate threads are consolidated from THIS list, not by eye. Consolidation');
  console.log('applies to future runs: renaming a thread on an existing pattern changes that chart\'s');
  console.log('spec hash, which republishes it (a live create plus a delete).');
  if (!ok) process.exitCode = 1;
}

async function modeTable({ outDir }) {
  const draft = await readDraft(outDir);
  const structural = draftProblems(draft);
  if (structural.length) {
    printProblems(structural, '');
    process.exitCode = 1;
    return;
  }
  const registry = await loadRegistry(REGISTRY_PATH);
  const rows = tableRows(draft);

  // Edge clearance comes from the SAME exported screen render.mjs's pre-flight uses. Missing cells
  // are not an error here: the table is presented before any render has run.
  const clearance = {};
  try {
    const { scanCrop } = await import('./crops.mjs');
    for (const r of rows) {
      if (!r.crop) { clearance[r.key] = null; continue; }
      try {
        clearance[r.key] = await scanCrop({ source: path.join(outDir, 'cells', `${r.hero}.jpg`), box: r.crop });
      } catch {
        clearance[r.key] = null;
      }
    }
  } catch (e) {
    console.warn(`WARN: edge-clearance column unavailable (${e.message}); rendering it as n/a`);
  }

  const digest = tableDigest(draft);
  draft.tableDigest = digest;
  await writeDraft(outDir, draft);
  const detailPath = path.join(outDir, 'gate-table.md');
  await writeFile(detailPath, detailTable({
    rows, draft, colorValues: registry.product.colorValues, clearance, ledgerName: LEDGER_NAME,
  }));

  console.log(`Naming angles: ${CANDIDATE_ANGLES.map((a) => `${a.letter} ${a.label}`).join(', ')}. "n/a" is a legal cell.`);
  console.log(`Digest: ${digest.digest}\n`);
  console.log(narrowTable(rows));
  console.log(`\nFull detail (thread, hero, sources, crop, edge clearance, guards): ${detailPath}`);
  console.log('A letter approves the NAME for that row and nothing else.');
  console.log('Row keys are hero filename stems, not ordinals: a merge, split, or re-sort would');
  console.log('silently repoint an ordinal, and any membership change voids outstanding approvals.');
}

async function modeWrite({ outDir, confirm, allowPatternSetChange }) {
  const draft = await readDraft(outDir);

  // Read the existing registry FIRST: this is a merge, and there is nothing to merge onto if it is
  // absent or unparseable.
  const raw = await readFile(REGISTRY_PATH, 'utf8').catch(() => {
    throw new Error(`${REGISTRY_PATH} is missing; --write merges into an existing registry, it does not create one`);
  });
  let existing;
  try {
    existing = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${REGISTRY_PATH} does not parse (${e.message}); fix it before writing`);
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const tree = treeProblem({
    branch,
    defaultName: defaultBranch(),
    status: git(['status', '--porcelain', '--', path.relative(REPO_ROOT, REGISTRY_PATH)]),
  });
  if (tree) throw new Error(tree);

  const stale = digestProblems(draft);
  if (stale.length) throw new Error(`the approved gate table no longer describes this draft:\n  - ${stale.join('\n  - ')}`);

  const problems = validationProblems(draft, existing);
  if (problems.length) throw new Error(`draft does not assemble into a valid registry:\n  - ${problems.join('\n  - ')}`);

  const next = candidateRegistry(draft, existing);
  const before = new Set((existing.patterns ?? []).map((p) => p.id));
  const after = new Set(next.patterns.map((p) => p.id));
  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  if ((added.length || removed.length) && !allowPatternSetChange) {
    throw new Error(
      `the draft changes the pattern set (${added.length} added, ${removed.length} removed: ${[...added.map((i) => `+${i}`), ...removed.map((i) => `-${i}`)].join(', ')}).\n`
      + 'Re-run with --allow-pattern-set-change if that is intended.',
    );
  }

  // Structural untouchables, asserted rather than assumed.
  for (const key of ['published', 'chart', 'product']) {
    if (JSON.stringify(next[key]) !== JSON.stringify(existing[key])) {
      throw new Error(`internal: --write would change ${key}, which is publish-owned or gate-owned and must pass through untouched`);
    }
  }

  const serialized = serialize(next);
  const diff = unifiedDiff(raw, serialized, {
    context: 3,
    fromLabel: 'patterns.json (committed)',
    toLabel: 'patterns.json (after --write)',
  });
  if (!diff) {
    console.log('patterns.json already carries exactly this draft; nothing to write.');
    return;
  }

  console.log(`Branch: ${branch}. Resolved decisions:\n`);
  for (const p of next.patterns) {
    const crop = `${p.crop.left}, ${p.crop.top}, ${p.crop.width}`;
    console.log(`  ${keyFor(p.hero).padEnd(14)} -> ${p.name} / ${p.thread} / hero ${p.hero} / crop ${crop}`);
  }
  console.log(`\n${diff}`);

  if (!confirm) {
    console.log('Nothing written. Validity is not approval: re-run with --confirm once the diff above is confirmed.');
    process.exitCode = 1;
    return;
  }

  await atomicWrite(REGISTRY_PATH, serialized);
  console.log(`Wrote ${REGISTRY_PATH} (${next.patterns.length} pattern(s), ${next.threads.length} thread(s)).`);
  console.log('Revert path: git checkout scripts/applique-grid/patterns.json (valid until a publish runs on top of it).');
  console.log('Next: node scripts/applique-grid/audit.mjs --local, then render.mjs --sample.');
}

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }

  const outDir = path.resolve(opts.outDir);
  if (!OUT_DIR_RE.test(outDir)) {
    throw new Error(`--out-dir must be under a 'product-images/' directory (got ${outDir}); refusing to write elsewhere.`);
  }

  if (opts.initFromRegistry) return modeInit({ outDir });
  if (opts.validate) return modeValidate({ outDir });
  if (opts.table) return modeTable({ outDir });
  return modeWrite({ outDir, confirm: opts.confirm, allowPatternSetChange: opts.allowPatternSetChange });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
}
