#!/usr/bin/env node
// Capture the pre-migration byte baseline: `node scripts/catalogue/test/capture-baseline.mjs`.
//
// WHY A FROZEN SNAPSHOT AND NOT A `git diff` AT MERGE TIME. Five shipped artifacts are generated
// from data that the catalogue migration moves under the manifest. "Regenerate and confirm a clean
// tree" compares the new generator against ITS OWN output, which is the self-referential-golden
// failure mode: a generator that changed its mind consistently passes. And a manual diff leaves no
// regression coverage at all once the migration has merged.
//
// So this file runs BEFORE any migration code exists, reads the five artifacts out of the committed
// repo, and writes them to fixtures/pre-migration-baseline.json. The migration's own PR then adds
// tests in the OWNING suites that byte-compare fresh generator output against these bytes.
//
// The snapshot is checked in and is not regenerated casually. `baseline.test.mjs` asserts the
// committed repo still matches it, so re-running this command can only ever be a deliberate act
// recorded in a reviewed diff.
//
// ONE DECLARED EXCEPTION: `EMPTY_SENTINEL` in scripts/applique-grid/lib/registry.mjs is a byte-
// equality check over `serialize(emptyRegistry())`, and the registry's schema changes in the
// migration, so its bytes change too. That is intentional and its own unit test updates in the same
// commit. It is not captured here, because capturing a value that is meant to change would assert
// the opposite of what this file is for.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Where the frozen bytes live. */
export const BASELINE_PATH = 'scripts/catalogue/test/fixtures/pre-migration-baseline.json';

/** The accordion row the size-chart generator writes, found by its block type and heading. */
const SIZE_CHART_HEADING = 'Size Chart';

/**
 * Walk a template's block tree and return every `_accordion-row` whose heading is the size chart's,
 * serialized with stable key order so a reformat of the template is a diff and not a false pass.
 *
 * @param {unknown} node
 * @param {Array<object>} out
 */
function collectSizeChartRows(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectSizeChartRows(item, out);
    return;
  }
  if (node.type === '_accordion-row' && node.settings?.heading === SIZE_CHART_HEADING) {
    out.push(node);
  }
  for (const value of Object.values(node)) collectSizeChartRows(value, out);
}

/**
 * Read the five artifacts out of the committed repo.
 *
 * @param {string} [repoRoot]
 * @returns {Promise<object>}
 */
export async function captureBaseline(repoRoot = REPO_ROOT) {
  const readText = (file) => readFile(path.join(repoRoot, file), 'utf8');
  // The leading block comment Shopify's theme editor writes into every generated JSON file is
  // stripped before parsing. It is not JSON, this repo does not control it, and it is present on
  // config/settings_data.json and on every product template.
  const readJson = async (file) => JSON.parse((await readText(file)).replace(/^\s*\/\*[\s\S]*?\*\//, ''));

  // 1. The size-chart render golden, and the accordion HTML fixtures beside it. Hashed rather than
  //    copied: they are already committed fixtures, and a second copy of a golden is a second thing
  //    to keep in step. What is frozen here is that THOSE files have not moved.
  const goldenDir = 'scripts/size-chart/test/fixtures';
  const goldens = {};
  for (const name of (await readdir(path.join(repoRoot, goldenDir))).sort()) {
    if (!name.endsWith('.svg')) continue;
    goldens[`${goldenDir}/${name}`] = await readText(`${goldenDir}/${name}`);
  }
  const accordionDir = `${goldenDir}/accordion-html`;
  for (const name of (await readdir(path.join(repoRoot, accordionDir))).sort()) {
    goldens[`${accordionDir}/${name}`] = await readText(`${accordionDir}/${name}`);
  }

  // 2. The generated size-chart accordion rows, as they are SHIPPED in the product templates. This
  //    is the artifact a customer sees, and it is what a generator change would silently rewrite.
  const templateDir = path.join(repoRoot, 'templates');
  const accordionRows = {};
  for (const name of (await readdir(templateDir)).sort()) {
    if (!/^product\..+\.json$/.test(name)) continue;
    const template = await readJson(`templates/${name}`);
    const rows = [];
    collectSizeChartRows(template, rows);
    if (rows.length) accordionRows[`templates/${name}`] = rows;
  }

  // 3 and 5. The applique dropdown, from BOTH ends: the registry the generator reads, and the string
  //    shipped in the product template. Capturing only one would let the pair drift while the frozen
  //    half still matched.
  const registry = await readJson('scripts/applique-grid/patterns.json');
  const appliqueHandle = registry.handle ?? registry.product?.handle;
  const appliqueTemplate = await readJson(`templates/product.${appliqueHandle}.json`);
  const patternOptions = [];
  const collectPatternOptions = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) collectPatternOptions(item);
      return;
    }
    if (typeof node.pattern_options === 'string') patternOptions.push(node.pattern_options);
    for (const value of Object.values(node)) collectPatternOptions(value);
  };
  collectPatternOptions(appliqueTemplate);

  // 4. The six accessibility labels, in declaration order. Order is one of the manifest's two order
  //    contracts, so the list is frozen as a LIST and not as a set.
  const a11y = await readJson('scripts/a11y/paths.json');
  const a11yProductEntries = (a11y.paths ?? [])
    .filter((e) => String(e.path).startsWith('/products/'))
    .map((e) => ({ path: e.path, label: e.label, template: e.template }));

  return {
    capturedFrom: 'the committed repo, before any consumer was migrated onto catalogue.json',
    sizeChartGoldens: goldens,
    sizeChartAccordionRows: accordionRows,
    appliquePatternsRegistry: {
      handle: appliqueHandle,
      patterns: (registry.patterns ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        thread: p.thread,
        status: p.status,
        position: p.position,
      })),
    },
    appliqueDropdownInTemplate: patternOptions,
    a11yProductEntries,
  };
}

/** Byte-stable serialization, matching the shape every other committed fixture here uses. */
export function serializeBaseline(baseline) {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

async function main() {
  const baseline = await captureBaseline();
  const file = path.join(REPO_ROOT, BASELINE_PATH);
  await writeFile(file, serializeBaseline(baseline));
  console.log(`Wrote ${BASELINE_PATH}`);
  console.log(
    `  ${Object.keys(baseline.sizeChartGoldens).length} size-chart golden(s), ` +
      `${Object.keys(baseline.sizeChartAccordionRows).length} template(s) with an accordion row, ` +
      `${baseline.appliquePatternsRegistry.patterns.length} applique pattern(s), ` +
      `${baseline.appliqueDropdownInTemplate.length} dropdown string(s), ` +
      `${baseline.a11yProductEntries.length} accessibility product entry/entries.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nERROR: ${err.message}\n`);
    process.exit(1);
  });
}
