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
// SECURITY (public repo): the token is minted at runtime from
// SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET, held in memory, and NEVER
// printed, logged, or written to disk. This script performs no mutations.
//
// USAGE: node scripts/seo-review/admin.mjs [--full] [--no-save]
//   Requires MYSHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET.

import { ERROR, WARN } from './lib/checks.mjs';
import { finishRun } from './lib/report.mjs';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-01';
const DESC_MIN = 50;
const DESC_MAX = 160;
const TITLE_MAX = 60;

function arg(flag) { return process.argv.includes(flag); }

async function mintToken(domain) {
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const data = await res.json();
  if (!data.access_token) throw new Error('token exchange returned no token');
  return data.access_token;
}

async function gql(domain, token, query) {
  const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(`GraphQL errors: ${data.errors.map((e) => e.message).join('; ')}`);
  return data.data;
}

const QUERY = `
{
  products(first: 100) {
    edges { node {
      handle title
      seo { title description }
      variants(first: 250) { edges { node { sku } } }
    } }
  }
  collections(first: 50) {
    edges { node { handle title description seo { title description } } }
  }
  pages(first: 100) {
    edges { node {
      handle title
      titleTag: metafield(namespace: "global", key: "title_tag") { value }
      descriptionTag: metafield(namespace: "global", key: "description_tag") { value }
    } }
  }
  blogs(first: 10) {
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

async function main() {
  const log = (l) => process.stdout.write(l + '\n');
  const domain = process.env.MYSHOPIFY_DOMAIN;
  if (!domain || !process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET) {
    log('admin mode needs MYSHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET in the environment.');
    process.exit(2);
  }

  log(`seo-review admin (read-only): ${domain}, API ${API_VERSION}`);
  const token = await mintToken(domain);
  const data = await gql(domain, token, QUERY);

  const findings = [];
  const descriptions = new Map(); // description text -> [resource labels]

  const products = data.products.edges.map((e) => e.node);
  const collections = data.collections.edges.map((e) => e.node);
  const pages = data.pages.edges.map((e) => e.node);
  const blogs = data.blogs.edges.map((e) => e.node);
  log(`read ${products.length} product(s), ${collections.length} collection(s), ${pages.length} page(s), ${blogs.length} blog(s)`);

  let skuMissing = 0;
  let variantTotal = 0;
  for (const p of products) {
    const desc = checkSeoText(findings, 'product', p.handle, p.seo);
    if (desc) descriptions.set(desc, [...(descriptions.get(desc) || []), `product/${p.handle}`]);
    for (const v of p.variants.edges) {
      variantTotal += 1;
      if (!v.node.sku) skuMissing += 1;
    }
  }
  for (const c of collections) {
    const desc = checkSeoText(findings, 'collection', c.handle, c.seo);
    if (desc) descriptions.set(desc, [...(descriptions.get(desc) || []), `collection/${c.handle}`]);
    if (!c.description || c.description.trim().length === 0) {
      findings.push({
        check: 'collection-body-empty', severity: WARN, url: `admin:collection/${c.handle}`,
        detail: 'collection has no body copy (an empty grid is a thin landing page)',
      });
    }
  }
  for (const pg of pages) {
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
        detail: 'blog has zero articles but its listing page is indexable',
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

main().catch((e) => {
  // Redact defensively: an error message must never carry the secret.
  let msg = String(e && e.message ? e.message : 'error');
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (secret) msg = msg.split(secret).join('[REDACTED]');
  process.stderr.write(`seo-review admin: fatal (${msg})\n`);
  process.exit(1);
});
