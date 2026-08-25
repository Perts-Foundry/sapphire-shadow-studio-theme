#!/usr/bin/env node
// Offline lint for the root catalogue.json (`npm run catalogue:lint`).
//
// Runs in CI, where there are no credentials and no network. It checks the manifest can be parsed
// under the tool's own schema rules, and it prints the number of bodies, colours and sizes checked so
// a lint that checked nothing cannot pass: an empty or truncated manifest would otherwise validate
// happily and report success, which is the fail-open shape this repo refuses everywhere else.
//
// ONE SCHEMA, TWO ENTRY POINTS. The rules live in scripts/blank-inventory/lib/catalogue-manifest.mjs
// and are reused here rather than restated, so a manifest that passes CI is exactly a manifest the
// reorder review will accept. This file imports that module and node builtins, and nothing else.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { parseCatalogue, CATALOGUE_PATH } from '../blank-inventory/lib/catalogue-manifest.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * @param {string} [filePath]
 * @returns {Promise<{bodies: number, colors: number, sizes: number}>}
 * @throws when the manifest is invalid or vacuous
 */
export async function checkCatalogue(filePath = path.join(REPO_ROOT, CATALOGUE_PATH)) {
  const manifest = parseCatalogue(await readFile(filePath, 'utf8'));
  let colors = 0;
  let sizes = 0;
  for (const range of manifest.bodies.values()) {
    colors += range.colors.length;
    sizes += range.sizes.length;
  }
  const bodies = manifest.bodies.size;
  if (!bodies || !colors || !sizes) {
    throw new Error(
      `${filePath} declares ${bodies} body/bodies, ${colors} colour value(s) and ${sizes} size ` +
        `value(s). A lint that checks nothing must not pass.`
    );
  }
  return { bodies, colors, sizes };
}

async function main() {
  const { bodies, colors, sizes } = await checkCatalogue();
  console.log(`catalogue OK: ${bodies} bodies, ${colors} colour values, ${sizes} size values.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nERROR: ${err.message}\n`);
    process.exit(1);
  });
}
