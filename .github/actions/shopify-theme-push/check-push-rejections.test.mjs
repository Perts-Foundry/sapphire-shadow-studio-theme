// Unit tests for check-push-rejections.mjs.
//
// The fixtures are shaped from the real @shopify/cli 4.5.2 `theme push --json`
// contract (see the header comment in check-push-rejections.mjs): a clean push
// emits `{ theme: { id, name, role, shop, editor_url, preview_url } }`, and a
// push with rejected assets adds `theme.warning` plus `theme.errors`, keyed by
// filename with an array of Shopify's reason strings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkFile,
  findRejections,
  formatRejectionReport,
  sanitizeMessage,
} from './check-push-rejections.mjs';

const CLEAN = {
  theme: {
    id: 123456789012,
    name: 'pr-69-preview',
    role: 'unpublished',
    shop: 'example.myshopify.com',
    editor_url: 'https://admin.shopify.com/store/example/themes/123456789012/editor',
    preview_url: 'https://example.myshopify.com/?preview_theme_id=123456789012',
  },
};

// The exact incident: templates/index.json carried autoplay_speed 2 while the
// section schema stored on the theme declared "min": 3.
const REJECTED = {
  theme: {
    ...CLEAN.theme,
    warning: "The theme 'pr-69-preview' was pushed with errors",
    errors: {
      'templates/index.json': ["Setting 'autoplay_speed' can't be less than 3"],
    },
  },
};

function writeFixture(value) {
  const dir = mkdtempSync(join(tmpdir(), 'push-report-'));
  const path = join(dir, 'push.json');
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

test('clean push reports no rejections', () => {
  const result = findRejections(CLEAN);
  assert.equal(result.rejected, false);
  assert.deepEqual(result.files, []);
  assert.equal(result.warning, null);
});

test('clean push exits 0 and stays silent', () => {
  const lines = [];
  const code = checkFile(writeFixture(CLEAN), (l) => lines.push(l));
  assert.equal(code, 0);
  assert.deepEqual(lines, [], 'a good deploy must not be made noisy');
});

test('rejected asset is detected with file and reason', () => {
  const result = findRejections(REJECTED);
  assert.equal(result.rejected, true);
  assert.deepEqual(result.files, [
    {
      file: 'templates/index.json',
      messages: ["Setting 'autoplay_speed' can't be less than 3"],
    },
  ]);
});

test('rejected asset exits 1 and names the file and the reason', () => {
  const lines = [];
  const code = checkFile(writeFixture(REJECTED), (l) => lines.push(l));
  assert.equal(code, 1);
  const text = lines.join('\n');
  assert.match(text, /^::error::Shopify rejected 1 asset/m);
  assert.match(text, /::error file=templates\/index\.json::Setting 'autoplay_speed' can't be less than 3/);
  assert.match(text, /^ {2}templates\/index\.json: Setting 'autoplay_speed' can't be less than 3$/m);
});

test('warning without a per-file errors map still fails', () => {
  // Defensive: the CLI populates `errors` only for failures carrying a
  // per-asset message. A warning alone must not degrade to a silent pass.
  const result = findRejections({
    theme: { ...CLEAN.theme, warning: "The theme 'x' was pushed with errors" },
  });
  assert.equal(result.rejected, true);
  assert.deepEqual(result.files, []);
  const text = formatRejectionReport(result).join('\n');
  assert.match(text, /was pushed with errors/);
});

test('multiple rejected files are all listed', () => {
  const result = findRejections({
    theme: {
      ...CLEAN.theme,
      warning: 'pushed with errors',
      errors: {
        'templates/index.json': ["Setting 'autoplay_speed' can't be less than 3"],
        'templates/product.json': ['Invalid section type', 'Unknown setting'],
      },
    },
  });
  assert.equal(result.files.length, 2);
  const text = formatRejectionReport(result).join('\n');
  assert.match(text, /templates\/product\.json: Invalid section type/);
  assert.match(text, /templates\/product\.json: Unknown setting/);
});

test('mass rejection is capped and the remainder counted', () => {
  const errors = {};
  for (let i = 0; i < 25; i++) errors[`templates/page.t${i}.json`] = ['nope'];
  const result = findRejections({ theme: { ...CLEAN.theme, errors } });
  assert.equal(result.files.length, 20);
  assert.equal(result.truncated, 5);
  assert.match(formatRejectionReport(result).join('\n'), /and 5 more rejected file\(s\)/);
});

test('unparseable report exits 2 so the caller can diagnose it', () => {
  const lines = [];
  const code = checkFile(writeFixture('Uploading files to remote theme [0%]'), (l) => lines.push(l));
  assert.equal(code, 2);
});

test('missing report exits 2 rather than throwing', () => {
  const code = checkFile('/nonexistent/push.json', () => {});
  assert.equal(code, 2);
});

test('a report with no theme object is treated as clean', () => {
  // `require_json` in action.yml owns shape validation; this must not throw.
  assert.equal(findRejections({}).rejected, false);
  assert.equal(findRejections(null).rejected, false);
  assert.equal(findRejections([]).rejected, false);
});

test('sanitizeMessage strips ANSI and control characters', () => {
  const esc = String.fromCharCode(0x1b);
  assert.equal(sanitizeMessage(`${esc}[31mboom${esc}[0m`), 'boom');
  assert.equal(sanitizeMessage(`a${String.fromCharCode(0x07)}b`), 'a b');
});

test('sanitizeMessage redacts token-shaped strings', () => {
  // Assembled at runtime rather than written as a literal: a literal
  // `shpat_` + 32 hex chars is exactly the shape Gitleaks flags, and the
  // secret-scan job should not have to special-case a test fixture.
  const fake = ['shpat', '_', 'abcdef0123456789'.repeat(2)].join('');
  const out = sanitizeMessage(`failed with ${fake}`);
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /abcdef0123456789/);
});

test('sanitizeMessage truncates a runaway message', () => {
  const out = sanitizeMessage('x'.repeat(1000));
  assert.ok(out.length <= 303, `expected truncation, got ${out.length}`);
  assert.match(out, /\.\.\.$/);
});

test('annotation metacharacters are escaped', () => {
  const result = findRejections({
    theme: { ...CLEAN.theme, errors: { 'templates/index.json': ['100% wrong'] } },
  });
  const annotation = formatRejectionReport(result).find((l) => l.startsWith('::error file='));
  assert.match(annotation, /100%25 wrong/);
});
