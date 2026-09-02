#!/usr/bin/env node
// Upload processed product photos to Shopify Admin and set their alt text, from the manifest
// produced by process-product-images.mjs. This is the ONE component that writes to the LIVE
// store; there is no staging store, so every safety rail here is load-bearing.
//
//   - One product at a time. You must pass --product <handle> (or --all to opt into every
//     product); --limit caps the count. There is no implicit "upload everything".
//   - --dry-run resolves IDs, validates, builds every GraphQL body, prints the plan, and mutates
//     nothing. Run it first, every time.
//   - Duplication-proof: productCreateMedia has no content dedup, so before creating we query the
//     product's existing media and skip any whose alt or source filename already matches. The
//     manifest upload_status is a fast path, not the integrity boundary.
//   - Bounded authority: creates product media, sets/updates its alt, and (only with
//     --attach-heroes) appends a per-colour hero to a variant. It never deletes media and never
//     edits any other product or variant field.
//   - The alt-colour guard (docs/product-media-alt-text.md) must pass for every row; a row that
//     names zero or the wrong colour value is skipped, never uploaded.
//   - The write token is minted at runtime from SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET and is
//     never printed, never written to the manifest. Auth headers are redacted from every log.
//
// GraphQL bodies were validated with validate_graphql_codeblocks. productCreateMedia is soft-
// deprecated (Shopify suggests productSet); it is kept because it is additive and cannot clobber
// existing media, and the API version is pinned. Alt updates use fileUpdate (not the deprecated
// productUpdateMedia). Resolution uses productByIdentifier (not the deprecated productByHandle).
//
// Requires Node 18+ (global fetch / FormData / Blob). Reads only env + the processed dir.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { allProducts, productForHandle, recognizedColorValues, altColorProblem } from './lib/photo-naming.mjs';
import { paginate } from './blank-inventory/lib/catalogue.mjs';

const API_VERSION = '2026-07';
const REQUIRED_SCOPES = ['write_products', 'write_files'];
const COLOR_OPTION_NAME = 'Color'; // must match the theme setting settings.color_option_name
const PROCESSED_DIR = 'product-images/processed';
const HERO_SHOT_PRIORITY = ['styled', 'flat', 'angled', 'closeup']; // first available wins

// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { dryRun: false, all: false, attachHeroes: false, checkProducts: false, product: null, manifest: null, limit: Infinity };
  const alias = { 'dry-run': 'dryRun', 'attach-heroes': 'attachHeroes', 'check-products': 'checkProducts' };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) continue;
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    const key = alias[a] || a;
    if (key === 'dryRun' || key === 'all' || key === 'attachHeroes' || key === 'checkProducts') {
      opts[key] = val === undefined ? true : val !== 'false';
    } else if (key === 'product') {
      opts.product = val ?? argv[++i];
    } else if (key === 'manifest') {
      opts.manifest = val ?? argv[++i];
      if (opts.manifest === undefined) throw new Error('Missing value for --manifest');
    } else if (key === 'limit') {
      opts.limit = Number(val ?? argv[++i]);
      if (!Number.isFinite(opts.limit) || opts.limit < 1) throw new Error('--limit must be a positive number');
    } else {
      throw new Error(`Unknown option --${a}`);
    }
  }
  if (opts.checkProducts) {
    // The preflight is a standalone read-only mode: no manifest, no upload scoping. Refusing the
    // combinations keeps "did I just upload?" unambiguous.
    if (opts.product || opts.all || opts.dryRun || opts.manifest) {
      throw new Error('--check-products is a standalone preflight; do not combine it with --product, --all, --dry-run, or --manifest.');
    }
    return opts;
  }
  if (!opts.product && !opts.all) {
    throw new Error('Refusing an unscoped run. Pass --product <handle> for one product (do this first), or --all to opt into every product. --dry-run is strongly recommended before any live run.');
  }
  return opts;
}

// ---------------------------------------------------------------------------
// CSV read (comma-aware, matching process-product-images.mjs).
// ---------------------------------------------------------------------------
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

async function readManifest(manifestPath) {
  const text = await readFile(manifestPath, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((l) => {
    const c = parseCsvLine(l);
    const row = {};
    header.forEach((h, i) => { row[h] = c[i] ?? ''; });
    return row;
  });
}

// ---------------------------------------------------------------------------
// Auth. The token is a local, never printed. redact() scrubs it from any string we log.
// ---------------------------------------------------------------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

function makeRedactor(...secrets) {
  const real = secrets.filter(Boolean);
  return (s) => real.reduce((acc, sec) => acc.split(sec).join('[redacted]'), String(s ?? ''));
}

async function mintToken(domain, redact) {
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: requireEnv('SHOPIFY_CLIENT_ID'),
      client_secret: requireEnv('SHOPIFY_CLIENT_SECRET'),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(redact(`Token exchange failed (${res.status}): ${JSON.stringify(body)}`));
  }
  return body.access_token;
}

async function grantedScopes(domain, token) {
  const res = await fetch(`https://${domain}/admin/oauth/access_scopes.json`, {
    headers: { 'X-Shopify-Access-Token': token },
  });
  const body = await res.json().catch(() => ({}));
  return (body.access_scopes || []).map((s) => s.handle);
}

// One GraphQL call. Throws on transport, GraphQL, or *_userErrors, with the token redacted.
async function gql(domain, token, query, variables, redact) {
  const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(redact(`HTTP ${res.status}: ${JSON.stringify(body)}`));
  if (body.errors) throw new Error(redact(`GraphQL errors: ${JSON.stringify(body.errors)}`));
  const data = body.data || {};
  for (const key of Object.keys(data)) {
    const payload = data[key];
    const errs = payload && (payload.userErrors || payload.mediaUserErrors);
    if (Array.isArray(errs) && errs.length) {
      throw new Error(redact(`${key} userErrors: ${JSON.stringify(errs)}`));
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// GraphQL documents (validated).
// ---------------------------------------------------------------------------
const Q_PRODUCT = `query ProductByIdentifier($identifier: ProductIdentifierInput!) {
  productByIdentifier(identifier: $identifier) {
    id title
    options { name optionValues { name } }
    media(first: 250) {
      pageInfo { hasNextPage endCursor }
      nodes { id alt mediaContentType ... on MediaImage { status image { url } } }
    }
    variants(first: 250) {
      pageInfo { hasNextPage endCursor }
      nodes { id title selectedOptions { name value } }
    }
  }
}`;

const Q_PRODUCT_VARIANTS_PAGE = `query ProductVariantsPage($id: ID!, $after: String) {
  product(id: $id) {
    variants(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id title selectedOptions { name value } }
    }
  }
}`;

const Q_PRODUCT_MEDIA_PAGE = `query ProductMediaPage($id: ID!, $after: String) {
  product(id: $id) {
    media(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id alt mediaContentType ... on MediaImage { status image { url } } }
    }
  }
}`;

const Q_MEDIA = `query MediaByProduct($id: ID!) {
  product(id: $id) {
    media(first: 250) {
      pageInfo { hasNextPage endCursor }
      nodes { id alt mediaContentType ... on MediaImage { status image { url } } }
    }
  }
}`;

const M_STAGED = `mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } }
}`;

const M_CREATE = `mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    media { id alt mediaContentType status ... on MediaImage { image { url } } }
    mediaUserErrors { field message }
  }
}`;

const M_FILE_UPDATE = `mutation FileUpdate($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) { files { id alt } userErrors { field message } }
}`;

const M_APPEND_HERO = `mutation ProductVariantAppendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
  productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) { productVariants { id } userErrors { field message } }
}`;

// ---------------------------------------------------------------------------
const basenameOfUrl = (url) => { try { return path.basename(new URL(url).pathname); } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Upload the bytes to a staged target, honouring the returned form parameters, and return the
// resourceUrl to hand to productCreateMedia.
async function stageAndUpload(domain, token, filePath, filename, redact) {
  const bytes = await readFile(filePath);
  const data = await gql(domain, token, M_STAGED, {
    input: [{ filename, mimeType: 'image/jpeg', resource: 'PRODUCT_IMAGE', httpMethod: 'POST', fileSize: String(bytes.length) }],
  }, redact);
  const target = data.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const { name, value } of target.parameters) form.append(name, value);
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), filename);
  const res = await fetch(target.url, { method: 'POST', body: form });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(redact(`staged upload POST failed (${res.status}): ${t.slice(0, 300)}`));
  }
  return target.resourceUrl;
}

// Poll product media until the given id is READY or FAILED, or the timeout elapses.
async function pollMediaReady(domain, token, productId, mediaId, redact) {
  const deadline = Date.now() + 120000; // 2 minutes
  let wait = 1000;
  while (Date.now() < deadline) {
    await sleep(wait);
    // Walk every media page: a lookup by id against a truncated page would leave `node` undefined,
    // and this loop would then run to its deadline and report a processing timeout for media that
    // was actually fine.
    const data = await gql(domain, token, Q_MEDIA, { id: productId }, redact);
    const nodes = await fetchAllConnection(
      (query, variables) => gql(domain, token, query, variables, redact),
      productId, 'media', data.product.media,
    );
    const node = nodes.find((n) => n.id === mediaId);
    const status = node && node.status;
    if (status === 'READY') return 'READY';
    if (status === 'FAILED') throw new Error(`media ${mediaId} processing FAILED`);
    wait = Math.min(wait * 1.5, 8000);
  }
  throw new Error(`media ${mediaId} did not reach READY within timeout`);
}

// Pure drift predicates, exported for unit tests. Each returns an error string or null; the key
// is a product key ('<line>/<garment>', or the handle for a non-garment product). An unknown/null
// key returns null (nothing recorded to drift from; resolveProduct only reaches these with a known
// key anyway). For a non-garment the recorded colour set is empty, so a live Color option on it is
// drift too: the alt guard would have nothing to bind against.
export function gidDriftProblem(liveId, key) {
  const record = allProducts()[key];
  if (!record) return null;
  if (liveId !== record.gid) {
    return `product GID drift for "${record.handle}": live ${liveId} != recorded ${record.gid}. Update catalogue.json after confirming.`;
  }
  return null;
}

export function colorDriftProblem(liveValues, key) {
  const record = allProducts()[key];
  if (!record) return null;
  const expected = recognizedColorValues(key);
  const missing = expected.filter((v) => !liveValues.includes(v));
  const extra = liveValues.filter((v) => !expected.includes(v));
  if (missing.length || extra.length) {
    return `Color option drift for "${record.handle}": live [${liveValues.join(', ')}] vs recorded [${expected.join(', ')}]. Reconcile catalogue.json before uploading (alt bindings depend on it).`;
  }
  return null;
}

/**
 * Read EVERY node of a product's connection, following its pages.
 *
 * WHY THIS EXISTS: the variants query was `variants(first: 100)` with no `hasNextPage` check. The
 * two 8-design products carry 144 variants each (8 designs x 3 colours x 6 sizes), so the read
 * stopped at 100 and the 44 beyond the cap were dropped. Those variants then fell through
 * `if (!hero.mediaId || !variantIds.length) continue;` with no error, so 88 variants across two
 * products silently kept the product-level featured image (a Black garment for every colour) while
 * the run still printed success. A truncated read that reports success is the fail-open shape
 * scripts/seo-review/admin.mjs refuses by design; this follows the pages instead of guessing.
 *
 * The same shape applied to `media`, where the consequence is worse than a miscount:
 * `pollMediaReady` looks the new media up by id in the returned page, so a truncated read would
 * leave it undefined and the poll would run to its deadline and report a PROCESSING TIMEOUT for
 * media that was actually fine. Both connections go through here.
 *
 * Pagination itself is delegated to `paginate()` from blank-inventory's catalogue lib rather than
 * reimplemented: it already carries the malformed-page guard and the runaway-page backstop. The
 * first page is supplied by the caller (Q_PRODUCT already fetched it), so the common single-page
 * case still costs zero extra round trips.
 *
 * @param {(query: string, variables?: object) => Promise<any>} gqlFn
 * @param {string} productId
 * @param {'variants'|'media'} field - which connection to walk
 * @param {{pageInfo?: {hasNextPage?: boolean, endCursor?: string|null}, nodes?: Array}} firstPage
 *   the connection already returned by Q_PRODUCT
 * @returns {Promise<Array<object>>} every node across every page
 */
export async function fetchAllConnection(gqlFn, productId, field, firstPage) {
  const QUERY = field === 'media' ? Q_PRODUCT_MEDIA_PAGE : Q_PRODUCT_VARIANTS_PAGE;
  const { nodes } = await paginate(async (cursor) => {
    // paginate() opens with cursor === null, which is the page the caller already has.
    if (cursor === null) {
      return {
        nodes: firstPage?.nodes ?? [],
        pageInfo: firstPage?.pageInfo ?? { hasNextPage: false, endCursor: null },
      };
    }
    const data = await gqlFn(QUERY, { id: productId, after: cursor });
    const conn = data?.product?.[field];
    if (!conn) {
      throw new Error(`a ${field} page for ${productId} returned no ${field} connection`);
    }
    return conn;
  }, { maxPages: 20 });
  return nodes;
}

// Resolve and validate a product; returns { product, colorValues, key, variantsByColor }.
async function resolveProduct(domain, token, handle, redact) {
  const data = await gql(domain, token, Q_PRODUCT, { identifier: { handle } }, redact);
  const product = data.productByIdentifier;
  if (!product) throw new Error(`no product resolves for handle "${handle}"`);

  // Cross-check against the recorded census: the '<line>/<garment>' entry whose handle matches, or
  // the handle-keyed entry for a non-garment product.
  const known = productForHandle(handle);
  const key = known ? known.key : null;
  if (key) {
    const gidProblem = gidDriftProblem(product.id, key);
    if (gidProblem) throw new Error(gidProblem);
  }

  // Validate the live Color option values against the recorded set (the item-1a runtime diff).
  const colorOption = product.options.find((o) => o.name.toLowerCase() === COLOR_OPTION_NAME.toLowerCase());
  const liveValues = colorOption ? colorOption.optionValues.map((v) => v.name) : [];
  if (key) {
    const colorProblem = colorDriftProblem(liveValues, key);
    if (colorProblem) throw new Error(colorProblem);
  }

  const pageGql = (query, variables) => gql(domain, token, query, variables, redact);
  const variantNodes = await fetchAllConnection(pageGql, product.id, 'variants', product.variants);
  const mediaNodes = await fetchAllConnection(pageGql, product.id, 'media', product.media);

  // Overwrite the first-page connections with the complete node sets. Callers read
  // `product.media.nodes` directly, and leaving a partial first page reachable on the returned
  // object is a trap: it would read as the whole set and silently is not.
  product.variants = { nodes: variantNodes };
  product.media = { nodes: mediaNodes };

  const variantsByColor = new Map();
  for (const v of variantNodes) {
    const opt = v.selectedOptions.find((o) => o.name.toLowerCase() === COLOR_OPTION_NAME.toLowerCase());
    if (!opt) continue;
    if (!variantsByColor.has(opt.value)) variantsByColor.set(opt.value, []);
    variantsByColor.get(opt.value).push(v.id);
  }
  return { product, colorValues: liveValues, key, variantsByColor };
}

// ---------------------------------------------------------------------------
// Preflight support (--check-products). Pure over an injected resolver so it unit-tests without
// a network: loops every recorded product through resolveFn and reports per-product outcomes.
// ---------------------------------------------------------------------------

// Classify a resolveProduct failure so the preflight output distinguishes "the credentials/scopes
// are wrong" (nothing about the products is known) from "the recorded vocab has drifted" (the
// upload blocker this preflight exists to surface early).
export function classifyResolveError(err) {
  const msg = String((err && err.message) || err || '');
  if (/\bdrift\b/i.test(msg)) return 'drift';
  if (/token exchange failed|missing required env|missing required scope|401|403|unauthorized|forbidden|access denied/i.test(msg)) return 'auth';
  return 'other';
}

export async function checkProducts(products, resolveFn) {
  const lines = [];
  let ok = true;
  for (const p of Object.values(products)) {
    try {
      const { colorValues } = await resolveFn(p.handle);
      lines.push(`ok     ${p.handle} [${colorValues.join(', ')}]`);
    } catch (e) {
      ok = false;
      const kind = classifyResolveError(e);
      const label = kind === 'drift' ? 'DRIFT ' : kind === 'auth' ? 'AUTH  ' : 'ERROR ';
      lines.push(`${label} ${p.handle}: ${e.message}`);
    }
  }
  return { ok, lines };
}

// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const domain = requireEnv('MYSHOPIFY_DOMAIN');
  const redact = makeRedactor(process.env.SHOPIFY_CLIENT_SECRET);

  // Read-only preflight: resolve every recorded product against the live store and report GID /
  // Color-option drift per product, without needing a manifest. Run this before naming or
  // processing a batch; it surfaces at minute two the drift that would otherwise hard-fail the
  // upload at the end of the pipeline.
  if (opts.checkProducts) {
    const token = await mintToken(domain, redact);
    const redactTok = makeRedactor(token, process.env.SHOPIFY_CLIENT_SECRET);
    const scopes = await grantedScopes(domain, token);
    const missingScopes = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
    if (missingScopes.length) {
      throw new Error(`Missing required scope(s): ${missingScopes.join(', ')}. The app must grant ${REQUIRED_SCOPES.join(' + ')}; until then upload manually in Admin.`);
    }
    const products = allProducts();
    const { ok, lines } = await checkProducts(products, (handle) => resolveProduct(domain, token, handle, redactTok));
    console.log(`check-products: ${Object.keys(products).length} recorded product(s), scope OK (${REQUIRED_SCOPES.join(', ')})`);
    for (const l of lines) console.log(`  ${l}`);
    if (!ok) {
      console.error('\nOne or more products failed the preflight; uploads to them will hard-fail until reconciled.');
      process.exitCode = 1;
    }
    return;
  }

  // --manifest relocates the manifest; the processed images are expected in the same directory
  // (that is how process-product-images.mjs writes them), so derive the image dir from it.
  const manifestPath = opts.manifest ? path.resolve(opts.manifest) : path.join(PROCESSED_DIR, 'manifest.csv');
  const processedDir = path.dirname(manifestPath);
  const allRows = await readManifest(manifestPath);
  const present = new Set((await readdir(processedDir)).filter((f) => f.toLowerCase().endsWith('.jpg')));

  // Rows eligible for upload: successfully processed, file present, resolved product.
  let rows = allRows.filter((r) => r.new_name && present.has(r.new_name) && r.product);
  if (opts.product) rows = rows.filter((r) => r.product === opts.product);
  if (!rows.length) throw new Error(`No eligible manifest rows${opts.product ? ` for product "${opts.product}"` : ''}.`);

  const token = await mintToken(domain, redact);
  const redactTok = makeRedactor(token, process.env.SHOPIFY_CLIENT_SECRET);
  const scopes = await grantedScopes(domain, token);
  const missingScopes = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
  if (missingScopes.length) {
    throw new Error(`Missing required scope(s): ${missingScopes.join(', ')}. The app must grant ${REQUIRED_SCOPES.join(' + ')}; until then upload manually in Admin.`);
  }

  // Group eligible rows by product, honouring --limit across the whole run.
  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product)) byProduct.set(r.product, []);
    byProduct.get(r.product).push(r);
  }

  console.log(`${opts.dryRun ? 'DRY RUN: ' : ''}uploading for ${byProduct.size} product(s), scope OK (${REQUIRED_SCOPES.join(', ')})`);
  let processed = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const problems = [];

  for (const [handle, productRows] of byProduct) {
    let resolved;
    try {
      resolved = await resolveProduct(domain, token, handle, redactTok);
    } catch (e) {
      problems.push(`${handle}: ${e.message}`);
      continue;
    }
    const { product, key, variantsByColor } = resolved;
    console.log(`\n== ${product.title} (${handle}) ==`);
    const existingByAlt = new Map(product.media.nodes.filter((n) => n.alt).map((n) => [n.alt, n]));
    const existingByFile = new Map(
      product.media.nodes
        .map((n) => [n.image ? basenameOfUrl(n.image.url) : '', n])
        .filter(([b]) => b),
    );
    const heroPlan = new Map(); // color -> { row, mediaId }

    for (const row of productRows) {
      if (processed >= opts.limit) { skipped++; continue; }
      const expected = row.admin_color ? row.admin_color : null;

      if (!row.alt) { problems.push(`${row.new_name}: no alt text; author it in the manifest first`); skipped++; continue; }
      // An unrecorded handle means no recorded GID or Color vocabulary, so the GID check, the drift
      // check and the alt-colour guard above all had nothing to compare against. Refuse rather than
      // upload unguarded: the file header promises the guard passes for EVERY row, and shared-asset
      // rows carry a hand-authored handle, which is exactly where a typo lands. A non-garment
      // product (body null) IS recorded, keyed by handle with an empty colour vocabulary.
      if (!key) {
        problems.push(`${row.new_name}: product "${handle}" is not declared in catalogue.json, so the GID, colour-drift and alt-colour guards cannot run; declare it there before uploading to it`);
        skipped++;
        continue;
      }
      const guard = altColorProblem(row.alt, expected, key);
      if (guard) { problems.push(`${row.new_name}: alt-colour guard: ${guard}`); skipped++; continue; }

      const filePath = path.join(processedDir, row.new_name);

      // Dedup against existing live media.
      const dupe = existingByFile.get(row.new_name) || existingByAlt.get(row.alt);
      if (dupe) {
        if (dupe.alt !== row.alt) {
          if (opts.dryRun) { console.log(`  update-alt  ${row.new_name}  "${dupe.alt || ''}" -> "${row.alt}"`); }
          else {
            await gql(domain, token, M_FILE_UPDATE, { files: [{ id: dupe.id, alt: row.alt }] }, redactTok);
            console.log(`  updated-alt ${row.new_name}`);
          }
          updated++;
        } else {
          console.log(`  skip(dupe)  ${row.new_name}`);
          skipped++;
        }
        if (expected) heroPlan.set(row.admin_color, pickHero(heroPlan.get(row.admin_color), row, dupe.id));
        processed++;
        continue;
      }

      if (opts.dryRun) {
        // A non-garment (handle-keyed, no '/') has no Color option at all; that is a different fact
        // from a shared/group photo on a product that does have colours. Same labels as the processor.
        const colourCell = row.admin_color || (key && !key.includes('/') ? '(no colour option)' : '(shared)');
        console.log(`  create      ${row.new_name}  alt="${row.alt}"  colour=${colourCell}`);
        created++; processed++;
        // Mirror the live create's hero bookkeeping with a placeholder id so a dry run previews the
        // exact --attach-heroes plan for newly-created media, not just for dupes it found live.
        if (expected) heroPlan.set(row.admin_color, pickHero(heroPlan.get(row.admin_color), row, '(dry-run)'));
        continue;
      }

      try {
        const resourceUrl = await stageAndUpload(domain, token, filePath, row.new_name, redactTok);
        const data = await gql(domain, token, M_CREATE, {
          productId: product.id,
          media: [{ originalSource: resourceUrl, alt: row.alt, mediaContentType: 'IMAGE' }],
        }, redactTok);
        const mediaId = data.productCreateMedia.media[0].id;
        await pollMediaReady(domain, token, product.id, mediaId, redactTok);
        console.log(`  created     ${row.new_name}  -> ${mediaId}`);
        created++; processed++;
        if (expected) heroPlan.set(row.admin_color, pickHero(heroPlan.get(row.admin_color), row, mediaId));
      } catch (e) {
        problems.push(`${row.new_name}: ${e.message}`);
        skipped++;
      }
    }

    // Optional per-colour hero attach (off by default; never attaches a shared/group shot).
    if (opts.attachHeroes) {
      for (const [color, hero] of heroPlan) {
        const variantIds = variantsByColor.get(color) || [];
        if (!hero.mediaId || !variantIds.length) continue;
        if (opts.dryRun) { console.log(`  hero        ${color}: ${hero.row.new_name} -> ${variantIds.length} variant(s)`); continue; }
        try {
          await gql(domain, token, M_APPEND_HERO, {
            productId: product.id,
            variantMedia: variantIds.map((variantId) => ({ variantId, mediaIds: [hero.mediaId] })),
          }, redactTok);
          console.log(`  hero        ${color}: attached ${hero.row.new_name}`);
        } catch (e) {
          // A variant that already has media rejects a second; report and move on.
          problems.push(`hero ${color}: ${e.message}`);
        }
      }
    }
  }

  console.log(`\n${opts.dryRun ? '[dry-run] ' : ''}created=${created} updated=${updated} skipped=${skipped}`);
  if (problems.length) {
    console.error('\nProblems:');
    problems.forEach((p) => console.error(`  ${p}`));
    process.exitCode = 1;
  }
  if (opts.dryRun) console.log('\nNo writes performed. Re-run without --dry-run to apply (one --product first).');
}

// Choose the hero row for a colour by shot priority; keep the incumbent if it outranks the candidate.
function pickHero(incumbent, row, mediaId) {
  const rank = (shot) => { const i = HERO_SHOT_PRIORITY.indexOf(shot); return i === -1 ? HERO_SHOT_PRIORITY.length : i; };
  if (!incumbent) return { row, mediaId };
  return rank(row.shot) < rank(incumbent.row.shot) ? { row, mediaId } : incumbent;
}

// Exported for unit testing; the CLI entrypoint below runs only when invoked directly.
export { parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exitCode = 1; });
}
