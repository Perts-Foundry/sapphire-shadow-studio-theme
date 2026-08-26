import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PATHS_FILE } from '../build-pa11yci.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const paths = JSON.parse(readFileSync(PATHS_FILE, 'utf8'));
const entries = paths.paths;

test('every product template has an audited path', () => {
  // THE coverage assertion. Adding templates/product.new-thing.json without an
  // entry here would ship a page nothing ever audits, and nothing else in CI
  // would notice.
  const templates = readdirSync(join(REPO_ROOT, 'templates'))
    .filter((f) => /^product\..+\.json$/.test(f))
    .map((f) => `templates/${f}`);
  assert.ok(templates.length > 0, 'expected product templates to exist');
  const covered = new Set(entries.map((e) => e.template));
  for (const template of templates) {
    assert.ok(covered.has(template), `${template} has no entry in paths.json`);
  }
});

test('every JSON template in the theme is represented', () => {
  // Same rule, widened past products: a template with no audited page is a
  // blind spot, and the list is only trustworthy if it is exhaustive.
  const templates = readdirSync(join(REPO_ROOT, 'templates'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => `templates/${f}`)
    // password.json renders only while the storefront is locked AND unauthed,
    // which is precisely the state the audit authenticates out of.
    // article.json needs a published article; the blog has none (see the
    // noindex guard in snippets/meta-tags.liquid).
    .filter((f) => !['templates/password.json', 'templates/article.json'].includes(f));
  const covered = new Set(entries.map((e) => e.template));
  const uncovered = templates.filter((t) => !covered.has(t));
  assert.deepEqual(uncovered, [], 'templates with no audited path');
});

test('every declared template exists on disk', () => {
  // The other direction of the same contract. The two tests above walk
  // templates/ and assert each file is claimed; this one walks the claims and
  // asserts each names a real file, so deleting a template cannot leave an
  // entry pointing at nothing while every test stays green.
  for (const entry of entries) {
    if (entry.template === null) continue;
    assert.ok(existsSync(join(REPO_ROOT, entry.template)), `${entry.path} claims a missing ${entry.template}`);
  }
});

test('entries are well formed', () => {
  assert.ok(entries.length >= 15, `expected broad coverage, got ${entries.length}`);
  for (const entry of entries) {
    assert.ok(entry.path.startsWith('/'), `${entry.path} must be root-relative`);
    assert.ok(typeof entry.label === 'string' && entry.label.length > 0, `${entry.path} needs a label`);
    assert.ok('template' in entry, `${entry.path} must declare its template (null for Shopify-rendered)`);
    // A fully-qualified URL here would silently escape the preview theme pin.
    assert.ok(!/^https?:/.test(entry.path), `${entry.path} must not be absolute`);
  }
});

test('paths are unique', () => {
  const seen = entries.map((e) => e.path);
  assert.equal(new Set(seen).size, seen.length, 'a duplicate path wastes a run and skews the count');
});

test('no path carries its own preview_theme_id', () => {
  // build-pa11yci.mjs sets it; a hand-written one would be overwritten and is a
  // sign someone pinned a stale theme by hand.
  for (const entry of entries) assert.ok(!entry.path.includes('preview_theme_id'), entry.path);
});

test('the explanatory comment survives', () => {
  // paths.json is edited by hand whenever a product handle changes; the
  // reasoning for that has to stay attached to the file.
  assert.ok(Array.isArray(paths._comment) && paths._comment.join(' ').length > 200);
});
