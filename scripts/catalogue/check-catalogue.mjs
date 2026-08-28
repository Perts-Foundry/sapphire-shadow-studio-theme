#!/usr/bin/env node
// Offline lint for the root catalogue.json (`npm run catalogue:lint`).
//
// Runs in CI, where there are no credentials and no network. It does three things:
//
//   1. parses the manifest under the tool's own schema rules;
//   2. runs the offline half of the reconcile gate (today: a declared body with no product);
//   3. runs every cohesion check in scripts/lib/catalogue-cohesion.mjs, which is what stops the six
//      other areas that used to carry a private copy of this vocabulary from drifting back apart.
//
// It then prints the number of bodies, colours, sizes, products, option names and cohesion checks it
// covered, so a lint that checked nothing cannot pass: an empty or truncated manifest, or a cohesion
// module that failed to load, would otherwise validate happily and report success, which is the
// fail-open shape this repo refuses everywhere else. The workflow greps those six numbers.
//
// ONE SCHEMA, TWO ENTRY POINTS. The rules live in scripts/lib/catalogue-manifest.mjs and are reused
// here rather than restated, so a manifest that passes CI is exactly a manifest the reorder review
// will accept.
//
// READ-ONLY BY CONSTRUCTION. This file imports node builtins, the schema module, the cohesion module
// and scripts/lib/photo-naming.mjs, and nothing else. A transitive-closure test asserts that nothing
// in that graph can reach lib/mutations.mjs or lib/admin.mjs.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { loadCatalogue, reconcileCatalogue, assessCatalogue, CATALOGUE_PATH } from '../lib/catalogue-manifest.mjs';
import { collectSources, runCohesion, COHESION_CHECK_COUNT } from '../lib/catalogue-cohesion.mjs';
import { PRODUCTS as PHOTO_NAMING_PRODUCTS } from '../lib/photo-naming.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The success line, in one place.
 *
 * The workflow greps this line for its own fail-closed floor, so the wording is a contract between
 * this file and .github/workflows/validate.yml. Exported so a test pins it here rather than leaving
 * CI as the only thing that notices a reword. The test also runs the workflow's own sed/cut pipeline
 * against this exact string, because a reword and a regex are two files apart.
 *
 * `cohesion` is the count of checks RUN, not the count declared: a module that failed to load reads
 * 0 and reds the build rather than reading as "all clear".
 *
 * @param {{bodies: number, colors: number, sizes: number, products: number, options: number, cohesion: number}} counts
 * @returns {string}
 */
export function formatCounts({ bodies, colors, sizes, products, options, cohesion }) {
  return (
    `catalogue OK: ${bodies} bodies, ${colors} colour values, ${sizes} size values, ` +
    `${products} products, ${options} option names, ${cohesion} cohesion checks.`
  );
}

/**
 * The one-line failing-check summary, in one place.
 *
 * validate.yml greps this exact wording into a dedicated step output and renders it in the PR
 * comment's detail cell, so the wording is a contract between this file and that workflow, in the
 * same way `formatCounts` is. Bounded: the id list is authored here and finite, but the bound is
 * kept so a future check set cannot produce an Actions output nobody can read.
 *
 * @param {string[]} ids
 * @returns {string}
 */
export function formatFailingChecks(ids, limit = 8) {
  const head = ids.slice(0, limit).join(', ');
  const tail = ids.length > limit ? ` and ${ids.length - limit} more` : '';
  return `catalogue FAILING CHECKS (${ids.length}): ${head}${tail}`;
}

/**
 * @param {object} [params]
 * @param {string} [params.filePath]
 * @param {string} [params.repoRoot]
 * @returns {Promise<{counts: object, warnings: Array<{id: string, message: string}>}>}
 * @throws when the manifest is missing, invalid, vacuous, or disagrees with any checked surface
 */
export async function checkCatalogue({
  filePath = path.join(REPO_ROOT, CATALOGUE_PATH),
  repoRoot = REPO_ROOT,
} = {}) {
  // loadCatalogue, not readFile plus parseCatalogue: a missing file is the likeliest real CI
  // failure (a rename, or a bad merge deleting it), and it deserves the module's curated refusal
  // rather than a bare ENOENT that says nothing about who owns the file.
  const manifest = await loadCatalogue({ read: (p) => readFile(p, 'utf8'), path: filePath });

  // The offline half of the reconcile gate. No live products are passed, so only the checks that
  // need none can fire; today that is `catalogue-dangling-body`. Passing an empty live list is not
  // the same as passing none, and `reconcileCatalogue` treats it as "no live data" deliberately.
  const offline = assessCatalogue(reconcileCatalogue({ manifest }));
  if (offline.exitCode !== 0) {
    throw new Error(offline.refusals.map((r) => `[${r.code}] ${r.message}`).join('\n\n'));
  }

  const sources = await collectSources({
    repoRoot,
    manifest,
    listDir: (dir) => readdir(dir),
    photoNamingProducts: PHOTO_NAMING_PRODUCTS,
  });
  const cohesion = await runCohesion(sources);

  const counts = {
    bodies: manifest.bodies.size,
    colors: manifest.colors.size,
    sizes: manifest.sizes.size,
    products: manifest.products.size,
    options: manifest.options.size,
    cohesion: cohesion.run,
  };

  const vacuous = Object.entries(counts).filter(([, n]) => !n);
  if (vacuous.length) {
    throw new Error(
      `${filePath} produced a zero count for: ${vacuous.map(([k]) => k).join(', ')}. A lint that ` +
        `checks nothing must not pass.`
    );
  }
  if (cohesion.run !== COHESION_CHECK_COUNT) {
    throw new Error(
      `Ran ${cohesion.run} cohesion check(s) but the module declares ${COHESION_CHECK_COUNT}. A check ` +
        `that silently stopped running is worse than one that fails.`
    );
  }

  if (cohesion.refusals.length) {
    // The ids go on their OWN line, in a fixed shape, as the LAST thing before the detail. Sixteen
    // checks collapse into one row in the PR comment, so without an identifier a failure is only
    // diagnosable by opening the raw job log; validate.yml greps this line into its own output field
    // and renders it in the comment. The ids are authored in this repo, not read from a file, so they
    // are safe to emit verbatim; everything after it has already been through nameList.
    throw new Error(
      `${formatFailingChecks(cohesion.refusals.map((r) => r.id))}\n\n` +
        `${cohesion.refusals.map((r) => `[${r.id}] ${r.message}`).join('\n\n')}`
    );
  }

  return { counts, warnings: cohesion.warnings };
}

async function main() {
  const { counts, warnings } = await checkCatalogue();
  for (const w of warnings) console.log(`WARNING [${w.id}] ${w.message}\n`);
  console.log(formatCounts(counts));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nERROR: ${err.message}\n`);
    process.exit(1);
  });
}
