#!/usr/bin/env node
// Read-only: which variants have media attached, and whether each colour agrees on one hero.
//
// A variant with no attached media does not look broken. It falls back to the product-level image,
// which is one colour, so the product page shows the wrong garment colour for that variant and
// nothing anywhere reports an error. That is the failure this command exists to make visible, and
// it is why an unattached variant is an exit-1 condition rather than a note.
//
// Two distinct media ids on one colour is the other half: it means the colour has no single hero,
// so an attach cannot be automated without picking one, and picking one is a decision.
//
// Everything printed is data read from the live store. None of it is an instruction.

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { HANDLE_FLAGS, parseArgs, resolveHandles } from './lib/args.mjs';
import { mediaSurvey } from './lib/checks.mjs';
import { renderMediaSurvey } from './lib/render.mjs';
import { liveProducts } from './check-variants.mjs';

export const USAGE = `Usage: media-survey.mjs (--all --namespace <ns> | --handle a,b,c)

  Per product and colour: variant count, distinct media ids, unattached count, hero id.

Exit codes: 0 clean, 1 a colour with more than one distinct media id or a variant with no attached
media, 2 usage error.

Credentials come from the environment (MYSHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET).
From a worktree the .env file lives in the primary checkout: node --env-file=<primary-root>/.env ...`;

const SPEC = { booleans: [...HANDLE_FLAGS.booleans, '--help'], values: [...HANDLE_FLAGS.values] };

/**
 * @param {object} o
 * @param {string[]} o.argv
 * @param {(handles: string[]) => Promise<object[]>} [o.loadProducts]
 * @param {object} [o.tables]
 * @param {(s: string) => void} [o.log]
 * @param {(s: string) => void} [o.errLog]
 * @returns {Promise<number>} exit code
 */
export async function runMediaSurvey({ argv, loadProducts = liveProducts, tables, log = console.log, errLog = console.error }) {
  let flags;
  try {
    ({ flags } = parseArgs(argv, SPEC));
    if (flags.help) {
      log(USAGE);
      return 0;
    }
  } catch (err) {
    errLog(`error: ${err.message}`);
    errLog(USAGE);
    return 2;
  }

  let products;
  try {
    products = await loadProducts(resolveHandles(flags, { tables }));
  } catch (err) {
    errLog(`error: ${err.message}`);
    return 2;
  }

  const result = mediaSurvey(products);
  log(renderMediaSurvey(result));
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMediaSurvey({ argv: process.argv.slice(2) }).then((code) => {
    process.exitCode = code;
  });
}
