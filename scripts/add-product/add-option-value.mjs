#!/usr/bin/env node
// LIVE WRITE, GATED. Adds one option value across a line's products, sets the new variants up, and
// (as a separate invocation) attaches each colour's existing hero to them.
//
// THE PRODUCTS THIS RUNS AGAINST ARE ALREADY ACTIVE AND PUBLISHED. There is no draft to hide behind
// and no deploy between the write and the storefront: the variants this mints are purchasable the
// moment Shopify creates them. That single fact is why the gates below look like the ones on
// policies:push rather than like a confirmation prompt, and why the dry run is the thing the
// operator approves rather than the command line.
//
// Rollback is not symmetrical with the write. Deleting a variant loses its id and its order history
// for good, so the recovery for a half-applied run is --repair (finish the second mutation), never
// "undo the first".
//
// Everything printed and every receipt written is data. A receipt is not an approval, and neither is
// a previous run's.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { AddProductError, parseArgs, resolveHandles } from './lib/args.mjs';
import { fetchProduct } from './lib/admin-reads.mjs';
import { hexOf } from './lib/checks.mjs';
import { GateError, assertExpectations, assertGates } from './lib/gates.mjs';
import {
  OptionValueError,
  addOptionValue,
  appendHeroes,
  assertValueAbsent,
  parseWeights,
  planAddition,
  planHeroAttach,
  setUpVariants,
  variantSetupInput,
  variantsCarrying,
} from './lib/option-value.mjs';
import { OUTPUT_IS_DATA, table } from './lib/render.mjs';
import { receiptsDir, resolveStateDir } from './lib/workdir.mjs';

export const USAGE = `Usage: add-option-value.mjs (--namespace <ns> | --handle a,b,c) --value "<string>" [options]

  --option <name>            the option to add the value to (default Design)
  --price <p>                price for every new variant, as a decimal string
  --weight-lb h=1.6,i=2.1    shipping weight in pounds, one per affected handle
  --dry-run                  print the plan and the pre-flight, write nothing
  --operator-approved        attest that an operator asked for this write in this session
  --expect-handles a,b,c     copied from the dry run; a mismatch aborts
  --expect-new-variants n    copied from the dry run; a mismatch aborts
  --repair                   re-run only the variant setup over variants already carrying --value
  --attach-heroes            separate invocation: append each colour's existing hero to the new
                             variants, skipping any already attached

Sequence: productOptionUpdate adds the value and Shopify mints the variants, then
productVariantsBulkUpdate sets price, weight, tracked and inventoryPolicy DENY on them. If the first
lands and the second fails, --repair finishes the job; it is idempotent.

Gates: CI set is an unconditional refusal, dry run included. No TTY means no write unless
--operator-approved is passed, which is legal only when the response invoking this command quotes
the operator's own words and the ask they answered. Do not fake a terminal. Adding the value and
attaching the heroes are two writes, two dry runs, two asks.

Exit codes: 0 ok, 1 the run found a problem (a STOP, a userError, a count mismatch), 2 usage error
or a refused gate.

Credentials come from the environment (MYSHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET).
From a worktree the .env file lives in the primary checkout: node --env-file=<primary-root>/.env ...`;

const SPEC = {
  booleans: ['--help', '--dry-run', '--operator-approved', '--repair', '--attach-heroes'],
  values: [
    '--namespace',
    '--handle',
    '--option',
    '--value',
    '--price',
    '--weight-lb',
    '--expect-handles',
    '--expect-new-variants',
  ],
};

export const DEFAULT_OPTION = 'Design';

/**
 * @param {object} o
 * @param {string[]} o.argv
 * @param {NodeJS.ProcessEnv} [o.env]
 * @param {boolean} [o.isTTY]
 * @param {object} [o.client] - injected in tests; the live client is built lazily otherwise
 * @param {(handles: string[]) => Promise<object[]>} [o.loadProducts] - injected in tests
 * @param {object} [o.tables] - injected in tests; the committed SKU tables otherwise
 * @param {() => string} [o.now]
 * @param {(s: string) => void} [o.log]
 * @param {(s: string) => void} [o.errLog]
 * @returns {Promise<number>} exit code
 */
export async function runAddOptionValue({
  argv,
  env = process.env,
  isTTY = Boolean(process.stdin.isTTY),
  client: injectedClient,
  loadProducts,
  tables,
  now = () => new Date().toISOString(),
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
    if (flags.repair && flags.attachHeroes) {
      throw new AddProductError('--repair', 'and --attach-heroes are separate runs with separate approvals');
    }
    if (!flags.value) throw new AddProductError('--value', 'is required');

    // The gate runs before anything is read, so a refusal costs nothing and says nothing about the
    // store. CI refuses the dry run too; see lib/gates.mjs for why.
    const gate = assertGates({ env, isTTY, operatorApproved: flags.operatorApproved, mutating: !flags.dryRun });
    if (gate.via === 'operator-approval') {
      log('add-option-value: running without a TTY under --operator-approved (an operator asked for this write).');
    }
  } catch (err) {
    errLog(`error: ${err.message}`);
    if (!(err instanceof GateError)) errLog(USAGE);
    return 2;
  }

  const option = flags.option ?? DEFAULT_OPTION;

  // The live client is built lazily. Constructing it reads MYSHOPIFY_DOMAIN eagerly and throws on
  // an unset one, and a usage refusal should not depend on whether credentials happen to be loaded.
  let lazyClient = injectedClient ?? null;
  const getClient = () => (lazyClient ??= createAdminClient());

  let handles;
  let products;
  let ctx;
  try {
    // --namespace on its own means every product in it; --handle a,b,c is the explicit subset.
    handles = resolveHandles({ all: flags.handle === null, namespace: flags.namespace, handle: flags.handle }, { tables });
    ctx = {
      getClient,
      option,
      value: flags.value,
      flags,
      handles,
      now,
      log,
      errLog,
      stateDir: resolveStateDir(env),
    };
    ctx.load = loadProducts ?? ((hs) => loadLive(getClient(), hs));
    products = await ctx.load(handles);
  } catch (err) {
    errLog(`error: ${err.message}`);
    return 2;
  }

  try {
    if (flags.attachHeroes) return await runAttach(ctx, products);
    if (flags.repair) return await runRepair(ctx, products);
    return await runAdd(ctx, products);
  } catch (err) {
    if (err instanceof AddProductError || err instanceof OptionValueError || err instanceof GateError) {
      errLog(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

async function loadLive(client, handles) {
  const out = [];
  for (const handle of handles) out.push(await fetchProduct(client, handle));
  return out;
}

/** Both expectation flags are required for any live run: they are what the operator approved. */
function requireExpectations(flags) {
  if (flags.expectHandles === null || flags.expectNewVariants === null) {
    throw new AddProductError(
      '--expect-handles',
      'and --expect-new-variants are required for a live run; copy both from the dry run the operator approved',
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Adding the value
// ---------------------------------------------------------------------------------------------

async function runAdd(ctx, products) {
  const { flags, option, value, handles, log } = ctx;
  if (!flags.price) throw new AddProductError('--price', 'is required for a new option value');
  if (!Number.isFinite(Number(flags.price)) || Number(flags.price) <= 0) {
    throw new AddProductError('--price', `"${flags.price}" is not a positive decimal price`);
  }
  const weights = parseWeights(flags.weightLb);

  // Pre-flight. Loose matching, so an existing value that differs only by an invisible character is
  // still a refusal: adding a second one is exactly the mess this directory exists to prevent.
  assertValueAbsent(products, option, value);

  const plan = planAddition({ products, option, value, price: flags.price, weights });
  log(renderPlan({ plan, option, value, mode: 'add' }));

  if (flags.dryRun) {
    log('');
    log(copyLine(handles, plan.totalNew));
    log('dry run: nothing was written.');
    return 0;
  }
  requireExpectations(flags);
  assertExpectations({
    handles,
    newVariants: plan.totalNew,
    expectHandles: flags.expectHandles,
    expectNewVariants: flags.expectNewVariants,
  });

  const receipt = newReceipt(ctx, 'add-option-value');
  let problems = 0;
  for (const row of plan.rows) {
    const payload = await addOptionValue(ctx.getClient(), { productId: row.productId, optionId: row.optionId, value });
    const errors = payload?.userErrors ?? [];
    receipt.mutations.push({ handle: row.handle, mutation: 'productOptionUpdate', userErrors: errors });
    if (errors.length) {
      ctx.errLog(`error: ${row.handle}: productOptionUpdate refused: ${errors.map((e) => e.message).join('; ')}`);
      ctx.errLog('stopping before any further product; the products already written are recorded in the receipt.');
      problems++;
      break;
    }

    // Re-read rather than trusting the payload: productOptionUpdate reports the product's options,
    // not the variants Shopify minted for them, and those ids are what the second mutation needs.
    const [after] = await ctx.load([row.handle]);
    const created = variantsCarrying(after, option, value);
    receipt.created.push({ handle: row.handle, variantIds: created.map((v) => v.id), expected: row.expectedNew });
    if (created.length !== row.expectedNew) {
      ctx.errLog(
        `warning: ${row.handle}: expected ${row.expectedNew} new variant(s), found ${created.length} carrying the value. ` +
          'Setting up what is there; check the matrix before selling.',
      );
      problems++;
    }

    const setup = await setUpVariants(ctx.getClient(), {
      productId: row.productId,
      variants: variantSetupInput(created, { price: row.price, weightLb: row.weightLb }),
    });
    const setupErrors = setup?.userErrors ?? [];
    receipt.mutations.push({ handle: row.handle, mutation: 'productVariantsBulkUpdate', userErrors: setupErrors });
    if (setupErrors.length) {
      ctx.errLog(
        `error: ${row.handle}: productVariantsBulkUpdate refused: ${setupErrors.map((e) => e.message).join('; ')}. ` +
          'The variants exist at Admin defaults on a live product. Re-run with --repair once the cause is fixed.',
      );
      problems++;
    }
  }

  const file = writeReceipt(ctx, receipt);
  log(`receipt: ${file}`);
  log('receipts hold live-store ids; they never go into a commit message, a PR body or a doc.');
  return problems ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Finishing a half-applied run
// ---------------------------------------------------------------------------------------------

async function runRepair(ctx, products) {
  const { flags, option, value, handles, log } = ctx;
  if (!flags.price) throw new AddProductError('--price', 'is required; --repair rewrites price as well as weight');
  const weights = parseWeights(flags.weightLb);
  const rows = products.map((product) => {
    const targets = variantsCarrying(product, option, value);
    if (!weights.has(product.handle)) {
      throw new AddProductError('--weight-lb', `has no weight for ${product.handle}; every affected handle needs one`);
    }
    return { handle: product.handle, productId: product.id, targets, weightLb: weights.get(product.handle) };
  });
  const total = rows.reduce((acc, r) => acc + r.targets.length, 0);

  log(OUTPUT_IS_DATA);
  log(`# --repair: re-running the variant setup for "${value}" (hex ${hexOf(value)}) on option "${option}"`);
  log('');
  log(table(['handle', 'variants carrying the value', 'price', 'weight lb'], rows.map((r) => [r.handle, r.targets.length, flags.price, r.weightLb])));
  if (flags.dryRun) {
    log('');
    log(copyLine(handles, total));
    log('dry run: nothing was written.');
    return 0;
  }
  requireExpectations(flags);
  assertExpectations({ handles, newVariants: total, expectHandles: flags.expectHandles, expectNewVariants: flags.expectNewVariants });

  const receipt = newReceipt(ctx, 'add-option-value --repair');
  let problems = 0;
  for (const row of rows) {
    if (row.targets.length === 0) continue;
    const setup = await setUpVariants(ctx.getClient(), {
      productId: row.productId,
      variants: variantSetupInput(row.targets, { price: flags.price, weightLb: row.weightLb }),
    });
    const errors = setup?.userErrors ?? [];
    receipt.mutations.push({ handle: row.handle, mutation: 'productVariantsBulkUpdate', userErrors: errors });
    receipt.created.push({ handle: row.handle, variantIds: row.targets.map((v) => v.id), expected: row.targets.length });
    if (errors.length) {
      ctx.errLog(`error: ${row.handle}: productVariantsBulkUpdate refused: ${errors.map((e) => e.message).join('; ')}`);
      problems++;
    }
  }
  log(`receipt: ${writeReceipt(ctx, receipt)}`);
  return problems ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Attaching heroes (its own invocation, its own dry run, its own approval)
// ---------------------------------------------------------------------------------------------

async function runAttach(ctx, products) {
  const { flags, option, value, handles, log, errLog } = ctx;
  const plans = products.map((product) => ({ handle: product.handle, productId: product.id, ...planHeroAttach(product, { option, value }) }));

  log(OUTPUT_IS_DATA);
  log(`# --attach-heroes: appending each colour's existing hero to the variants carrying "${value}"`);
  for (const p of plans) {
    log('');
    log(p.handle);
    log(
      table(
        ['colour', 'hero id', 'targets', 'to attach', 'already attached', 'note'],
        p.colors.map((c) => [
          c.color,
          c.heroId ?? (c.heroIds.length ? `${c.heroIds.length} distinct: ${c.heroIds.join(' ')}` : '(none)'),
          c.targets.length,
          c.attach.length,
          c.alreadyAttached,
          c.note ?? '',
        ]),
      ),
    );
  }

  const stops = plans.flatMap((p) => p.stops);
  if (stops.length) {
    errLog('');
    errLog('STOP: a colour has more than one hero media id on its existing variants.');
    for (const s of stops) errLog(`  - ${s}`);
    errLog('Nothing was written. Which id is the hero is a decision, not something this command may pick.');
    return 1;
  }

  const total = plans.reduce((acc, p) => acc + p.attachments.length, 0);
  if (flags.dryRun) {
    log('');
    log(copyLine(handles, total));
    log('dry run: nothing was written.');
    return 0;
  }
  requireExpectations(flags);
  assertExpectations({ handles, newVariants: total, expectHandles: flags.expectHandles, expectNewVariants: flags.expectNewVariants });

  const receipt = newReceipt(ctx, 'add-option-value --attach-heroes');
  let problems = 0;
  for (const p of plans) {
    if (p.attachments.length === 0) continue;
    const payload = await appendHeroes(ctx.getClient(), {
      productId: p.productId,
      variantMedia: p.attachments.map((a) => ({ variantId: a.variantId, mediaIds: a.mediaIds })),
    });
    const errors = payload?.userErrors ?? [];
    receipt.mutations.push({ handle: p.handle, mutation: 'productVariantAppendMedia', userErrors: errors });
    receipt.created.push({ handle: p.handle, variantIds: p.attachments.map((a) => a.variantId), expected: p.attachments.length });
    if (errors.length) {
      errLog(`error: ${p.handle}: productVariantAppendMedia refused: ${errors.map((e) => e.message).join('; ')}`);
      problems++;
    }
  }
  log(`receipt: ${writeReceipt(ctx, receipt)}`);
  return problems ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Output and receipts
// ---------------------------------------------------------------------------------------------

export function renderPlan({ plan, option, value }) {
  const out = [
    OUTPUT_IS_DATA,
    `# phase 0: adding "${value}" (hex ${hexOf(value)}) to option "${option}"`,
    '# pre-flight passed: the value exists on none of these products.',
    '',
    table(
      ['handle', 'status', 'option', 'existing values', 'new variants', 'price', 'weight lb', 'policy', 'qty', 'tracked'],
      plan.rows.map((r) => [
        r.handle,
        r.status,
        r.optionName,
        r.existingValues,
        r.expectedNew,
        r.price,
        r.weightLb,
        'DENY',
        0,
        'true',
      ]),
    ),
    '',
    `total new variants: ${plan.totalNew}`,
    'these products are ACTIVE and published: every variant this creates is purchasable at once.',
  ];
  return out.join('\n');
}

/** The exact flags to copy into the live run, so the approved numbers are the run numbers. */
export function copyLine(handles, total) {
  return `to run this live: --expect-handles ${handles.join(',')} --expect-new-variants ${total}`;
}

function newReceipt(ctx, command) {
  return {
    command,
    timestamp: ctx.now(),
    option: ctx.option,
    value: ctx.value,
    valueHex: hexOf(ctx.value),
    handles: ctx.handles,
    created: [],
    mutations: [],
  };
}

/**
 * Write the receipt.
 *
 * Written even when the run failed partway, because a half-applied write is exactly the run whose
 * record matters: --repair needs to know what exists.
 */
function writeReceipt(ctx, receipt) {
  const dir = receiptsDir(ctx.stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = receipt.timestamp.replace(/[:.]/g, '-');
  const file = path.join(dir, `option-value-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAddOptionValue({ argv: process.argv.slice(2) }).then((code) => {
    process.exitCode = code;
  });
}
