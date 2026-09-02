// The marker table covers every audited path: each resolvedPaths() entry (the committed
// scripts/a11y/paths.json with its catalogue products expanded) resolves to a marker rule or to
// an explicit noMarker with a reason. Reading the committed files here is fine; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installFetchGuard } from './harness.mjs';
installFetchGuard();

import { resolvedPaths } from '../../a11y/build-pa11yci.mjs';
import { MARKER_TABLE, markerRuleFor, requiredMarkers, expectedStatusFor } from '../lib/markers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, '..', '..', '..', 'templates');

test('every resolvedPaths() entry has a marker rule or an explicit noMarker', () => {
  const { paths } = resolvedPaths();
  assert.ok(paths.length > 10);
  for (const entry of paths) {
    const rule = markerRuleFor(entry);
    assert.ok(rule, `no marker rule for ${entry.path} (template ${entry.template})`);
    if (rule.noMarker) {
      assert.ok(typeof rule.why === 'string' && rule.why.length > 10, `${entry.path}: noMarker needs a why`);
      assert.deepEqual(requiredMarkers(rule), []);
    } else {
      assert.ok(Array.isArray(rule.markers) && rule.markers.length > 0, `${entry.path}: empty markers`);
      for (const m of rule.markers) assert.ok(typeof m === 'string' && m.length >= 5, `${entry.path}: marker too short`);
    }
  }
});

test('every product template has a rule keyed by its template file', () => {
  const productTemplates = readdirSync(TEMPLATES).filter((f) => /^product\..*\.json$/.test(f)).map((f) => `templates/${f}`);
  assert.ok(productTemplates.length >= 6);
  for (const t of productTemplates) {
    const rule = MARKER_TABLE.byTemplate[t];
    assert.ok(rule && rule.markers, `no product rule for ${t}`);
    // Shift Fuel is the one garment template with no return-policy block, so no acknowledgment
    // input exists to assert there; the size-chart anchor is its stable marker.
    if (t === 'templates/product.shift-fuel-crewneck.json') {
      assert.ok(rule.markers.some((m) => m.includes('SizeChart')), `${t} must assert the size-chart anchor`);
      continue;
    }
    // The tote has no size chart and no acknowledgment block either; its Product Details row
    // carries a committed anchor id for this probe.
    if (t === 'templates/product.shift-fuel-tote.json') {
      assert.ok(rule.markers.some((m) => m.includes('ProductDetails')), `${t} must assert the product-details anchor`);
      continue;
    }
    assert.ok(rule.markers.some((m) => m.includes('properties[')), `${t} must assert an acknowledgment input`);
  }
  for (const t of Object.keys(MARKER_TABLE.byTemplate)) {
    if (t.startsWith('templates/product.')) {
      assert.ok(productTemplates.includes(t), `stale product rule ${t}`);
    }
  }
});

test('resolution order: template, then path prefix, then page type, else null', () => {
  assert.equal(markerRuleFor({ path: '/policies/refund-policy', template: null }).markers[0], 'policy-nav-component');
  assert.equal(markerRuleFor({ path: '/Policies/Refund', template: null }).markers[0], 'policy-nav-component');
  assert.ok(markerRuleFor({ path: '/products/unknown-handle', template: null, pageType: 'product' }).noMarker);
  assert.equal(markerRuleFor({ path: '/nowhere', template: null, pageType: 'mystery' }), null);
  assert.equal(markerRuleFor(null), null);
  assert.equal(expectedStatusFor(markerRuleFor({ path: '/404-x', template: 'templates/404.json' })), 404);
  assert.equal(expectedStatusFor(markerRuleFor({ path: '/', template: 'templates/index.json' })), 200);
  assert.equal(expectedStatusFor(null), 200);
});

test('the key markers the CLAUDE.md contracts name are present', () => {
  const faq = MARKER_TABLE.byTemplate['templates/page.faq.json'].markers;
  assert.ok(faq.includes('away-from-studio'));
  const garment = MARKER_TABLE.byTemplate['templates/product.lead-ii-crewneck.json'].markers;
  assert.ok(garment.includes('id="SizeChart"'));
  assert.ok(MARKER_TABLE.byTemplate['templates/index.json'].markers.includes('hero-lockup'));
  assert.ok(!MARKER_TABLE.byTemplate['templates/product.gift-card.json'].markers.includes('id="SizeChart"'));
});
