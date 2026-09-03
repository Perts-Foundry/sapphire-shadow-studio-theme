// The EmailTemplate gid shape, proved rather than assumed.
//
// The incident: `GID_RE` was `[0-9]+` in two hand-typed copies, in classify.mjs and state.mjs, and
// a `sync` read all 46 Admin editors and was refused on every one, because Admin returns the
// template HANDLE (`gid://shopify/EmailTemplate/buy_online`). Both copies agreed with each other
// and every fixture in this suite encoded the same invented numeric gid, so nothing was ever red:
// it was a fixture-fidelity failure, not a coverage failure. Every wrong line was executed by a
// passing test.
//
// So this file does two things a parity test between the copies could not:
//   1. the positive corpus is the REAL ids from manifest.json, the committed source of truth, not
//      a literal anyone typed here. Narrowing `GID_RE` back to digits fails it immediately.
//   2. it asserts there IS no second copy: the shape lives in brand.mjs alone, and both callers
//      import it.
// And it couples the refusal MESSAGES to the regex, because a message describing a shape the regex
// no longer applies is what a human reads when 46 ids are refused, and it had already gone stale.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { GID_RE, GID_EXAMPLE, GID_EXPECTED, GID_HANDLE_RE_SOURCE, paths, REPO_ROOT } from '../brand.mjs';
import { GID_RE as CLASSIFY_GID_RE, parseObserved, ClassifyError } from '../classify.mjs';
import { validate, ID_RE } from '../state.mjs';
import { storedTemplateFromResponse } from '../verify-render.mjs';
import { MANIFEST_IDS, MANIFEST_GIDS, GID_CLASSES, ALL_LEGAL_GIDS, ILLEGAL_GIDS, NUMERIC_GID, gidFor, here } from './gid-fixtures.mjs';

const SHA = 'a'.repeat(40);

// --- the shape has one home ---------------------------------------------------------------------

test('GID_RE lives in brand.mjs and no other module defines a gid shape of its own', () => {
  // The deduplication is the fix, so this asserts the fix rather than the symptom: a pinned literal
  // here would have been a THIRD hand-typed copy of the shape, and if it were wrong all three would
  // agree and all three would be wrong, which is the incident's structure reproduced inside its own
  // regression test.
  assert.equal(CLASSIFY_GID_RE, GID_RE, 'classify.mjs re-exports brand.mjs\'s regex object, not a copy of it');
  // Recursive and not limited to .mjs, because browser/ holds the probes and a future subdirectory
  // would otherwise be outside the scan. The detector covers a regex literal, a RegExp built around
  // EmailTemplate, and a string-prefix test, which is the copy that looks least like a regex and so
  // is the one most likely to be written without noticing it is one.
  const offenders = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
        continue;
      }
      if (!/\.(mjs|js)$/.test(entry.name)) continue;
      const rel = path.relative(path.join(here, '..'), full);
      if (rel === 'brand.mjs') continue;
      const text = readFileSync(full, 'utf8');
      const defines =
        /\/\^?gid:\\?\/\\?\/shopify/.test(text) ||
        /new RegExp\([^)]*EmailTemplate/.test(text) ||
        /(startsWith|includes|indexOf)\(\s*['"`]gid:\/\/shopify/.test(text);
      if (defines) offenders.push(rel);
    }
  };
  walk(path.join(here, '..'));
  assert.deepEqual(
    offenders.filter((f) => !f.startsWith('test' + path.sep)),
    [],
    'a second copy of the gid shape is exactly the defect this file exists for; import brand.mjs\'s',
  );
});

test('the gid shape and its example agree with each other', () => {
  // Anchored on both sides and composed from the one handle pattern. `new RegExp` escapes the
  // slashes in `.source`, so this checks the two ends rather than a literal source string, and the
  // negative corpus below proves the anchoring behaviourally (the full-URL case is what an
  // unanchored regex would wave through).
  assert.ok(GID_RE.source.startsWith('^gid:'), GID_RE.source);
  assert.ok(GID_RE.source.endsWith(`${GID_HANDLE_RE_SOURCE}$`), GID_RE.source);
  assert.ok(GID_RE.test(GID_EXAMPLE), 'the documented example must be accepted by the regex that documents it');
  // Accepted by the regex is not enough. The example is the human-facing artifact of this whole
  // incident: a refusal message showing a NUMERIC id segment is what sent a reader looking for a
  // number that does not exist, and `gid://shopify/EmailTemplate/1234567890` would satisfy the
  // line above perfectly well. Pin it to a template that actually exists.
  assert.ok(
    MANIFEST_GIDS.includes(GID_EXAMPLE),
    `GID_EXAMPLE ${GID_EXAMPLE} names no template in manifest.json; the documented example must be a real handle`,
  );
  assert.ok(GID_EXPECTED.includes(GID_EXAMPLE));
  assert.ok(GID_EXPECTED.includes(GID_HANDLE_RE_SOURCE), 'the refusal names the actual handle pattern, not a prose paraphrase');
});

// --- the positive corpus, derived from the manifest ---------------------------------------------

test('the manifest is a usable corpus: 46-odd ids, every one handle-shaped', () => {
  assert.ok(MANIFEST_IDS.length >= 40, `only ${MANIFEST_IDS.length} manifest ids; this corpus is meant to be the whole set`);
  for (const id of MANIFEST_IDS) assert.ok(ID_RE.test(id), `${id} is not an id`);
  // Not one manifest id is numeric, which is why a numeric-only regex refused all 46 at once.
  assert.equal(MANIFEST_IDS.filter((id) => /^[0-9]+$/.test(id)).length, 0);
});

for (const { name, gids } of GID_CLASSES) {
  test(`GID_RE accepts ${name}`, () => {
    for (const gid of gids) assert.ok(GID_RE.test(gid), `${gid} must be accepted`);
  });
}

test('the narrowed shape this used to be rejects every real id: the incident, as an assertion', () => {
  // This is the mutation the acceptance criterion names. It is spelled out rather than left to a
  // reviewer's imagination, so the file states what it would catch and cannot quietly stop
  // catching it.
  const narrowed = /^gid:\/\/shopify\/EmailTemplate\/[0-9]+$/;
  for (const gid of MANIFEST_GIDS) assert.ok(!narrowed.test(gid), `${gid} would have been refused`);
  assert.equal(MANIFEST_GIDS.filter((g) => narrowed.test(g)).length, 0, 'all of them, which is what a full sync run reported');
  assert.ok(narrowed.test(NUMERIC_GID), 'and the one shape it did accept was the invented one every fixture used');
});

// --- both entry points, not just the exported regex ---------------------------------------------
// A regex that accepts a gid is not the same as a tool that accepts it: the run was refused by
// these two call sites, so these two are what the corpus has to run through.

test('classify.mjs accepts every legal gid on an observed row, in TSV and in both JSON shapes', () => {
  for (const gid of ALL_LEGAL_GIDS) {
    const id = MANIFEST_IDS[0];
    const [row] = parseObserved(`${id}\t120\tdeadbeef\tnone\t${gid}`);
    assert.equal(row.gid, gid, `TSV: ${gid}`);
    const [fromArray] = parseObserved(JSON.stringify([{ id, length: 120, fnv: 'deadbeef', gid }]));
    assert.equal(fromArray.gid, gid, `JSON array: ${gid}`);
    const [fromObject] = parseObserved(JSON.stringify({ [id]: { length: 120, fnv: 'deadbeef', gid } }));
    assert.equal(fromObject.gid, gid, `JSON object: ${gid}`);
  }
  // "-" is the reading that had no gid, and it is not a gid.
  assert.equal(parseObserved(`${MANIFEST_IDS[0]}\t120\tdeadbeef\tnone\t-`)[0].gid, null);
});

const stateWith = (gid) => ({
  schemaVersion: 2,
  store: 'my-store',
  seen: {},
  pending: [],
  lastAudit: null,
  auditRun: null,
  run: {
    startedAt: '2026-09-02T12:00:00Z',
    ref: 'origin/main',
    sha: SHA,
    onRenderFail: 'halt',
    batch: null,
    ids: [{ id: MANIFEST_IDS[0], match: 'unstamped-stock', beforeSource: 'stock', version: 1, gid, before: { length: 10, fnv: 'deadbeef' }, after: { length: 20, fnv: '01234567' } }],
    done: [],
    quarantine: [],
  },
});
const manifestIdSet = new Set(MANIFEST_IDS);

test('state.mjs validate accepts every legal gid in a run row, and null', () => {
  for (const gid of ALL_LEGAL_GIDS) {
    assert.doesNotThrow(() => validate(stateWith(gid), 'my-store', manifestIdSet), `${gid} must validate`);
  }
  assert.doesNotThrow(() => validate(stateWith(null), 'my-store', manifestIdSet));
});

test('a gid Admin actually returns survives the whole path: response, probe reading, plan row', () => {
  // The one place a gid enters the tools is data.emailTemplate.id in the EmailTemplate response,
  // which the probe logs on SSSSTORED and everything downstream reads. Run a real id through it.
  for (const id of [MANIFEST_IDS[0], MANIFEST_IDS.at(-1)]) {
    const gid = gidFor(id);
    const response = JSON.stringify({ data: { emailTemplate: { id: gid, bodyHtml: 'a body\n' } } });
    const stored = storedTemplateFromResponse(response);
    assert.equal(stored.gid, gid, 'the response parser takes the gid by JSON path, so it imposes no shape of its own');
    assert.ok(GID_RE.test(stored.gid), 'and what it hands back is accepted by the shape the tools check');
    const [row] = parseObserved(`${id}\t7\t${'0'.repeat(8)}\tnone\t${stored.gid}`);
    assert.equal(row.gid, gid);
    assert.doesNotThrow(() => validate(stateWith(gid), 'my-store', manifestIdSet));
  }
});

// --- the negative corpus ------------------------------------------------------------------------
// A regex widened to fix a false refusal is exactly when over-widening happens, so the widening is
// bounded from the other side too.

// The TSV reader trims each column and reads an empty one as "no gid", so a value that is only
// illegal because of surrounding whitespace, or that is empty, never reaches the shape check on
// that path. Those go in through the JSON shape, which is the other accepted input format, and the
// TSV path's own normalisation is asserted separately below rather than being papered over here.
const tsvNormalises = (gid) => gid === '' || gid !== gid.trim() || /[\n\r\t]/.test(gid);

for (const [name, gid] of ILLEGAL_GIDS) {
  test(`refuses ${name}: ${JSON.stringify(gid)}`, () => {
    assert.ok(!GID_RE.test(gid), 'GID_RE');
    const id = MANIFEST_IDS[0];
    const viaJson = () => parseObserved(JSON.stringify([{ id, length: 120, fnv: 'deadbeef', gid }]));
    if (tsvNormalises(gid)) {
      assert.throws(viaJson, ClassifyError, 'classify.mjs (JSON)');
    } else {
      assert.throws(() => parseObserved(`${id}\t120\tdeadbeef\tnone\t${gid}`), ClassifyError, 'classify.mjs (TSV)');
      assert.throws(viaJson, ClassifyError, 'classify.mjs (JSON)');
    }
    // And through state.mjs's validate, which sees a value rather than a column and so refuses
    // every one of them, the empty string and the padded forms included.
    assert.throws(() => validate(stateWith(gid), 'my-store', manifestIdSet), /run\.ids\[0\]\.gid/, 'state.mjs');
  });
}

test('a TSV gid column is trimmed, and an empty one means the reading had no gid', () => {
  // Real, deliberate behaviour of the observed format, stated so the negative corpus above is not
  // read as a gap: padding is normalised away on this path, and validate is what refuses a padded
  // value that reaches the state file some other way.
  const id = MANIFEST_IDS[0];
  const gid = MANIFEST_GIDS[0];
  assert.equal(parseObserved(`${id}\t120\tdeadbeef\tnone\t  ${gid}  `)[0].gid, gid);
  assert.equal(parseObserved(`${id}\t120\tdeadbeef\tnone\t`)[0].gid, null, 'an empty column is no gid, not a malformed one');
  assert.equal(parseObserved(`${id}\t120\tdeadbeef`)[0].gid, null, 'and an absent column likewise');
});

test('a gid for a template that is not this row\'s id is a format pass and a pairing failure', () => {
  // The format check is not the guard against pairing one template's response with another id;
  // before-doc.mjs's string equality is. Stated here so widening the regex is never read as
  // weakening that.
  const other = gidFor(MANIFEST_IDS[1]);
  assert.ok(GID_RE.test(other));
  const [row] = parseObserved(`${MANIFEST_IDS[0]}\t120\tdeadbeef\tnone\t${other}`);
  assert.equal(row.gid, other, 'accepted by shape');
  assert.notEqual(row.gid, gidFor(row.id), 'and caught downstream by --expect-gid, not here');
});

// --- the refusal messages -----------------------------------------------------------------------

const messageOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return String(err.message);
  }
  return assert.fail('expected a refusal');
};

test('both refusal messages name the accepted shape and the next action, and neither describes the old one', () => {
  const wrongResource = ILLEGAL_GIDS.find(([name]) => name === 'wrong resource')[1];
  const messages = {
    'classify.mjs': messageOf(() => parseObserved(`${MANIFEST_IDS[0]}\t120\tdeadbeef\tnone\t${wrongResource}`)),
    'state.mjs': messageOf(() => validate(stateWith(wrongResource), 'my-store', manifestIdSet)),
  };
  for (const [where, message] of Object.entries(messages)) {
    // The stale message is the artifact a human read when the run was refused for all 46 ids: it
    // said `<n>`, which described a numeric id segment and sent the reader looking for a number
    // that does not exist.
    assert.ok(!/EmailTemplate\/<n>/.test(message), `${where} still describes the numeric shape: ${message}`);
    assert.ok(!/<n>/.test(message), `${where} still carries an <n> placeholder: ${message}`);
    const placeholders = [...message.matchAll(/EmailTemplate\/<([^>]*)>/g)].map((m) => m[1]);
    for (const p of placeholders) assert.equal(p, 'handle', `${where} names the id segment ${JSON.stringify(p)}, not "handle"`);
    // One shared sentence, from one constant, so the two cannot describe different regexes.
    assert.ok(message.includes(GID_EXPECTED), `${where} does not carry the shared expected-shape sentence: ${message}`);
    // And the example inside it is itself accepted, so a widened regex cannot leave a stale one.
    const examples = [...GID_EXPECTED.matchAll(/gid:\/\/shopify\/EmailTemplate\/[a-zA-Z0-9_.-]+/g)].map((m) => m[0]);
    assert.ok(examples.length >= 1, 'the refusal carries no example gid at all');
    for (const example of examples) assert.ok(GID_RE.test(example), `the example ${example} in the refusal is not accepted by GID_RE`);
    assert.ok(/"-"|null/.test(message), `${where} does not say what to pass when a reading had no gid: ${message}`);
  }
});

test('no tracked source or skill file still describes the gid as EmailTemplate/<n>', () => {
  // Every other site that encodes the shape, enumerated rather than assumed: the two callers, the
  // probe (which takes the gid by JSON path and imposes no pattern), and the prose that tells an
  // operator what to expect. A doc-surface grep is diff-scoped in review, so it lives here too.
  const roots = [
    path.join(here, '..'),
    path.join(REPO_ROOT, '.claude', 'skills', 'notification-templates'),
    // The README is the operator-facing half of the same explanation, so it is swept too.
    path.join(REPO_ROOT, 'marketing', 'notifications'),
  ];
  const offenders = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (!/\.(mjs|js|md)$/.test(name)) continue;
      const file = path.join(root, name);
      const text = readFileSync(file, 'utf8');
      if (/EmailTemplate\/<n>/.test(text)) offenders.push(path.relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], 'these describe the id segment as a number, which is what sent a run looking for one');
});

test('every gid-shaped literal in this suite comes from gid-fixtures.mjs', () => {
  // The guard that keeps the corpus from being bypassed. A test file with its own invented gid is
  // how the monoculture formed in the first place, so a new one fails here rather than sitting
  // green for another year.
  const dir = here;
  const allowed = new Set(['gid-fixtures.mjs']);
  const offenders = [];
  for (const name of readdirSync(dir)) {
    if (!/\.(mjs|js)$/.test(name) || allowed.has(name)) continue;
    const text = readFileSync(path.join(dir, name), 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      // A literal gid string, as opposed to one built from a fixture, a template on `id`, or the
      // regex source itself. `gidFor(...)` and the imported constants are the sanctioned routes.
      if (!/gid:\/\/shopify\//.test(line)) continue;
      if (line.trim().startsWith('//')) continue;
      if (/gid:\/\/shopify\/EmailTemplate\/\$\{/.test(line)) continue;
      if (/GID_RE|GID_EXPECTED|GID_EXAMPLE|matchAll|\.source/.test(line)) continue;
      offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'take these from gid-fixtures.mjs (gidFor, MANIFEST_GIDS, NUMERIC_GID, ILLEGAL_GIDS) instead');
});
