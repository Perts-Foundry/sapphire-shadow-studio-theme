#!/usr/bin/env node
// Offline lint for scripts/sku/tables.json (`npm run sku:tables`).
//
// Runs in CI, where there are no credentials and no network. It checks the tables can be loaded and
// obey every rule in docs/sku-scheme.md, and it prints the number of codes checked so a lint that
// checked nothing cannot pass: an empty or truncated tables.json would otherwise validate happily
// and report success, which is the fail-open shape this repo refuses everywhere else.

import { pathToFileURL } from 'node:url';
import { loadTables, allCodes, TABLES_PATH } from './lib/tables.mjs';

/**
 * @param {string} [filePath]
 * @returns {Promise<{codes: number, products: number}>}
 * @throws when the tables are invalid or vacuous
 */
export async function checkTables(filePath = TABLES_PATH) {
  const tables = await loadTables(filePath);
  const codes = allCodes(tables);
  const products = Object.keys(tables.products ?? {}).length;
  if (!codes.length || !products) {
    throw new Error(`${filePath} defines ${codes.length} code(s) across ${products} product(s). A lint that checks nothing must not pass.`);
  }
  return { codes: codes.length, products };
}

async function main() {
  const { codes, products } = await checkTables();
  console.log(`sku tables OK: ${codes} codes across ${products} products.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nERROR: ${err.message}\n`);
    process.exit(1);
  });
}
