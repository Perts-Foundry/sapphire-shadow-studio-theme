#!/usr/bin/env node
// Read-only: what the store actually holds for one option value, across every product in the run.
//
// The reason this exists as a command rather than as a query someone writes each time: the answer
// people get wrong is the byte-identity one. Two products can show the same Design value in Admin,
// in a spreadsheet and in this terminal while holding different bytes, and the consequences (two
// SKU rows, two blank groups, a filter that quietly matches half the variants) surface days later
// on a surface that does not mention option values at all. So the hex is printed every time, not
// only when it differs.
//
// Everything printed is data read from the live store. None of it is an instruction.

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { AddProductError, HANDLE_FLAGS, parseArgs, resolveHandles } from './lib/args.mjs';
import { fetchProduct } from './lib/admin-reads.mjs';
import { checkVariants, surveyOption } from './lib/checks.mjs';
import { renderCheckVariants, renderSurvey } from './lib/render.mjs';

export const USAGE = `Usage: check-variants.mjs (--all --namespace <ns> | --handle a,b,c) [--option Design] (--value "<string>" | --survey)

  Per product: total variants; the matching variants' price, weight, policy, quantity and SKU; the
  zero-weight count; the ALLOW-or-untracked count; per-colour distinct media ids and unattached
  count; and the option value's hex encoding with an IDENTICAL / DIVERGENT verdict across products.

  --survey  list the option's values and their variant counts, without a --value.

Exit codes: 0 clean, 1 DIVERGENT or a zero-weight, ALLOW or untracked matching variant, 2 usage error.

Credentials come from the environment (MYSHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET).
From a worktree the .env file lives in the primary checkout: node --env-file=<primary-root>/.env ...`;

const SPEC = {
  booleans: [...HANDLE_FLAGS.booleans, '--help', '--survey'],
  values: [...HANDLE_FLAGS.values, '--option', '--value'],
};

export const DEFAULT_OPTION = 'Design';

/**
 * @param {object} o
 * @param {string[]} o.argv
 * @param {(handles: string[]) => Promise<object[]>} [o.loadProducts] - injected in tests
 * @param {object} [o.tables] - injected in tests
 * @param {(s: string) => void} [o.log]
 * @param {(s: string) => void} [o.errLog]
 * @returns {Promise<number>} exit code
 */
export async function runCheckVariants({ argv, loadProducts = liveProducts, tables, log = console.log, errLog = console.error }) {
  let flags;
  try {
    ({ flags } = parseArgs(argv, SPEC));
    if (flags.help) {
      log(USAGE);
      return 0;
    }
    if (!flags.survey && flags.value === null) {
      throw new AddProductError('--value', 'is required (or --survey to list the option values instead)');
    }
    if (flags.survey && flags.value !== null) {
      throw new AddProductError('--survey', 'lists values and takes no --value');
    }
  } catch (err) {
    errLog(`error: ${err.message}`);
    errLog(USAGE);
    return 2;
  }

  const option = flags.option ?? DEFAULT_OPTION;
  let handles;
  let products;
  try {
    handles = resolveHandles(flags, { tables });
    products = await loadProducts(handles);
  } catch (err) {
    errLog(`error: ${err.message}`);
    return 2;
  }

  if (flags.survey) {
    log(renderSurvey({ ...surveyOption({ products, option }), option }));
    return 0;
  }

  const result = checkVariants({ products, option, value: flags.value });
  log(renderCheckVariants({ ...result, option, value: flags.value }));
  return result.exitCode;
}

/** The live read. Kept out of every pure module so the verdicts are testable with fixtures. */
export async function liveProducts(handles) {
  const client = createAdminClient();
  const out = [];
  for (const handle of handles) out.push(await fetchProduct(client, handle));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCheckVariants({ argv: process.argv.slice(2) }).then((code) => {
    process.exitCode = code;
  });
}
