// Read the product templates as shipped, using the writer's own header-strip and accordion lookup
// so the tests and apply-size-chart.mjs cannot disagree about where a size chart lives.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitHeader, findAccordion } from '../lib/template-writer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..', '..');
export const TEMPLATES_DIR = path.join(ROOT, 'templates');

// Matches the default product.json as well as the suffixed alternates. The default has no template
// on disk today, but it is the one file no profile's handles can ever claim, so the duplicate scan
// is the only check that would ever see it.
const PRODUCT_TEMPLATE_RE = /^product(\..+)?\.json$/;

export const productTemplateFiles = () =>
  readdirSync(TEMPLATES_DIR).filter((f) => PRODUCT_TEMPLATE_RE.test(f)).sort();

export const fileForSuffix = (suffix) => `product.${suffix}.json`;

export function readShippedTemplate(file) {
  const raw = readFileSync(path.join(TEMPLATES_DIR, file), 'utf8');
  return JSON.parse(splitHeader(raw).body);
}

// findAccordion throws for "shape I do not understand" and for "no accordion here", but only the
// first is a test failure: a product template with no accordion is legal and simply has no size
// chart to count. Probe for the benign cases, then delegate so the writer's ambiguity diagnostic
// (more than one accordion) still reaches the test output verbatim.
export function findAccordionOrNull(obj) {
  const details = obj?.sections?.main?.blocks?.['product-details'];
  if (!details || typeof details.blocks !== 'object') return null;
  if (!Object.values(details.blocks).some((b) => b && b.type === 'accordion')) return null;
  return findAccordion(obj);
}

// Every ancestor between the section and the block itself, nearest last. A truthy `disabled` on any
// of them means the storefront renders nothing, however intact the row below it looks. The Admin
// customizer's "hide block" writes exactly this, Admin edits auto-commit to shopify-sync, and
// sync.yml reconciles that onto main, so it arrives without anyone editing a file by hand.
export function disabledAncestors(obj, accId, rowId) {
  const main = obj?.sections?.main;
  const details = main?.blocks?.['product-details'];
  const accordion = details?.blocks?.[accId];
  return [
    ['sections.main', main],
    ["blocks['product-details']", details],
    [`blocks['${accId}']`, accordion],
    [`blocks['${rowId}']`, accordion?.blocks?.[rowId]],
  ]
    .filter(([, node]) => node?.disabled)
    .map(([label]) => label);
}
