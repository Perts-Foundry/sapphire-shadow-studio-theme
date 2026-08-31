// node --test unit tests for report-format.mjs. Pure functions, no I/O,
// no fetch/sleep mocking needed (unlike smoke.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSmokeMarkdownTable, formatLiveThemeRow, formatLastDeployRow } from './report-format.mjs';

const THEME = '181702754604';
const HOST = 'sapphireshadowstudio.com';

test('renderSmokeMarkdownTable: PASS-only run', () => {
  const output = [
    `/ PASS 200 host=${HOST} theme=${THEME} (ok)`,
    `/cart PASS 200 host=${HOST} theme=${THEME} (ok)`,
  ].join('\n');
  const { summaryLine, markdown } = renderSmokeMarkdownTable(output);
  assert.equal(summaryLine, '2 passed, 0 warned, 0 failed');
  assert.match(markdown, /\| :white_check_mark: \| `\/` \| 200 \| 181702754604 \| ok \|/);
  assert.match(markdown, /\| :white_check_mark: \| `\/cart` \| 200 \| 181702754604 \| ok \|/);
});

test('renderSmokeMarkdownTable: a HARD-FAIL row is counted and badged', () => {
  const output = [
    `/ PASS 200 host=${HOST} theme=${THEME} (ok)`,
    `/products/x HARD-FAIL 404 host=${HOST} theme=- (product unavailable)`,
  ].join('\n');
  const { summaryLine, markdown } = renderSmokeMarkdownTable(output);
  assert.equal(summaryLine, '1 passed, 0 warned, 1 failed');
  assert.match(markdown, /\| :x: \| `\/products\/x` \| 404 \| - \| product unavailable \|/);
});

test('renderSmokeMarkdownTable: a per-row SOFT-WARN (throttled probe) increments the warned bucket', () => {
  const output = `/products/y SOFT-WARN 429 host=${HOST} theme=- (throttled (429 after retries))`;
  const { summaryLine, markdown } = renderSmokeMarkdownTable(output);
  assert.equal(summaryLine, '0 passed, 1 warned, 0 failed');
  assert.match(markdown, /\| :warning: \| `\/products\/y` \| 429 \| - \| throttled \(429 after retries\) \|/);
});

test('renderSmokeMarkdownTable: aggregate SOFT-WARN lines land in notes, not rows, but still count', () => {
  // The literals here are copied from smoke.mjs's current output; if that text drifts, the
  // aggregate-counting assertion below is what notices.
  const output = [
    `/ PASS 200 host=${HOST} theme=${THEME} (ok)`,
    'sitemap SOFT-WARN: product enumeration skipped (sitemap lists no products); probing structural routes only',
    'products SOFT-WARN: time budget reached; 5 product(s) unprobed',
  ].join('\n');
  const { summaryLine, markdown } = renderSmokeMarkdownTable(output);
  // Rendered as notes (they carry no status/host/theme), but counted, so the tally matches what
  // the run actually reported.
  assert.equal(summaryLine, '1 passed, 2 warned, 0 failed');
  assert.match(markdown, /> sitemap SOFT-WARN: product enumeration skipped/);
  assert.match(markdown, /> products SOFT-WARN: time budget reached; 5 product\(s\) unprobed/);
  assert.doesNotMatch(markdown, /\| .* `sitemap` .* \|/, 'never a table row');
});

test('renderSmokeMarkdownTable: an aggregate HARD-FAIL is counted, so exit 1 never reads "0 failed"', () => {
  // The regression this guards: before the smoke gained a zero-product-coverage HARD-FAIL, every
  // aggregate line was a SOFT-WARN, so leaving them uncounted happened to be accurate. Both of
  // these exit 1 on their own, and the summary sits directly above a failed deploy.
  for (const line of [
    'sitemap HARD-FAIL: product enumeration failed (sitemap index unreachable after 4 attempt(s)); zero product coverage. Likely Shopify-side weather; re-run with a `deploy` comment when it clears. The theme is already live on this SHA.',
    'products HARD-FAIL: the time budget was exhausted before any of the 12 enumerated product(s) was probed; zero product coverage. Raise SMOKE_MAX_SECONDS or lower SMOKE_MAX_PRODUCTS. The theme is already live on this SHA.',
  ]) {
    const output = [`/ PASS 200 host=${HOST} theme=${THEME} (ok)`, line].join('\n');
    const { summaryLine } = renderSmokeMarkdownTable(output);
    assert.equal(summaryLine, '1 passed, 0 warned, 1 failed', line);
  }
});

test('renderSmokeMarkdownTable: a note that merely mentions a verdict is not counted', () => {
  const output = [
    `/ PASS 200 host=${HOST} theme=${THEME} (ok)`,
    'retries: 2 retried, 1 exhausted (HARD-FAIL thresholds unchanged)',
  ].join('\n');
  const { summaryLine } = renderSmokeMarkdownTable(output);
  assert.equal(summaryLine, '1 passed, 0 warned, 0 failed');
});

test('renderSmokeMarkdownTable: an all-notes run (zero table rows) still surfaces the notes instead of reading falsely empty', () => {
  const output = [
    '/password AUTH SOFT-WARN: could not establish session (throttled; content probing skipped)',
    '/password HARD-FAIL - AUTH: password provided but the gate refused it (rotated or wrong secret); content coverage would be lost',
  ].join('\n');
  const { summaryLine, markdown } = renderSmokeMarkdownTable(output);
  // Both auth-branch shapes count: `<path> AUTH SOFT-WARN:` and `<path> HARD-FAIL - AUTH:`. The
  // second exits 1, so it is the one that must never be summarised as "0 failed".
  assert.equal(summaryLine, '0 passed, 1 warned, 1 failed');
  assert.match(markdown, /_No per-path results parsed\._/);
  assert.match(markdown, /> \/password AUTH SOFT-WARN: could not establish session/);
  assert.match(markdown, /> \/password HARD-FAIL - AUTH: password provided but the gate refused it/);
});

test('renderSmokeMarkdownTable: a malformed/near-miss line (missing theme=) falls to notes without throwing', () => {
  const output = `/weird PASS 200 host=${HOST} (ok)`;
  assert.doesNotThrow(() => renderSmokeMarkdownTable(output));
  const { summaryLine, markdown } = renderSmokeMarkdownTable(output);
  assert.equal(summaryLine, '0 passed, 0 warned, 0 failed');
  assert.match(markdown, /> \/weird PASS 200 host=sapphireshadowstudio\.com \(ok\)/);
});

test('renderSmokeMarkdownTable: a pipe character in a reason string is escaped, not left to corrupt the table', () => {
  const output = `/products/z HARD-FAIL 302 host=${HOST} theme=- (cross-host redirect to evil|example.com)`;
  const { markdown } = renderSmokeMarkdownTable(output);
  assert.match(markdown, /cross-host redirect to evil\\\|example\.com/);
  // Exactly six unescaped pipes in the row (the 5-column table's delimiters),
  // not seven+: proves the embedded pipe didn't add a phantom column.
  const row = markdown.split('\n').find((l) => l.includes('cross-host'));
  const unescapedPipes = row.replace(/\\\|/g, '').match(/\|/g) || [];
  assert.equal(unescapedPipes.length, 6);
});

test('renderSmokeMarkdownTable: empty string input', () => {
  const { summaryLine, markdown } = renderSmokeMarkdownTable('');
  assert.equal(summaryLine, '0 passed, 0 warned, 0 failed');
  assert.equal(markdown, '_No per-path results parsed._');
});

test('renderSmokeMarkdownTable: undefined input (highest-risk failure-report call site) never throws', () => {
  assert.doesNotThrow(() => renderSmokeMarkdownTable(undefined));
  const { summaryLine, markdown } = renderSmokeMarkdownTable(undefined);
  assert.equal(summaryLine, '0 passed, 0 warned, 0 failed');
  assert.equal(markdown, '_No per-path results parsed._');
});

test('renderSmokeMarkdownTable: a mixed run combines rows and notes correctly', () => {
  const output = [
    `/ PASS 200 host=${HOST} theme=${THEME} (ok)`,
    `/cart PASS 200 host=${HOST} theme=${THEME} (ok)`,
    `/products/a SOFT-WARN 429 host=${HOST} theme=- (throttled (429 after retries))`,
    `/products/b HARD-FAIL 404 host=${HOST} theme=- (product unavailable)`,
    'sitemap SOFT-WARN: product enumeration skipped (sitemap lists no products); probing structural routes only',
  ].join('\n');
  const { summaryLine, markdown } = renderSmokeMarkdownTable(output);
  assert.equal(summaryLine, '2 passed, 2 warned, 1 failed');
  assert.match(markdown, /:white_check_mark:.*`\/`/);
  assert.match(markdown, /:warning:.*`\/products\/a`/);
  assert.match(markdown, /:x:.*`\/products\/b`/);
  assert.match(markdown, /> sitemap SOFT-WARN/);
});

test('formatLiveThemeRow: all fields populated', () => {
  const row = formatLiveThemeRow({
    liveThemeName: 'Live deployed from GitHub PRs',
    liveThemeId: THEME,
  });
  assert.equal(row, '`Live deployed from GitHub PRs` (ID `181702754604`)');
});

test('formatLiveThemeRow: name missing falls back gracefully', () => {
  const row = formatLiveThemeRow({ liveThemeId: THEME });
  assert.equal(row, 'unknown (ID `181702754604`)');
});

test('formatLastDeployRow: all fields populated', () => {
  const row = formatLastDeployRow({
    lastDeploySha: 'f443ce0',
    lastDeployMsg: 'Add, test, white space (#58)',
    lastDeployDate: '2026-07-18T13:03:00Z',
  });
  assert.equal(row, '`f443ce0`: Add, test, white space (#58) (2026-07-18T13:03:00Z)');
});

test('formatLastDeployRow: no marker found (all fields missing)', () => {
  const row = formatLastDeployRow({});
  assert.equal(row, '_no marker found_');
});

test('formatLastDeployRow: sha present, message/date missing falls back per-field', () => {
  const row = formatLastDeployRow({ lastDeploySha: 'f443ce0' });
  assert.equal(row, '`f443ce0`: no commit message (unknown date)');
});

test('formatLastDeployRow: message present, date missing', () => {
  const row = formatLastDeployRow({ lastDeploySha: 'f443ce0', lastDeployMsg: 'Fix theme.liquid' });
  assert.equal(row, '`f443ce0`: Fix theme.liquid (unknown date)');
});

test('formatLastDeployRow: date present, message missing', () => {
  const row = formatLastDeployRow({ lastDeploySha: 'f443ce0', lastDeployDate: '2026-07-18T13:03:00Z' });
  assert.equal(row, '`f443ce0`: no commit message (2026-07-18T13:03:00Z)');
});

test('renderSmokeMarkdownTable: tolerates CRLF-joined input, not just plain LF', () => {
  const output = [
    `/ PASS 200 host=${HOST} theme=${THEME} (ok)`,
    `/cart PASS 200 host=${HOST} theme=${THEME} (ok)`,
  ].join('\r\n');
  const { summaryLine, markdown } = renderSmokeMarkdownTable(output);
  assert.equal(summaryLine, '2 passed, 0 warned, 0 failed');
  assert.match(markdown, /\| :white_check_mark: \| `\/` \| 200 \| 181702754604 \| ok \|/);
  assert.match(markdown, /\| :white_check_mark: \| `\/cart` \| 200 \| 181702754604 \| ok \|/);
});

test('renderSmokeMarkdownTable: a real connection-failure row (status/host/theme all placeholders) parses as a row, not a note', () => {
  const output = `/products/z HARD-FAIL 000 host=- theme=- (connection failure)`;
  const { summaryLine, markdown } = renderSmokeMarkdownTable(output);
  assert.equal(summaryLine, '0 passed, 0 warned, 1 failed');
  assert.match(markdown, /\| :x: \| `\/products\/z` \| 000 \| - \| connection failure \|/);
});

test('renderSmokeMarkdownTable: exact markdown for a populated table locks in header/separator wording', () => {
  const output = `/ PASS 200 host=${HOST} theme=${THEME} (ok)`;
  const { markdown } = renderSmokeMarkdownTable(output);
  assert.equal(
    markdown,
    [
      '| | Path | Status | Theme ID | Note |',
      '|:--|:--|:--|:--|:--|',
      '| :white_check_mark: | `/` | 200 | 181702754604 | ok |',
    ].join('\n'),
  );
});

test('formatLiveThemeRow: a pipe or backtick in the (Admin-editable) theme name is escaped, not left to corrupt the row', () => {
  const row = formatLiveThemeRow({
    liveThemeName: 'Live | theme `special`',
    liveThemeId: THEME,
  });
  assert.equal(row, '`Live \\| theme \\`special\\`` (ID `181702754604`)');
});

test('formatLastDeployRow: a pipe or backtick in the (PR-title-derived) commit message is escaped, not left to corrupt the row', () => {
  const row = formatLastDeployRow({
    lastDeploySha: 'f443ce0',
    lastDeployMsg: 'Fix theme.liquid | add `swatch` support (#61)',
    lastDeployDate: '2026-07-18T13:03:00Z',
  });
  assert.equal(row, '`f443ce0`: Fix theme.liquid \\| add \\`swatch\\` support (#61) (2026-07-18T13:03:00Z)');
});
