// The verdicts. Pure over normalised products, so every one of them is testable with a fixture and
// no network.
//
// The point of this module is that the three read-only commands answer questions a human eye gets
// wrong. An option value that differs from its sibling product's by one non-breaking space looks
// identical in every terminal and in Admin, and produces two SKU rows, two blank groups and a
// filter that silently misses half the variants. So the comparison is on bytes, and the bytes are
// printed.

import { COLOR_OPTION_NAME, NO_COLOUR_KEY, findOption, optionValue, variantsByColor } from './admin-reads.mjs';

export const IDENTICAL = 'IDENTICAL';
export const DIVERGENT = 'DIVERGENT';
export const MISSING = '(absent)';

/** The exact bytes of an option value, hex encoded. This is the whole idea; do not "simplify" it. */
export function hexOf(value) {
  return Buffer.from(String(value), 'utf8').toString('hex');
}

/**
 * A loose key for FINDING the value the operator meant, never for comparing two of them.
 *
 * Matching has to be forgiving (the operator types a clean string; the store may hold a tainted
 * one, which is the bug being hunted) while the verdict has to be exact. Those are two different
 * questions and this function answers only the first.
 *
 * @param {string} s
 * @returns {string}
 */
export function looseKey(s) {
  return String(s)
    .normalize('NFC')
    .split('')
    .map((ch) => (/\s/.test(ch) || ch.codePointAt(0) === 0x00a0 ? ' ' : ch))
    .join('')
    .replace(/ +/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The live option value on this product that the operator's string names, byte-exact as stored.
 * @param {object} product
 * @param {string} optionName
 * @param {string} wanted
 * @returns {string|null}
 */
export function findLiveValue(product, optionName, wanted) {
  const option = findOption(product, optionName);
  if (!option) return null;
  const key = looseKey(wanted);
  return option.values.find((v) => looseKey(v) === key) ?? null;
}

/**
 * Per-colour media facts for a set of variants.
 * @param {object[]} variants
 * @returns {Array<{color: string, variantCount: number, mediaIds: string[], unattached: number, heroId: string|null}>}
 */
export function colorMediaRows(variants) {
  const groups = new Map();
  for (const v of variants) {
    const key = optionValue(v, COLOR_OPTION_NAME) ?? NO_COLOUR_KEY;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  return [...groups.entries()].map(([color, vs]) => {
    const ids = [...new Set(vs.flatMap((v) => v.mediaIds ?? []))];
    return {
      color,
      variantCount: vs.length,
      mediaIds: ids,
      unattached: vs.filter((v) => (v.mediaIds ?? []).length === 0).length,
      heroId: ids.length === 1 ? ids[0] : null,
    };
  });
}

/**
 * check-variants: the per-product inspection and the cross-product byte verdict.
 *
 * @param {object} o
 * @param {object[]} o.products - normalised products, in the resolved handle order
 * @param {string} o.option
 * @param {string} o.value
 * @returns {{rows: object[], verdict: string, problems: string[], exitCode: number}}
 */
export function checkVariants({ products, option, value }) {
  const rows = products.map((product) => {
    const live = findLiveValue(product, option, value);
    const matching = live === null ? [] : product.variants.filter((v) => optionValue(v, option) === live);
    return {
      handle: product.handle,
      totalVariants: product.variants.length,
      liveValue: live,
      hex: live === null ? MISSING : hexOf(live),
      matching,
      zeroWeight: matching.filter((v) => v.weight === 0).length,
      unknownWeight: matching.filter((v) => v.weight === null).length,
      allowOrUntracked: matching.filter((v) => v.inventoryPolicy === 'ALLOW' || v.tracked === false).length,
      colors: colorMediaRows(matching),
    };
  });

  const hexes = new Set(rows.map((r) => r.hex));
  const verdict = hexes.size === 1 && !hexes.has(MISSING) ? IDENTICAL : DIVERGENT;

  const problems = [];
  if (verdict === DIVERGENT) {
    problems.push(
      `option value "${value}" is not byte-identical across the run: ` +
        rows.map((r) => `${r.handle}=${r.hex}`).join(', '),
    );
  }
  for (const r of rows) {
    if (r.zeroWeight > 0) problems.push(`${r.handle}: ${r.zeroWeight} matching variant(s) with weight 0`);
    if (r.unknownWeight > 0) problems.push(`${r.handle}: ${r.unknownWeight} matching variant(s) with no readable weight`);
    if (r.allowOrUntracked > 0) {
      problems.push(`${r.handle}: ${r.allowOrUntracked} matching variant(s) with policy ALLOW or inventory not tracked`);
    }
  }
  return { rows, verdict, problems, exitCode: problems.length ? 1 : 0 };
}

/**
 * check-variants --survey: what values the option actually carries, and how many variants each has.
 * @param {object} o
 * @param {object[]} o.products
 * @param {string} o.option
 * @returns {{rows: object[]}}
 */
export function surveyOption({ products, option }) {
  const rows = products.map((product) => {
    const opt = findOption(product, option);
    const counts = new Map();
    for (const v of product.variants) {
      const val = optionValue(v, option);
      if (val === null) continue;
      counts.set(val, (counts.get(val) ?? 0) + 1);
    }
    return {
      handle: product.handle,
      optionPresent: Boolean(opt),
      totalVariants: product.variants.length,
      values: (opt?.values ?? [...counts.keys()]).map((v) => ({ value: v, hex: hexOf(v), count: counts.get(v) ?? 0 })),
    };
  });
  return { rows };
}

/**
 * media-survey: hero coverage per product and colour.
 *
 * Two distinct media ids on one colour is a STOP rather than a warning. It means two variants of
 * the same colour show different pictures, and the fix is a decision about which one is the hero,
 * not something a tool should pick.
 *
 * @param {object[]} products
 * @returns {{rows: object[], problems: string[], exitCode: number}}
 */
export function mediaSurvey(products) {
  const rows = products.map((product) => ({
    handle: product.handle,
    colors: colorMediaRows(product.variants),
  }));
  const problems = [];
  for (const row of rows) {
    for (const c of row.colors) {
      if (c.mediaIds.length > 1) {
        problems.push(`${row.handle} / ${c.color}: ${c.mediaIds.length} distinct media ids (${c.mediaIds.join(', ')})`);
      }
      if (c.unattached > 0) {
        problems.push(`${row.handle} / ${c.color}: ${c.unattached} variant(s) with no attached media`);
      }
    }
  }
  return { rows, problems, exitCode: problems.length ? 1 : 0 };
}

/**
 * A sibling has to be a product OUTSIDE the run.
 *
 * The whole value of the sibling comparison is that it is evidence from a product this run did not
 * touch. A sibling drawn from the run compares the run against itself and reads as a pass.
 *
 * @param {string[]} handles
 * @param {string[]} siblings
 */
export function assertSiblingsDisjoint(handles, siblings) {
  const overlap = siblings.filter((s) => handles.includes(s));
  if (overlap.length) {
    throw new Error(
      `--sibling ${overlap.join(', ')} is part of this run. A sibling must be a product the run does ` +
        'not touch, or the comparison is the run against itself.',
    );
  }
}

/**
 * publication-check: every run product's published channel set against every sibling's.
 *
 * An empty published set on EITHER side fails. On the run side it is the failure this command
 * exists for (ACTIVE and published are independent; a product published nowhere is invisible to
 * every customer and absent from the sitemap). On the sibling side it means the reference is
 * worthless, which would otherwise read as a clean match against nothing.
 *
 * @param {object} o
 * @param {object[]} o.run - fetchPublications results for the run handles
 * @param {object[]} o.siblings - fetchPublications results for the siblings
 * @returns {{rows: object[], problems: string[], exitCode: number}}
 */
export function publicationCheck({ run, siblings }) {
  const problems = [];
  for (const s of siblings) {
    if (s.published.length === 0) {
      problems.push(`sibling ${s.handle} is published to nothing, so it is not a usable reference`);
    }
  }
  const rows = run.map((p) => {
    const comparisons = siblings.map((s) => {
      const missing = s.published.filter((n) => !p.published.includes(n));
      const extra = p.published.filter((n) => !s.published.includes(n));
      return { sibling: s.handle, missing, extra, match: missing.length === 0 && extra.length === 0 };
    });
    return { ...p, comparisons };
  });
  for (const p of rows) {
    if (p.published.length === 0) {
      problems.push(`${p.handle} is published to NO channel (status ${p.status}); it is invisible to customers and absent from the sitemap`);
    }
    for (const c of p.comparisons) {
      if (c.match) continue;
      const parts = [];
      if (c.missing.length) parts.push(`missing ${c.missing.join(', ')}`);
      if (c.extra.length) parts.push(`extra ${c.extra.join(', ')}`);
      problems.push(`${p.handle} differs from sibling ${c.sibling}: ${parts.join('; ')}`);
    }
  }
  return { rows, problems, exitCode: problems.length ? 1 : 0 };
}

export { variantsByColor };
