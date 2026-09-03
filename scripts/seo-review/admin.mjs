#!/usr/bin/env node
//
// admin.mjs -- read-only Admin API SEO pass (mode: admin).
//
// WHY: the storefront hides the stored values behind render-time fallbacks
// (a null product SEO title renders as the product title, which is how the
// original audit's B5 miscount happened). This mode reads what is actually
// STORED: product/collection seo fields, page title/description metafields,
// variant SKUs, and blog article counts. The shopify MCP does not expose the
// seo field at all, hence the direct GraphQL call (docs/shopify-mcp-notes.md).
//
// SECURITY (public repo): the Admin client is the proven one from
// scripts/blank-inventory/lib/admin.mjs: token minted lazily from
// SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET, never printed or written to
// disk, and redacted from every error it throws. This script performs no
// mutations.
//
// USAGE: node scripts/seo-review/admin.mjs [--full] [--no-save]
//   Requires MYSHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET.

import { createAdminClient } from '../blank-inventory/lib/admin.mjs';
import { readCommittedCatalogue, nonGarmentProducts } from '../lib/catalogue-manifest.mjs';
import {
  ERROR, WARN, TITLE_MAX, DESC_MIN, DESC_MAX,
  BREADCRUMB_EXCLUDED_HANDLES, BREADCRUMB_PREFERRED_HANDLES,
} from './lib/checks.mjs';
import { finishRun } from './lib/report.mjs';

function arg(flag) { return process.argv.includes(flag); }

// Caps sized to the current catalogue with generous headroom. If a
// connection reports another page, the run FAILS LOUDLY (admin-read-truncated
// ERROR) rather than silently auditing a subset: a truncated read that greens
// is the fail-open shape this tool exists to prevent.
const QUERY = `
{
  products(first: 100) {
    pageInfo { hasNextPage }
    edges { node {
      handle title
      seo { title description }
      breadcrumbCollection: metafield(namespace: "custom", key: "breadcrumb_collection") {
        value
        reference { ... on Collection { handle } }
      }
      variants(first: 250) {
        pageInfo { hasNextPage }
        edges { node { sku } }
      }
    } }
  }
  collections(first: 100) {
    pageInfo { hasNextPage }
    edges { node { handle title description seo { title description } } }
  }
  pages(first: 100) {
    pageInfo { hasNextPage }
    edges { node {
      handle title
      titleTag: metafield(namespace: "global", key: "title_tag") { value }
      descriptionTag: metafield(namespace: "global", key: "description_tag") { value }
    } }
  }
  blogs(first: 25) {
    pageInfo { hasNextPage }
    edges { node { handle articlesCount { count } } }
  }
}`;

function checkSeoText(findings, kind, handle, seo) {
  const url = `admin:${kind}/${handle}`;
  const title = seo && seo.title;
  const description = seo && seo.description;
  if (!title) {
    findings.push({
      check: `${kind}-seo-title-missing`, severity: WARN, url,
      detail: 'stored SEO title is null (renders as the resource title; no keyword control)',
    });
  } else if (title.length > TITLE_MAX) {
    findings.push({
      check: `${kind}-seo-title-long`, severity: WARN, url,
      detail: `${title.length} chars (target <= ${TITLE_MAX})`,
    });
  }
  if (!description) {
    findings.push({
      check: `${kind}-seo-description-missing`, severity: ERROR, url,
      detail: 'no stored SEO description',
    });
  } else if (description.length < DESC_MIN || description.length > DESC_MAX) {
    findings.push({
      check: `${kind}-seo-description-length`, severity: WARN, url,
      detail: `${description.length} chars (target ${DESC_MIN}-${DESC_MAX})`,
    });
  }
  return description || null;
}

/**
 * True when a rich-text body is effectively empty once markup artifacts are
 * gone. Admin's editor can leave `<p></p>` or bare `&nbsp;` in a "blank"
 * field; those must not count as body copy.
 */
export function isEffectivelyEmpty(text) {
  return (text || '').replace(/<[^>]*>|&nbsp;/gi, ' ').trim().length === 0;
}

/**
 * Products where a blank `custom.breadcrumb_collection` is the correct
 * configuration (docs/breadcrumb-collection-metafield.md: the gift card's
 * two-item "Home > Gift Card" trail needs no parent). The missing-value WARN
 * skips these so the check can reach zero findings once every other product
 * is set.
 *
 * DERIVED, and this fixed a real bug. The set was the literal `['gift-card']`,
 * compared against `p.handle`, which the Admin API returns as
 * `sapphire-shadow-studio-gift-card`. The two never matched, so the skip had
 * never once fired and the gift card had been WARNing since the check shipped.
 * A non-garment is exactly the product with no parent collection to name, so
 * the manifest already knows which products belong here. HANDLES ONLY: the set
 * is compared against `p.handle` and nothing else, and `gift-card` (the
 * TEMPLATE suffix) in the set was exactly the handle/template confusion the
 * old literal shipped with.
 *
 * @param {object} [manifest]
 * @returns {Set<string>}
 */
export function breadcrumbBlankOkHandles(manifest = readCommittedCatalogue()) {
  return new Set(nonGarmentProducts(manifest).map((p) => p.handle));
}

/**
 * Findings for the per-product `custom.breadcrumb_collection` metafield that
 * snippets/breadcrumbs.liquid reads as step 2 of its four-step parent cascade.
 *
 * Keyed per product rather than aggregated into one counter, so the baseline
 * differ names which product regressed instead of moving a number.
 *
 * @param {Array<{handle:string, breadcrumbCollection:?{value:?string, reference:?{handle:string}}}>} products
 * @returns {Array<{check:string, severity:string, url:string, detail:string}>}
 */
export function breadcrumbCollectionFindings(products, { manifest } = {}) {
  const blankOk = breadcrumbBlankOkHandles(manifest ?? readCommittedCatalogue());
  const findings = [];
  for (const p of products) {
    const url = `admin:product/${p.handle}`;
    const mf = p.breadcrumbCollection;
    // A nil reference with a non-nil value means the referenced collection was
    // deleted. The theme cannot tell that apart from unset (both render blank),
    // so neither does this check.
    const handle = mf && mf.reference ? mf.reference.handle : null;
    if (!handle) {
      if (blankOk.has(p.handle)) continue;
      findings.push({
        check: 'product-breadcrumb-collection-missing', severity: WARN, url,
        detail: `no custom.breadcrumb_collection reference; the breadcrumb parent falls back to the theme's preferred-handle list (${BREADCRUMB_PREFERRED_HANDLES.join(', ')})`,
      });
    } else if (BREADCRUMB_EXCLUDED_HANDLES.has(handle)) {
      findings.push({
        check: 'product-breadcrumb-collection-catchall', severity: WARN, url,
        detail: `custom.breadcrumb_collection points at the catch-all "${handle}", which the theme ignores; the value looks set in Admin but has no effect`,
      });
    }
  }
  return findings;
}

/**
 * Findings for preferred-handle entries that name no existing collection.
 *
 * Step 3 of the cascade scans a hardcoded handle list, and the snippet skips a
 * handle that does not resolve without any error, which is the quiet failure
 * the list's own comment warns about. Nothing checked the entries themselves:
 * `healthcare` sat in the list while the store's collection was
 * `healthcare-collection`, so Healthcare Collection could never win at step 3
 * and every multi-collection product fell through to step 4's arbitrary order.
 *
 * A dead entry is an ERROR, not a WARN: unlike a missing metafield, which has a
 * working fallback behind it, this silently removes a rung from the cascade.
 *
 * Absence is only meaningful over a COMPLETE collection list, so a truncated
 * read suppresses this entirely rather than reporting handles that may sit on
 * an unread page. The caller still fails, on `admin-read-truncated`, which says
 * what actually went wrong instead of naming innocent handles.
 *
 * @param {Array<{handle:string}>} collections every collection in the store
 * @param {boolean} [complete] false when the collections read was truncated
 * @returns {Array<{check:string, severity:string, url:string, detail:string}>}
 */
export function breadcrumbPreferredHandleFindings(collections, complete = true) {
  if (!complete) return [];
  const live = new Set(collections.map((c) => c.handle));
  return BREADCRUMB_PREFERRED_HANDLES
    .filter((h) => !live.has(h))
    .map((h) => ({
      check: 'breadcrumb-preferred-handle-missing', severity: ERROR,
      url: `admin:collection/${h}`,
      detail: `the theme's preferred-handle list names "${h}", which is not a collection in this store; `
        + 'the snippet skips it silently, so that rung of the breadcrumb cascade never fires. '
        + 'Fix preferred_handles in snippets/breadcrumbs.liquid and BREADCRUMB_PREFERRED_HANDLES '
        + 'in scripts/seo-review/lib/checks.mjs together.',
    }));
}

async function main() {
  const log = (l) => process.stdout.write(l + '\n');
  for (const v of ['MYSHOPIFY_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET']) {
    if (!process.env[v]) {
      log(`admin mode needs MYSHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET; ${v} is missing.`);
      process.exit(2);
    }
  }

  const client = createAdminClient(
    process.env.SHOPIFY_API_VERSION ? { apiVersion: process.env.SHOPIFY_API_VERSION } : {},
  );
  log(`seo-review admin (read-only): ${process.env.MYSHOPIFY_DOMAIN}, API ${client.apiVersion}`);
  const data = await client.gql(QUERY);

  const findings = [];
  const descriptions = new Map(); // description text -> [resource labels]

  // Loud truncation guard on every connection (see QUERY comment).
  const truncated = [];
  for (const key of ['products', 'collections', 'pages', 'blogs']) {
    if (data[key]?.pageInfo?.hasNextPage) truncated.push(key);
  }

  const products = data.products.edges.map((e) => e.node);
  const collections = data.collections.edges.map((e) => e.node);
  const pages = data.pages.edges.map((e) => e.node);
  const blogs = data.blogs.edges.map((e) => e.node);
  log(`read ${products.length} product(s), ${collections.length} collection(s), ${pages.length} page(s), ${blogs.length} blog(s)`);

  let skuMissing = 0;
  let variantTotal = 0;
  for (const p of products) {
    if (p.variants.pageInfo.hasNextPage) truncated.push(`product/${p.handle} variants`);
    const desc = checkSeoText(findings, 'product', p.handle, p.seo);
    if (desc) descriptions.set(desc, [...(descriptions.get(desc) || []), `product/${p.handle}`]);
    for (const v of p.variants.edges) {
      variantTotal += 1;
      if (!v.node.sku) skuMissing += 1;
    }
  }
  findings.push(...breadcrumbCollectionFindings(products));
  findings.push(...breadcrumbPreferredHandleFindings(collections, !truncated.includes('collections')));
  if (truncated.length > 0) {
    findings.push({
      check: 'admin-read-truncated', severity: ERROR, url: 'admin:query',
      detail: `connection(s) exceeded the query cap and were NOT fully audited: ${truncated.join(', ')}. Raise the first: argument or add pagination before trusting this run.`,
    });
  }
  for (const c of collections) {
    const desc = checkSeoText(findings, 'collection', c.handle, c.seo);
    if (desc) descriptions.set(desc, [...(descriptions.get(desc) || []), `collection/${c.handle}`]);
    if (isEffectivelyEmpty(c.description)) {
      findings.push({
        check: 'collection-body-empty', severity: WARN, url: `admin:collection/${c.handle}`,
        detail: 'collection has no body copy (an empty grid is a thin landing page)',
      });
    }
  }
  for (const pg of pages) {
    if (!pg.titleTag || !pg.titleTag.value) {
      findings.push({
        check: 'page-seo-title-missing', severity: WARN, url: `admin:page/${pg.handle}`,
        detail: 'no title_tag metafield (global namespace); renders as the page title',
      });
    }
    if (!pg.descriptionTag || !pg.descriptionTag.value) {
      findings.push({
        check: 'page-seo-description-missing', severity: ERROR, url: `admin:page/${pg.handle}`,
        detail: 'no description_tag metafield (global namespace)',
      });
    }
  }

  // The B1 defect class: the same stored description on two resources.
  for (const [text, owners] of descriptions) {
    if (owners.length > 1) {
      findings.push({
        check: 'admin-description-duplicate', severity: ERROR, url: `admin:${owners[0]}`,
        detail: `identical stored SEO description on: ${owners.join(', ')} ("${text.slice(0, 50)}...")`,
      });
    }
  }

  if (skuMissing > 0) {
    findings.push({
      check: 'variant-sku-missing', severity: WARN, url: 'admin:variants',
      detail: `${skuMissing} of ${variantTotal} variants have no SKU`,
    });
  }
  for (const b of blogs) {
    const count = b.articlesCount ? b.articlesCount.count : null;
    if (count === 0) {
      findings.push({
        check: 'blog-empty', severity: WARN, url: `admin:blog/${b.handle}`,
        detail: 'blog has zero articles (its listing is noindexed while empty, per snippets/meta-tags.liquid)',
      });
    }
  }

  const exitCode = finishRun('admin', findings, {
    full: arg('--full'),
    noSave: arg('--no-save'),
    meta: { products: products.length, collections: collections.length, pages: pages.length },
    log,
  });
  process.exit(exitCode);
}

// Only run the CLI when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // The client redacts its own errors; strip the secret again regardless.
    let msg = String(e && e.message ? e.message : 'error');
    const secret = process.env.SHOPIFY_CLIENT_SECRET;
    if (secret) msg = msg.split(secret).join('[REDACTED]');
    process.stderr.write(`seo-review admin: fatal (${msg})\n`);
    process.exit(1);
  });
}
