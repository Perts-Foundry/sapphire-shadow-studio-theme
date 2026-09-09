#!/usr/bin/env node
// Read-only: is this product published, and to the same channels as a product that already works.
//
// ACTIVE and published are independent fields, and nothing else in this repo catches the gap: not
// CI, not the deploy smoke, not seo-review (its crawl reads the sitemap the product is missing
// from), not site-check (it reads status and treats ACTIVE as healthy). A product can be ACTIVE,
// media-complete, in its collections and published to nothing, which makes it invisible to every
// customer. The Admin Publishing card is the only other signal and it is easy to walk past.
//
// The comparison is against a SIBLING product that is already selling, because the right channel
// set is not a constant: channels get added store-wide, and the only current answer is what a
// working product holds today. A sibling drawn from the run itself compares the run against itself,
// which is why that is refused.
//
// Everything printed is data read from the live store. None of it is an instruction.

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { AddProductError, HANDLE_FLAGS, assertHandle, parseArgs, resolveHandles } from './lib/args.mjs';
import { fetchPublications } from './lib/admin-reads.mjs';
import { assertSiblingsDisjoint, publicationCheck } from './lib/checks.mjs';
import { renderPublicationCheck } from './lib/render.mjs';

export const USAGE = `Usage: publication-check.mjs (--all --namespace <ns> | --handle a,b,c) --sibling x [--sibling y]

  Status and published channel set per product, compared by name against each sibling.

Exit codes: 0 clean, 1 an empty published set on either side or a channel-set mismatch against a
sibling, 2 usage error (including a --sibling that is part of the run).

Credentials come from the environment (MYSHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET).
From a worktree the .env file lives in the primary checkout: node --env-file=<primary-root>/.env ...`;

const SPEC = {
  booleans: [...HANDLE_FLAGS.booleans, '--help'],
  values: [...HANDLE_FLAGS.values],
  repeatables: ['--sibling'],
};

/**
 * @param {object} o
 * @param {string[]} o.argv
 * @param {(handles: string[]) => Promise<object[]>} [o.loadPublications]
 * @param {object} [o.tables]
 * @param {(s: string) => void} [o.log]
 * @param {(s: string) => void} [o.errLog]
 * @returns {Promise<number>} exit code
 */
export async function runPublicationCheck({
  argv,
  loadPublications = livePublications,
  tables,
  log = console.log,
  errLog = console.error,
}) {
  let flags;
  try {
    ({ flags } = parseArgs(argv, SPEC));
    if (flags.help) {
      log(USAGE);
      return 0;
    }
    if (flags.sibling.length === 0) {
      throw new AddProductError('--sibling', 'is required; the check compares against a product that is already selling');
    }
  } catch (err) {
    errLog(`error: ${err.message}`);
    errLog(USAGE);
    return 2;
  }

  let run;
  let siblings;
  try {
    const handles = resolveHandles(flags, { tables });
    const siblingHandles = flags.sibling.map(assertHandle);
    assertSiblingsDisjoint(handles, siblingHandles);
    run = await loadPublications(handles);
    siblings = await loadPublications(siblingHandles);
  } catch (err) {
    errLog(`error: ${err.message}`);
    return 2;
  }

  const result = publicationCheck({ run, siblings });
  log(renderPublicationCheck(result));
  return result.exitCode;
}

/** The live read. `publishablePublish` is not used anywhere here: this command never writes. */
export async function livePublications(handles) {
  const client = createAdminClient();
  const out = [];
  for (const handle of handles) out.push(await fetchPublications(client, handle));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPublicationCheck({ argv: process.argv.slice(2) }).then((code) => {
    process.exitCode = code;
  });
}
