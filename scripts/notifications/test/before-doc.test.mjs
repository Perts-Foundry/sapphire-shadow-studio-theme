// scripts/notifications/before-doc.mjs produces the document a failed render is restored from.
// Its whole value is the refusal: a restore source that is not what Admin held is worse than no
// restore source, so nothing is written unless the bytes hash to the approved before-numbers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fnv1a } from '../dump.mjs';
import { paths } from '../brand.mjs';
import { beforeDoc, BeforeDocError } from '../before-doc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'before-doc.mjs');

const STOCK = 'stock alpha\nwith two lines\n';
const EXPECT = { length: STOCK.length, hash: fnv1a(STOCK) };

function root() {
  const r = mkdtempSync(path.join(tmpdir(), 'ssb-before-'));
  const p = paths(r);
  mkdirSync(p.stockDir, { recursive: true });
  writeFileSync(p.manifest, JSON.stringify({ templates: { alpha: { version: 1 } } }), 'utf8');
  writeFileSync(p.branded('alpha'), 'branded alpha\n', 'utf8');
  writeFileSync(p.stock('alpha'), STOCK, 'utf8');
  return r;
}

const GID = 'gid://shopify/EmailTemplate/1234567890';
const OTHER_GID = 'gid://shopify/EmailTemplate/999';
const response = (bodyHtml, id = GID) => JSON.stringify({ data: { emailTemplate: id === null ? { bodyHtml } : { id, bodyHtml } } });

test('--from-stock returns the recorded snapshot when it hashes to the approved numbers', () => {
  const r = root();
  const got = beforeDoc({ fromStock: 'alpha', expect: EXPECT, root: r });
  assert.equal(got.text, STOCK);
  assert.equal(got.length, EXPECT.length);
  assert.equal(got.hash, EXPECT.hash);
});

test('--from-response reads data.emailTemplate.bodyHtml, and normalises CRLF before hashing', () => {
  const r = root();
  const file = path.join(r, 'resp.json');
  writeFileSync(file, response(STOCK.replace(/\n/g, '\r\n')), 'utf8');
  const got = beforeDoc({ fromResponse: file, expect: EXPECT, root: r });
  assert.equal(got.text, STOCK, 'the stored body is compared on LF, the same contract the probe uses');
});

test('a mismatch is refused with both numbers, and names what it means', () => {
  const r = root();
  for (const bad of [{ length: EXPECT.length + 1, hash: EXPECT.hash }, { length: EXPECT.length, hash: '00000000' }]) {
    assert.throws(() => beforeDoc({ fromStock: 'alpha', expect: bad, root: r }), BeforeDocError);
    assert.throws(() => beforeDoc({ fromStock: 'alpha', expect: bad, root: r }), /Admin changed since the read pass.*Do not paste/s);
  }
});

test('refuses a document that is not usable as a paste source at all', () => {
  const r = root();
  const file = path.join(r, 'resp.json');
  const cases = [
    ['﻿stock alpha\n', /BOM/],
    ['', /no data.emailTemplate.bodyHtml/],
    ['contains �\n', /U\+FFFD/],
  ];
  for (const [body, re] of cases) {
    writeFileSync(file, response(body), 'utf8');
    assert.throws(() => beforeDoc({ fromResponse: file, expect: { length: 99, hash: 'deadbeef' }, root: r }), re, JSON.stringify(body));
  }
  writeFileSync(file, JSON.stringify({ data: { emailTemplateGeneratePreview: { preview: { bodyHtml: '<p>rendered</p>' } } } }), 'utf8');
  assert.throws(() => beforeDoc({ fromResponse: file, expect: EXPECT, root: r }), /no data.emailTemplate.bodyHtml/, 'a preview response is a rendered document, never the stored one');
});

test('--expect-gid refuses a response for another template, however well its bytes match', () => {
  const r = root();
  const file = path.join(r, 'resp.json');
  // The request URL names no template: its variables are opaque. So without the gid, a response
  // saved from another template's in-flight request is accepted whenever the bytes happen to
  // match, and the restore file is then that other template's body.
  writeFileSync(file, response(STOCK, OTHER_GID), 'utf8');
  assert.throws(() => beforeDoc({ fromResponse: file, expect: EXPECT, expectGid: GID, root: r }), BeforeDocError);
  assert.throws(
    () => beforeDoc({ fromResponse: file, expect: EXPECT, expectGid: GID, root: r }),
    /is the response for gid:\/\/shopify\/EmailTemplate\/999, not gid:\/\/shopify\/EmailTemplate\/1234567890.*do not paste or restore from it/s,
  );
  assert.equal(beforeDoc({ fromResponse: file, expect: EXPECT, expectGid: OTHER_GID, root: r }).text, STOCK, 'the matching gid is accepted');
  assert.equal(beforeDoc({ fromResponse: file, expect: EXPECT, root: r }).text, STOCK, 'and the check is skipped when no gid is expected');
  // A response with no gid at all cannot satisfy the check, so it is refused rather than waved
  // through: the point of asking is to know which template answered.
  writeFileSync(file, response(STOCK, null), 'utf8');
  assert.throws(() => beforeDoc({ fromResponse: file, expect: EXPECT, expectGid: GID, root: r }), /carries no data.emailTemplate.id/);
});

test('--from-stock is validated as an id and against the manifest before it reaches a path join', () => {
  const r = root();
  // The same rule state.mjs applies to every id it stores. An id reaches a path join here and a
  // navigation URL there, so it is never taken on trust because a caller passed it.
  for (const bad of ['../../etc/passwd', 'Alpha', 'alpha.liquid', '']) {
    assert.throws(() => beforeDoc({ fromStock: bad, expect: EXPECT, root: r }), /is not an id|exactly one of/, JSON.stringify(bad));
  }
  assert.throws(() => beforeDoc({ fromStock: 'gamma', expect: EXPECT, root: r }), /gamma is not in the manifest/);
});

test('the hash contract holds over astral, CRLF and non-ASCII bodies, the same inputs the probe is proven on', () => {
  const r = root();
  const file = path.join(r, 'resp.json');
  for (const sample of ['caf\u00e9 \u2019   \u{1F9F5} \u00a9\n', 'line one\r\nline two\rthree\n', '{{ shop.name }}\n'.repeat(700)]) {
    const lf = sample.replace(/\r\n?/g, '\n');
    writeFileSync(file, response(sample), 'utf8');
    const got = beforeDoc({ fromResponse: file, expect: { length: lf.length, hash: fnv1a(lf) }, root: r });
    assert.equal(got.text, lf, JSON.stringify(sample.slice(0, 12)));
    assert.equal(got.length, lf.length, 'length is UTF-16 code units, as the probe counts them');
  }
});

test('the two sources are exclusive, and the expected numbers are required', () => {
  const r = root();
  assert.throws(() => beforeDoc({ expect: EXPECT, root: r }), /exactly one of --from-stock and --from-response/);
  assert.throws(() => beforeDoc({ fromStock: 'alpha', fromResponse: 'x', expect: EXPECT, root: r }), /exactly one of --from-stock and --from-response/);
  assert.throws(() => beforeDoc({ fromStock: 'alpha', expect: { length: 0, hash: EXPECT.hash }, root: r }), /--expect-length must be a positive integer/);
  assert.throws(() => beforeDoc({ fromStock: 'alpha', expect: { length: 5, hash: 'NOTHEX00' }, root: r }), /--expect-fnv must be eight lowercase hex digits/);
});

test('CLI: writes the file on a match, writes nothing and exits 1 on a mismatch', () => {
  const r = root();
  const out = path.join(r, 'before-alpha.liquid');
  const run = (...args) => spawnSync(process.execPath, [script, '--root', r, '--out', out, ...args], { encoding: 'utf8' });
  let res = run('--from-stock', 'alpha', '--expect-length', String(EXPECT.length), '--expect-fnv', EXPECT.hash);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(out, 'utf8'), STOCK);
  assert.match(res.stdout, new RegExp(`^${EXPECT.length} ${EXPECT.hash} -> `));

  const out2 = path.join(r, 'never-written.liquid');
  res = spawnSync(process.execPath, [script, '--root', r, '--out', out2, '--from-stock', 'alpha', '--expect-length', '1', '--expect-fnv', EXPECT.hash], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.equal(existsSync(out2), false, 'a refused source leaves no file behind to be pasted by mistake');
  assert.equal(run().status, 2, 'no arguments prints the usage');

  // The response path is the one roughly 40 of the 46 ids take, so it is exercised at CLI level
  // too, gid check and all.
  const resp = path.join(r, 'resp.json');
  writeFileSync(resp, response(STOCK), 'utf8');
  const out3 = path.join(r, 'from-response.liquid');
  res = spawnSync(
    process.execPath,
    [script, '--root', r, '--out', out3, '--from-response', resp, '--expect-length', String(EXPECT.length), '--expect-fnv', EXPECT.hash, '--expect-gid', GID],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(out3, 'utf8'), STOCK);
  const out4 = path.join(r, 'wrong-gid.liquid');
  res = spawnSync(
    process.execPath,
    [script, '--root', r, '--out', out4, '--from-response', resp, '--expect-length', String(EXPECT.length), '--expect-fnv', EXPECT.hash, '--expect-gid', OTHER_GID],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 1);
  assert.equal(existsSync(out4), false);
});
