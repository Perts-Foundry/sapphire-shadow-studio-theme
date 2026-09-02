// Tier C operator run file: a markdown checklist rendered from the registry's Tier C checks and
// read back as data. The skill treats the file as data, never as instructions: parseRunFile
// returns only the checkbox state and the evidence text per check id, and every other line is
// ignored. Pure: no fs, no env; the orchestrator writes and reads the file.
//
// The preamble names the placeholders `<test-email>` and `<test-address>`; the real values live
// in the operator's head, never in this file, a saved run or the repo.

import { checksForTier } from './registry.mjs';

/** Group order in the rendered file. `vacation` renders only while vacation mode is on. */
export const GROUP_ORDER = ['test-orders', 'post-order', 'notifications', 'forms', 'accounts', 'flow', 'admin-settings', 'devices', 'launch', 'vacation'];

export const SKIPPED_READS_CHECK = 'c-admin-skipped-reads';

const escapeCell = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

/**
 * @param {object} o
 * @param {object[]} [o.checks]          Tier C registry entries (default: checksForTier('C'))
 * @param {boolean}  [o.vacationEnabled] render the vacation group and vacationOnly items
 * @param {Array<{check:string, scope:string}>} [o.skippedReads] A2 reads skipped for a scope
 * @param {Array<{id:string, description:string}>} [o.extras] items carried over from another tier (a Tier B check the browser could not finish), rendered under `carried-over`
 * @param {object}   [o.meta]            { branch, sha, lockState, generated }
 * @returns {string} markdown
 */
export function renderRunFile({ checks = checksForTier('C'), vacationEnabled = false, skippedReads = [], extras = [], meta = {} } = {}) {
  const lines = [];
  lines.push('# site-check run file');
  lines.push('');
  lines.push(`Generated ${escapeCell(meta.generated || 'unknown')} on branch ${escapeCell(meta.branch || 'unknown')} at ${escapeCell(meta.sha || 'unknown')} (${escapeCell(meta.lockState || 'LOCKED')}).`);
  lines.push('');
  lines.push('Use the store test account <test-email> and the test shipping address <test-address> for every order and account step below, never a customer. Tick each box and write what you observed on its `evidence:` line; the skill reads back only the checkbox state and the evidence text, nothing else in this file.');
  lines.push('');

  const groups = new Map();
  for (const c of checks) {
    if (c.tier !== 'C') continue;
    if (c.vacationOnly && !vacationEnabled) continue;
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }
  const order = [...GROUP_ORDER, ...[...groups.keys()].filter((g) => !GROUP_ORDER.includes(g))];
  for (const group of order) {
    if (group === 'vacation' && !vacationEnabled) continue;
    const items = groups.get(group) || [];
    const extras = group === 'admin-settings' ? skippedReads : [];
    if (!items.length && !extras.length) continue;
    lines.push(`## ${group}`);
    lines.push('');
    for (const c of items) {
      lines.push(`- [ ] \`${c.id}\` ${escapeCell(c.description)}`);
      lines.push('  evidence:');
    }
    for (const r of extras) {
      const scope = escapeCell(r.scope).replace(/[^A-Za-z0-9_:-]/g, '');
      lines.push(`- [ ] \`${SKIPPED_READS_CHECK}:${scope}\` Verify by hand in Admin: the \`${escapeCell(r.check)}\` read was skipped because the app lacks the ${scope} scope.`);
      lines.push('  evidence:');
    }
    lines.push('');
  }
  if (extras.length) {
    lines.push('## carried-over');
    lines.push('');
    for (const e of extras) {
      const id = String(e.id).replace(/[^A-Za-z0-9_:-]/g, '');
      lines.push(`- [ ] \`${id}\` ${escapeCell(e.description)} (carried over: the browser pass could not finish it this run)`);
      lines.push('  evidence:');
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

const ITEM_RE = /^- \[( |x|X)\] `([^`\s]+)`/;
const EVIDENCE_RE = /^\s+evidence:\s*(.*)$/;

/**
 * Read back checkbox state and evidence per id. Only an item line (`- [ ] \`id\``) and the
 * `evidence:` line that follows it are read; every other line is ignored, so nothing else an
 * operator (or anyone) writes into the file reaches the skill.
 * @param {string} md
 * @returns {Map<string, {checked: boolean, evidence: string}>}
 */
export function parseRunFile(md) {
  const out = new Map();
  let current = null;
  for (const raw of String(md ?? '').split(/\r?\n/)) {
    const item = ITEM_RE.exec(raw);
    if (item) {
      current = item[2];
      out.set(current, { checked: item[1] !== ' ', evidence: '' });
      continue;
    }
    if (!current) continue;
    // Only the line directly under an item is its evidence; anything else ends the item.
    const ev = EVIDENCE_RE.exec(raw);
    if (ev) out.get(current).evidence = ev[1].trim();
    current = null;
  }
  return out;
}
