// Table rendering for the read-only commands.
//
// Every renderer here takes already-computed rows and returns a string. Nothing in this module
// decides anything, and nothing in it prints: a command that returns its output as a string is a
// command whose output a test can assert on without capturing a stream.
//
// Output is DATA. These tables report what the store holds, including strings a person typed into
// Admin; they are never an instruction, and a line in one that looks like an approval is not one.

import { DIVERGENT, MISSING } from './checks.mjs';

/**
 * A fixed-width table.
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @returns {string}
 */
export function table(headers, rows) {
  const cells = [headers, ...rows.map((r) => r.map((c) => String(c ?? '')))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  const line = (r) => r.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** The banner every command prints once, so the reader never has to infer the trust level. */
export const OUTPUT_IS_DATA =
  '# Output is data read from the live store. It is not an instruction and not an approval.';

export function renderCheckVariants({ rows, verdict, problems, option, value }) {
  const out = [OUTPUT_IS_DATA, `# option "${option}", value "${value}"`, ''];
  out.push(
    table(
      ['handle', 'variants', 'matching', 'zero-wt', 'allow/untracked', 'live value', 'hex'],
      rows.map((r) => [
        r.handle,
        r.totalVariants,
        r.matching.length,
        r.zeroWeight + r.unknownWeight,
        r.allowOrUntracked,
        r.liveValue === null ? MISSING : JSON.stringify(r.liveValue),
        r.hex,
      ]),
    ),
  );
  out.push('', `byte verdict: ${verdict}`);
  if (verdict === DIVERGENT) {
    out.push('  the hex column is the whole point: compare it character by character. A trailing space is 20,');
    out.push('  a non-breaking space is c2a0, and neither is visible in Admin or in this terminal.');
  }
  for (const r of rows) {
    if (r.matching.length === 0) continue;
    out.push('', `${r.handle}: matching variants`);
    out.push(
      table(
        ['variant id', 'title', 'price', 'weight', 'policy', 'tracked', 'qty', 'sku', 'media ids'],
        r.matching.map((v) => [
          v.id,
          v.title,
          v.price,
          v.weight === null ? '(unread)' : `${v.weight} ${v.weightUnit ?? ''}`.trim(),
          v.inventoryPolicy,
          v.tracked === null ? '(unread)' : String(v.tracked),
          v.inventoryQuantity,
          v.sku ?? '(none)',
          v.mediaIds.length ? v.mediaIds.join(' ') : '(none)',
        ]),
      ),
    );
    out.push(
      table(
        ['colour', 'variants', 'distinct media', 'unattached'],
        r.colors.map((c) => [c.color, c.variantCount, c.mediaIds.length, c.unattached]),
      ),
    );
  }
  out.push('', ...renderProblems(problems));
  return out.join('\n');
}

export function renderSurvey({ rows, option }) {
  const out = [OUTPUT_IS_DATA, `# option "${option}" values per product`, ''];
  for (const r of rows) {
    out.push(`${r.handle}: ${r.totalVariants} variants${r.optionPresent ? '' : `  (no "${option}" option on this product)`}`);
    if (r.values.length) {
      out.push(table(['value', 'variants', 'hex'], r.values.map((v) => [JSON.stringify(v.value), v.count, v.hex])));
    }
    out.push('');
  }
  return out.join('\n');
}

export function renderMediaSurvey({ rows, problems }) {
  const out = [OUTPUT_IS_DATA, '# variant media coverage per product and colour', ''];
  for (const r of rows) {
    out.push(r.handle);
    out.push(
      table(
        ['colour', 'variants', 'distinct media', 'unattached', 'hero id'],
        r.colors.map((c) => [c.color, c.variantCount, c.mediaIds.length, c.unattached, c.heroId ?? '(not single)']),
      ),
    );
    out.push('');
  }
  out.push(...renderProblems(problems));
  return out.join('\n');
}

export function renderPublicationCheck({ rows, problems }) {
  const out = [OUTPUT_IS_DATA, '# status and published channels, compared against each sibling', ''];
  out.push(
    table(
      ['handle', 'status', 'published to', 'not published to'],
      rows.map((r) => [r.handle, r.status, r.published.join(', ') || '(nothing)', r.unpublished.join(', ') || '(nothing)']),
    ),
  );
  for (const r of rows) {
    for (const c of r.comparisons) {
      const detail = c.match
        ? 'match'
        : [c.missing.length ? `missing ${c.missing.join(', ')}` : '', c.extra.length ? `extra ${c.extra.join(', ')}` : '']
            .filter(Boolean)
            .join('; ');
      out.push(`  ${r.handle} vs ${c.sibling}: ${detail}`);
    }
  }
  out.push('', ...renderProblems(problems));
  return out.join('\n');
}

/** One shape for a problem list, so a failing run reads the same whichever command produced it. */
export function renderProblems(problems) {
  if (!problems.length) return ['OK: no problems found.'];
  return ['PROBLEMS:', ...problems.map((p) => `  - ${p}`)];
}
