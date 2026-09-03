#!/usr/bin/env node
// Assert what the LIVE policies say, after a push.
//
// `policies:pull --check` is a TAUTOLOGY here: a successful push already reconciled the repo with
// Admin, so it comes back clean whether the intended wording landed or not. This asserts the
// sentences instead, against the live body, and prints the exact diff between what the repo holds
// and what Admin stored so a renormalisation is visible rather than inferred.
//
//   node scripts/policies/verify-live.mjs
//
// Read-only: it goes through the read-only client, which refuses a mutation before the network.

import { readFileSync } from 'node:fs';

import { createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { createReadOnlyClient } from '../site-check/lib/admin-readonly.mjs';
import { paths, REPO_ROOT } from './check.mjs';
import { POLICIES_QUERY } from './pull.mjs';
import { unifiedDiff } from './lib/diff.mjs';
import { bodyFromFileText, canonicalise, sha256 } from './lib/policies.mjs';

/** What each pushed policy must, and must not, say. Positive and NEGATIVE both matter. */
const ASSERTIONS = {
  // Each string must DISCRIMINATE: satisfied only by the new wording, not incidentally by the old.
  // "7–10 business days" alone would not qualify, because the OLD table used it as the Economy
  // total; the peak-season phrase is quoted with its surrounding markup instead. Likewise the old
  // table rows are the negatives, not a bare duration that appears in both versions.
  SHIPPING_POLICY: {
    must: [
      'Most orders ship within <strong>3–5 business days</strong>',
      'production time increases to <strong>7–10 business days</strong>',
      'Nurses Week',
      'If we need to check a detail with you, production pauses',
      'orders of four or more items may add 1–2 business days',
      '<td>8–13 business days</td>',
      '<td>4–7 business days</td>',
      'Every piece is embroidered to order, one at a time',
    ],
    mustNot: [
      '<td>2 business days</td>',
      '<td>7–10 business days</td>',
      '<td>3–4 business days</td>',
      'may extend by 3–5 additional business days',
      'ready to ship within <strong>2 business days</strong>',
    ],
  },
  CONTACT_INFORMATION: {
    must: ['Contact Us'],
    mustNot: ['font-claude-response-body', 'break-words', 'whitespace-normal', 'leading-[1.7]'],
  },
};

const client = createReadOnlyClient(createAdminClient());
const rows = (await client.gql(POLICIES_QUERY)).shop.shopPolicies;

let failed = 0;
for (const [type, { must, mustNot }] of Object.entries(ASSERTIONS)) {
  const live = canonicalise(rows.find((r) => r.type === type).body);
  const repo = bodyFromFileText(readFileSync(paths(REPO_ROOT).file(type), 'utf8'));
  console.log(`\n=== ${type} ===`);
  for (const s of must) {
    const ok = live.includes(s);
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  live contains ${JSON.stringify(s)}`);
  }
  for (const s of mustNot) {
    const ok = !live.includes(s);
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  live does NOT contain ${JSON.stringify(s)}`);
  }
  if (sha256(live) === sha256(repo)) {
    console.log('  PASS  live is byte-identical to the repo copy (Shopify stored it verbatim)');
  } else {
    failed++;
    console.log(`  FAIL  live differs from the repo copy (live ${sha256(live).slice(0, 12)}, repo ${sha256(repo).slice(0, 12)})`);
    console.log(unifiedDiff(repo, live, { aLabel: 'repo', bLabel: 'live' }));
  }
}

console.log(failed === 0 ? '\nverify-live: all assertions passed' : `\nverify-live: ${failed} assertion(s) FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
