// baseline.mjs -- run history in a state dir OUTSIDE the repository.
//
// WHY OUTSIDE, AND WHY CHECKED. A run file holds Search Console numbers and finding text about a
// live property; a capture beside it holds query text visitors typed. None of it belongs in a
// public repo. seo-review keeps its state out of the tree by default; this module also REFUSES a
// state dir that resolves inside the checkout, both the worktree a session runs in and the primary
// checkout that worktree hangs off, because `.claude/worktrees/` sits inside the primary checkout
// and a path that is outside one can be inside the other. Resolution follows symlinks in both
// directions, and a directory that does not exist yet is judged by its nearest existing ancestor.
//
// Nothing here spawns git: the roots are read from the `.git` file a worktree carries, so the
// review's import closure stays free of node:child_process.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODES = Object.freeze(['audit', 'insights']);

/**
 * `SEARCH_CONSOLE_STATE_DIR`, else `$XDG_STATE_HOME/search-console`, else
 * `$HOME/.local/state/search-console`, all read from the injected env.
 */
export function stateDir(env = process.env) {
  const override = env.SEARCH_CONSOLE_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  const xdg = env.XDG_STATE_HOME?.trim();
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(env.HOME?.trim() || os.homedir(), '.local', 'state');
  return path.join(base, 'search-console');
}

/**
 * The checkout roots a state dir must stay out of: the working tree containing `startDir`, and,
 * when that tree is a linked worktree, the primary checkout (the git common dir's parent).
 * @returns {string[]}
 */
export function repoRoots(startDir = path.dirname(fileURLToPath(import.meta.url))) {
  let dir = path.resolve(startDir);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = null;
    }
    if (st?.isDirectory()) return [dir];
    if (st?.isFile()) {
      const roots = [dir];
      const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (m) {
        const gitdir = path.resolve(dir, m[1].trim());
        let common = gitdir;
        try {
          common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
        } catch {
          // no commondir: not a linked worktree layout; the gitdir itself is the common dir
        }
        roots.push(path.dirname(common));
      }
      return [...new Set(roots)];
    }
    const parent = path.dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
}

/** realpath of the nearest existing ancestor, with the not-yet-existing tail re-joined. */
export function realpathNearest(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...tail);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

const isInside = (child, root) => child === root || child.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

/** Throws when `dir` resolves inside any root, lexically or through a symlink. */
export function assertOutsideRepo(dir, roots) {
  const candidates = [path.resolve(dir), realpathNearest(dir)];
  for (const root of roots) {
    const forms = [path.resolve(root), realpathNearest(root)];
    if (candidates.some((c) => forms.some((r) => isInside(c, r)))) {
      throw new Error('the state dir resolves inside the repository checkout; point SEARCH_CONSOLE_STATE_DIR outside it');
    }
  }
}

const toIso = (now) => new Date(now instanceof Date ? now.getTime() : now).toISOString();

/**
 * Write one run file: `<mode>-<ISO stamp>-<NN>.json`. The two-digit counter makes two runs in the
 * same millisecond distinct and keeps lexical order equal to write order.
 * @returns {string} the path written
 */
export function saveRun(dir, { mode, now, captureBasename = null, reportStatus = {}, metrics = {}, period = null, meta = {}, findings = [], accepted = [] }) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${JSON.stringify(mode)}`);
  fs.mkdirSync(dir, { recursive: true });
  const generated = toIso(now ?? new Date());
  const stamp = generated.replace(/[:.]/g, '-');
  const body = `${JSON.stringify({
    generated, mode, capture_basename: captureBasename, report_status: reportStatus, metrics, period, meta, findings, accepted,
  }, null, 2)}\n`;
  for (let i = 0; i < 100; i++) {
    const file = path.join(dir, `${mode}-${stamp}-${String(i).padStart(2, '0')}.json`);
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return file;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('no free run file name for this timestamp');
}

const RUN_RE = /^(audit|insights)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{2}\.json$/;

/** Run files for a mode, newest first, parsed lazily; unreadable files are skipped. */
function* runsNewestFirst(dir, mode) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const mine = names.filter((n) => RUN_RE.test(n) && n.startsWith(`${mode}-`)).sort().reverse();
  for (const name of mine) {
    const file = path.join(dir, name);
    try {
      yield { path: file, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      // a truncated or hand-edited file is not a baseline
    }
  }
}

/** The newest run of `mode`, or null. */
export function loadLatest(dir, mode) {
  for (const run of runsNewestFirst(dir, mode)) return run;
  return null;
}

/**
 * The newest run of the same mode in which `reportId` was `ok`. A not-ready report is not a
 * baseline: comparing against one would report every real finding as new and none as resolved.
 * `envelope` matches any run of the mode.
 */
export function loadLatestComparable(dir, mode, reportId) {
  for (const run of runsNewestFirst(dir, mode)) {
    if (reportId === 'envelope' || run.report_status?.[reportId] === 'ok') return run;
  }
  return null;
}
