// Cohesion: every repo-side surface that restates the catalogue's vocabulary, checked against
// catalogue.json. Offline, no credentials, no network. Run from scripts/catalogue/check-catalogue.mjs
// as part of `npm run catalogue:lint`, which is one CI step and deliberately stays one CI step.
//
// WHAT THIS IS FOR. The manifest became the repo's single source of truth for the colour list, the
// size list, the option axis names and the six-product census. Seven areas used to carry a private
// copy of some of that: five spellings of three garment bodies, three casings of one colour, one
// product GID written four times, and an allowlist comparing a template suffix against a product
// handle that could never match. These checks are what stops a copy drifting back in.
//
// A CHECK RETIRES WHEN ITS SOURCE BECOMES DERIVED. Half of these read a file that still declares its
// own copy; once that consumer derives its list from the manifest, comparing the two is comparing the
// manifest against itself, and a tautology in a lint is worse than no check at all because it reads
// as coverage. Each check therefore records the SOURCE it reads, and the ones whose source becomes
// manifest-derived are deleted from here and replaced by a derivation test in the owning suite.
//
// UNTRUSTED INPUT. Every string these checks name comes from a PR-authored file, and the lint's
// output is captured into `$GITHUB_OUTPUT` under a heredoc. A file name or a table key carrying a
// newline plus a delimiter line could otherwise close that heredoc early and forge a later
// `exit_code=0`, turning a refused lint into a green check. So: NO failure message interpolates raw
// file content. Everything PR-authored goes through `nameList`, which JSON-quotes each entry (so a
// newline cannot span lines) and bounds the list (so a PR-inflated set cannot produce an output
// nobody can read). This is the second of two independent guards; the workflow's random heredoc
// delimiter is the first.
//
// This module reads the filesystem and nothing else: no network, no credentials, no writes.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { normaliseAxis } from './vocab.mjs';
import {
  nameList,
  garmentProducts,
  nonGarmentProducts,
  colorValuesFor,
  templateFileFor,
} from './catalogue-manifest.mjs';

/** Severity of a cohesion finding. A REFUSE reds the build; a WARN is reported and does not. */
export const REFUSE = 'refuse';
export const WARN = 'warn';

/**
 * Loosely normalise a human-facing product label for comparison against an Admin title.
 *
 * Prose spells a title the way prose does: `**Lead II Vest, Women's**` in one doc is the Admin
 * `Lead II Vest - Women's`. Both reduce to `lead ii vest women s`. This is deliberately tolerant,
 * because the docs' job is to read well and the manifest's job is to be exact; what the check is
 * really asserting is that the doc's product SET is the manifest's product set, not its typography.
 *
 * @param {string} label
 * @returns {string}
 */
function looseLabel(label) {
  return label
    .replace(/\*\*/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Every `` `backticked` `` token in a string. @param {string} s @returns {string[]} */
function backticked(s) {
  return [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/**
 * The body of one `<!-- catalogue:begin NAME -->` / `<!-- catalogue:end NAME -->` region.
 *
 * A missing or duplicated marker is a REFUSAL, not an empty region: a doc edit that deletes a marker
 * would otherwise silently retire the check that guards it, which is the fail-open shape everything
 * here exists to prevent.
 *
 * @param {string} text
 * @param {string} name
 * @param {string} file
 * @returns {string}
 */
function markerRegion(text, name, file) {
  const open = `<!-- catalogue:begin ${name} -->`;
  const close = `<!-- catalogue:end ${name} -->`;
  const opens = text.split(open).length - 1;
  const closes = text.split(close).length - 1;
  if (opens !== 1 || closes !== 1) {
    throw new Error(
      `${file} must contain exactly one ${open} and one ${close}; found ${opens} and ${closes}. The ` +
        `markers delimit the region this lint checks against catalogue.json, so deleting one would ` +
        `silently retire the check rather than fail it.`
    );
  }
  const start = text.indexOf(open) + open.length;
  const end = text.indexOf(close);
  if (end < start) {
    throw new Error(`${file}: ${close} appears before ${open}.`);
  }
  return text.slice(start, end);
}

/**
 * Markdown table rows in a region, as `[firstCell, restJoined]`.
 * The header and separator rows are dropped.
 *
 * @param {string} region
 * @returns {Array<[string, string]>}
 */
function tableRows(region) {
  return region
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|[\s|:-]+\|$/.test(line))
    .map((line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
    .filter((cells) => cells.length >= 2)
    .map((cells) => [cells[0], cells.slice(1).join(' | ')])
    .filter(([first]) => looseLabel(first) !== 'product');
}

/**
 * Both directions of a set comparison, as a finding message, or null when they agree.
 *
 * @param {Iterable<string>} actual
 * @param {Iterable<string>} expected
 * @param {string} actualLabel
 * @param {string} expectedLabel
 * @returns {string|null}
 */
function setDiff(actual, expected, actualLabel, expectedLabel) {
  const a = [...new Set(actual)];
  const e = [...new Set(expected)];
  const missing = e.filter((v) => !a.includes(v));
  const extra = a.filter((v) => !e.includes(v));
  if (!missing.length && !extra.length) return null;
  return (
    `${missing.length ? `${expectedLabel} but not ${actualLabel}: ${nameList(missing)}. ` : ''}` +
    `${extra.length ? `${actualLabel} but not ${expectedLabel}: ${nameList(extra)}.` : ''}`
  ).trim();
}

/**
 * Read a JSON file, or refuse with a message naming the file rather than a bare ENOENT.
 *
 * A LEADING BLOCK COMMENT IS TOLERATED, and only a leading one. Shopify's own theme editor writes
 * config/settings_data.json with a nine-line `/* ... *\u002F` banner above the object, which is not
 * JSON and which this repo does not control: refusing it would mean the lint could never read the
 * file it most needs to warn about. Nothing else about the parse is relaxed.
 *
 * @param {string} file @param {string} repoRoot @returns {Promise<object>}
 */
async function readJson(file, repoRoot) {
  const abs = path.join(repoRoot, file);
  let text;
  try {
    text = await readFile(abs, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.code ?? err.message}.`);
  }
  const body = text.replace(/^\s*\/\*[\s\S]*?\*\//, '');
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

/**
 * Every cohesion check, in one table so the count is a fact rather than a comment.
 *
 * Each entry declares:
 *   `id`       a stable identifier, emitted into CI output so a failure is diagnosable without
 *              opening the raw job log;
 *   `source`   the file this check reads its non-manifest side FROM. When that becomes
 *              manifest-derived, the check is a tautology and is deleted rather than kept green;
 *   `severity` REFUSE for everything except the two settings_data.json checks, which WARN;
 *   `run`      returns a problem string, or null.
 *
 * RETIRED CHECKS ARE DELETED, NOT KEPT GREEN. Three checks over scripts/sku/tables.json (its product
 * census in both directions, its titles, and its colour vocabulary) lived here while that file still
 * restated the manifest. It no longer does: `scripts/sku/lib/tables.mjs` validates the codes AGAINST
 * the manifest at load, on every command and in `npm run sku:tables`, and refuses a leftover title
 * outright. Asserting the same thing twice from two files is not defence in depth; it is a second
 * place to update. The replacements are derivation tests in the owning suite, in
 * scripts/sku/test/tables.test.mjs.
 *
 * A fourth, over scripts/lib/photo-naming.mjs's product census (handle, title, GID and colour
 * values), retired the same way: that module now builds the census with `createNaming(manifest)`, so
 * the check compared the manifest against a list derived from it. Its replacement is the
 * both-directions BODY_PHOTO_TOKEN test in scripts/lib/photo-naming.test.mjs, which asserts the one
 * thing that is still hand-authored there.
 *
 * A fifth, over the size-chart profiles' handle lists, retired with the size-chart migration: a
 * profile declares a catalogue body now and `profile-io.mjs` materialises its handles from the
 * products on that body, so the list cannot name a product the manifest does not. Its replacement is
 * the materialisation test in scripts/size-chart/test/profile-io.test.mjs, plus the frozen
 * byte-stability snapshot in scripts/size-chart/test/pre-migration-bytes.test.mjs. Only that
 * DIRECTION retired, though: nothing derives the profiles directory itself, so "every declared body
 * has a size-chart profile" is still a fact two files can disagree about, and it stays below as
 * `size-chart-profile-per-body` (the old pre-migration check 13, re-keyed on bodies).
 *
 * The last two, over the accessibility audit's product coverage in both directions, retired with the
 * a11y migration: `build-pa11yci.mjs` expands a marker in paths.json into one entry per manifest
 * product, so the audited list cannot miss a product or name one that is not declared. Their
 * replacements are the labelled LOGIC and MATCHES PRODUCTION tests in
 * scripts/a11y/test/build-pa11yci.test.mjs.
 *
 * @type {Array<{id: string, source: string, severity: string, run: (ctx: object) => Promise<string|null>}>}
 */
export const CHECKS = [
  // 1-2. The variant picker matches Admin option values by NAME, so a settings default that does not
  // equal the manifest's axis name means the picker stops matching. These are schema defaults in a
  // repo-owned file, so they REFUSE.
  {
    id: 'settings-schema-color-option',
    source: 'config/settings_schema.json',
    severity: REFUSE,
    async run({ manifest, settingsSchemaDefaults }) {
      const declared = manifest.options.get('color');
      const actual = settingsSchemaDefaults.get('color_option_name');
      return actual === declared
        ? null
        : `config/settings_schema.json "color_option_name" default is ${nameList([String(actual)])} ` +
            `but catalogue.json declares options.color as ${nameList([declared])}. The variant picker ` +
            `matches Admin option values by this name; a mismatch stops it matching at all.`;
    },
  },
  {
    id: 'settings-schema-size-option',
    source: 'config/settings_schema.json',
    severity: REFUSE,
    async run({ manifest, settingsSchemaDefaults }) {
      const declared = manifest.options.get('size');
      const actual = settingsSchemaDefaults.get('size_option_name');
      return actual === declared
        ? null
        : `config/settings_schema.json "size_option_name" default is ${nameList([String(actual)])} ` +
            `but catalogue.json declares options.size as ${nameList([declared])}. The variant picker ` +
            `matches Admin option values by this name; a mismatch stops it matching at all.`;
    },
  },

  // 3-4. The same two values as SAVED, in config/settings_data.json. This is Admin-editable and is
  // reconciled onto main by sync.yml, so a REFUSAL here would let an Admin edit red a reconcile PR
  // that nobody in this repo authored, and halt deploy.yml's gate on something that cannot be fixed
  // from Admin. WARN, deliberately, and the warning has to reach the PR comment: a warning nobody
  // sees is worse than no warning at all.
  {
    id: 'settings-data-color-option',
    source: 'config/settings_data.json',
    severity: WARN,
    async run({ manifest, settingsDataValues }) {
      const declared = manifest.options.get('color');
      const actual = settingsDataValues.get('color_option_name');
      return actual === declared
        ? null
        : `config/settings_data.json has "color_option_name" set to ${nameList([String(actual)])} ` +
            `but catalogue.json declares options.color as ${nameList([declared])}. The variant picker ` +
            `will not match option values until one side is corrected. This is a WARNING because ` +
            `settings_data.json is Admin-editable and reconciled onto main by sync.yml; refusing here ` +
            `would red a PR nobody in this repo authored. Fix it in Admin (Theme settings) or in the ` +
            `manifest, whichever is wrong.`;
    },
  },
  {
    id: 'settings-data-size-option',
    source: 'config/settings_data.json',
    severity: WARN,
    async run({ manifest, settingsDataValues }) {
      const declared = manifest.options.get('size');
      const actual = settingsDataValues.get('size_option_name');
      return actual === declared
        ? null
        : `config/settings_data.json has "size_option_name" set to ${nameList([String(actual)])} ` +
            `but catalogue.json declares options.size as ${nameList([declared])}. The variant picker ` +
            `will not match option values until one side is corrected. This is a WARNING because ` +
            `settings_data.json is Admin-editable and reconciled onto main by sync.yml; refusing here ` +
            `would red a PR nobody in this repo authored.`;
    },
  },

  // 7-8. Theme template coverage, both directions, read from the filesystem. These do NOT retire:
  // the templates directory is not derived from anything, and a product whose template file is
  // missing renders the default product template with none of its content.
  {
    id: 'template-exists-per-product',
    source: 'templates/',
    severity: REFUSE,
    async run({ manifest, templateFiles }) {
      const missing = [...manifest.products.values()]
        .map((p) => templateFileFor(manifest, p.handle))
        .filter((f) => !templateFiles.includes(f));
      return (
        missing.length &&
        `${missing.length} declared product(s) have no theme template: ${nameList(missing)}. Shopify ` +
          `falls back to templates/product.json, so the product renders with none of its own content ` +
          `and nothing else notices.`
      );
    },
  },
  {
    id: 'no-unclaimed-product-template',
    source: 'templates/',
    severity: REFUSE,
    async run({ manifest, templateFiles }) {
      const claimed = new Set([...manifest.products.values()].map((p) => templateFileFor(manifest, p.handle)));
      const unclaimed = templateFiles.filter((f) => !claimed.has(f));
      return (
        unclaimed.length &&
        `${unclaimed.length} product template(s) belong to no declared product: ${nameList(unclaimed)}. ` +
          `Either the product is missing from catalogue.json or the template is dead and should be ` +
          `deleted; both are worth a decision rather than a silent file.`
      );
    },
  },

  // 12. The applique registry names one product, and it must be a declared GARMENT: the pattern
  // charts are printed on a body. Read at the registry's top-level `handle`.
  {
    id: 'applique-product-is-a-garment',
    source: 'scripts/applique-grid/patterns.json',
    severity: REFUSE,
    async run({ manifest, appliqueHandle }) {
      const product = manifest.products.get(appliqueHandle);
      if (!product) {
        return (
          `scripts/applique-grid/patterns.json names product ${nameList([appliqueHandle])}, which is ` +
          `not declared in catalogue.json. The registry publishes chart media onto that product, so ` +
          `an undeclared handle means the media plan has no manifest entry to verify its GID against.`
        );
      }
      return product.body === null
        ? `scripts/applique-grid/patterns.json names product ${nameList([appliqueHandle])}, which is ` +
            `declared with "body": null and is therefore not a garment. Applique patterns are ` +
            `printed on a body.`
        : null;
    },
  },

  // 13. Every declared garment body has a size-chart profile. The profiles directory is
  // hand-authored (a new blank means authoring a spec), so this cannot retire as derived: a body
  // declared in the manifest with no profile means every product cut from it ships with no size
  // chart, and nothing else notices. The other direction (a profile naming a body the manifest does
  // not declare) is refused by profile-io.mjs's materialisation at every load.
  {
    id: 'size-chart-profile-per-body',
    source: 'scripts/size-chart/profiles/',
    severity: REFUSE,
    async run({ manifest, sizeChartProfileBodies }) {
      const missing = [...manifest.bodies.keys()].filter((b) => !sizeChartProfileBodies.has(b));
      return (
        missing.length &&
        `${missing.length} declared garment body/bodies have no size-chart profile: ` +
          `${nameList(missing)}. Every product on such a body ships with no size chart and nothing ` +
          `else notices. Author scripts/size-chart/profiles/<blank_id>.json declaring that "body" ` +
          `(the size-chart skill walks through it), or remove the body from catalogue.json.`
      );
    },
  },

  // 15-16. The two docs that restate the vocabulary in prose, inside explicit marker regions. These
  // do NOT retire: prose is hand-written by definition, and these regions are exactly the parts of it
  // that make a factual claim about the catalogue.
  {
    id: 'docs-sku-scheme-markers',
    source: 'docs/sku-scheme.md',
    severity: REFUSE,
    async run({ manifest, docs }) {
      const problems = [];
      const productRows = tableRows(markerRegion(docs.skuScheme, 'products', 'docs/sku-scheme.md'));
      const productDiff = setDiff(
        productRows.map(([label]) => looseLabel(label)),
        [...manifest.products.values()].map((p) => looseLabel(p.title)),
        'in the doc',
        'declared in catalogue.json'
      );
      if (productDiff) problems.push(`product table: ${productDiff}`);

      const colorRegion = markerRegion(docs.skuScheme, 'colors', 'docs/sku-scheme.md');
      // The colour line reads "`BLK` Black, `GRH` Grey Heather, ...": each backticked code is
      // followed by its display name, so the name after each code is what is compared. Extracting
      // by position, not by declaredness: filtering the tokens through `manifest.colors.has` first
      // would make the "in the doc but not declared" direction unreachable by construction, and a
      // doc that names a colour the catalogue dropped must fail, not be quietly skipped. Leading
      // prose (the "**Colours** (store-wide):" label) precedes the first code and is never captured.
      const named = [...colorRegion.matchAll(/`[^`]+`\s*([^,.:;\n|`]+)/g)]
        .map((m) => m[1].trim())
        .filter(Boolean)
        .map((s) => normaliseAxis(s, 'Color'));
      const colorDiff = setDiff(named, [...manifest.colors.keys()], 'in the doc', 'declared in catalogue.json');
      if (colorDiff) problems.push(`colour line: ${colorDiff}`);

      return (
        problems.length &&
        `docs/sku-scheme.md's catalogue: marker regions disagree with the manifest. ${problems.join(' ')}`
      );
    },
  },
  {
    id: 'docs-alt-text-markers',
    source: 'docs/product-media-alt-text.md',
    severity: REFUSE,
    async run({ manifest, docs }) {
      const region = markerRegion(docs.altText, 'product-colors', 'docs/product-media-alt-text.md');
      const rows = tableRows(region);
      const problems = [];
      const byLabel = new Map(garmentProducts(manifest).map((p) => [looseLabel(p.title), p]));
      const seen = new Set();
      for (const [label, rest] of rows) {
        const product = byLabel.get(looseLabel(label));
        if (!product) {
          problems.push(`${looseLabel(label)} (not a declared garment)`);
          continue;
        }
        seen.add(product.handle);
        const named = backticked(rest);
        const expected = colorValuesFor(manifest, product.handle);
        const diff = setDiff(named, expected, 'in the doc row', 'declared for that body');
        if (diff) problems.push(`${product.handle}: ${diff}`);
      }
      const missing = [...byLabel.values()].filter((p) => !seen.has(p.handle)).map((p) => p.handle);
      if (missing.length) problems.push(`no row for ${nameList(missing)}`);

      return (
        problems.length &&
        `docs/product-media-alt-text.md's catalogue:product-colors region disagrees with the ` +
          `manifest. ${problems.join(' ')} That table is what an author reads before writing alt ` +
          `text, and alt text is what binds a photo to a colour on the storefront.`
      );
    },
  },
];

/**
 * The number of checks this module ships. Pinned by a test, and reported by the lint's count line, so
 * a module that failed to load reads a different number rather than reading as "all clear".
 */
export const COHESION_CHECK_COUNT = CHECKS.length;

/**
 * Gather everything the checks read, once, so no check does its own I/O and the whole set can be run
 * against hand-authored inputs in a unit test.
 *
 * @param {object} params
 * @param {string} params.repoRoot
 * @param {object} params.manifest
 * @param {(dir: string) => Promise<string[]>} params.listDir - injected so the template scan is testable
 * @returns {Promise<object>}
 */
export async function collectSources({ repoRoot, manifest, listDir }) {
  const readText = async (file) => {
    try {
      return await readFile(path.join(repoRoot, file), 'utf8');
    } catch (err) {
      throw new Error(`Cannot read ${file}: ${err.code ?? err.message}.`);
    }
  };

  const settingsSchema = await readJson('config/settings_schema.json', repoRoot);
  const settingsSchemaDefaults = new Map();
  for (const group of Array.isArray(settingsSchema) ? settingsSchema : []) {
    for (const setting of group?.settings ?? []) {
      if (setting?.id) settingsSchemaDefaults.set(setting.id, setting.default);
    }
  }

  const settingsData = await readJson('config/settings_data.json', repoRoot);
  const settingsDataValues = new Map(Object.entries(settingsData?.current ?? settingsData ?? {}));

  const templateFiles = (await listDir(path.join(repoRoot, 'templates')))
    .filter((f) => /^product\..+\.json$/.test(f))
    .map((f) => `templates/${f}`)
    .sort();

  // Which bodies the size-chart profiles cover: body id -> the first profile file declaring it.
  const profileFiles = (await listDir(path.join(repoRoot, 'scripts/size-chart/profiles')))
    .filter((f) => f.endsWith('.json'))
    .sort();
  const sizeChartProfileBodies = new Map();
  for (const f of profileFiles) {
    const profile = await readJson(`scripts/size-chart/profiles/${f}`, repoRoot);
    if (typeof profile.body === 'string' && !sizeChartProfileBodies.has(profile.body)) {
      sizeChartProfileBodies.set(profile.body, f);
    }
  }

  const appliqueRegistry = await readJson('scripts/applique-grid/patterns.json', repoRoot);
  // Top-level now. It was nested under a `product` block until applique-grid was migrated; that
  // block is gone from the committed file and `registry.mjs` refuses one, so there is no fallback to
  // keep here.
  const appliqueHandle = String(appliqueRegistry.handle ?? '');

  return {
    manifest,
    settingsSchemaDefaults,
    settingsDataValues,
    templateFiles,
    sizeChartProfileBodies,
    appliqueHandle,
    docs: {
      skuScheme: await readText('docs/sku-scheme.md'),
      altText: await readText('docs/product-media-alt-text.md'),
    },
  };
}

/**
 * Run every cohesion check.
 *
 * @param {object} sources - the value from `collectSources`, or a hand-authored equivalent
 * @returns {Promise<{run: number, refusals: Array<{id: string, message: string}>, warnings: Array<{id: string, message: string}>}>}
 */
export async function runCohesion(sources) {
  const refusals = [];
  const warnings = [];
  let run = 0;
  for (const check of CHECKS) {
    run += 1;
    let problem;
    try {
      problem = await check.run(sources);
    } catch (err) {
      // A check that THREW is a failed check, never a skipped one. Its own message is authored here,
      // not read from a file, so it is safe to print; anything it quotes has already been through
      // nameList.
      refusals.push({ id: check.id, message: `${check.id} could not run: ${err.message}` });
      continue;
    }
    if (!problem) continue;
    (check.severity === WARN ? warnings : refusals).push({ id: check.id, message: String(problem) });
  }
  return { run, refusals, warnings };
}
