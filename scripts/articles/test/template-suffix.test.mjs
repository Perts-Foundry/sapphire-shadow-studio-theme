// The templateSuffix rule resolves against the REAL repo root, not a fixture.
//
// WHY THIS IS SEPARATE. Shopify's API does NOT validate templateSuffix: an unknown suffix is
// accepted and the article silently falls back to the default layout, which is a defect nobody sees
// until a post looks wrong on the storefront. The repo is therefore the only place the mistake can
// be caught, and catching it means resolving the suffix against the templates that actually exist
// here, which a fixture root cannot answer.
//
// WHAT IS DELIBERATELY NOT ASSERTED: that any particular suffix exists. The first alternate article
// template (`templates/article.photo-story.json`) is being added in a parallel change, so pinning
// its name here would make this suite fail or pass depending on merge order. What is true today and
// will stay true is the shape of the rule: null resolves, and a suffix naming a file that is not
// there is refused.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { templateFileFor } from '../lib/articles.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('a null suffix names no file, which is the default layout', () => {
  assert.equal(templateFileFor(null), null);
  assert.equal(templateFileFor(undefined), null);
});

test('a suffix resolves to templates/article.<suffix>.json', () => {
  assert.equal(templateFileFor('photo-story'), 'templates/article.photo-story.json');
  assert.equal(templateFileFor('shoppable'), 'templates/article.shoppable.json');
});

test('a bogus suffix names a file that is not in this repo', () => {
  // The positive half of the rule, against the REAL root: whatever templates exist, this one does
  // not, so the checker has something to refuse.
  const file = templateFileFor('definitely-not-a-real-template');
  assert.equal(existsSync(join(REPO_ROOT, file)), false);
});

test('the default article template exists, so the resolution target is a real directory', () => {
  // A control. If templates/ moved or the naming changed, every suffix would resolve to a missing
  // file and the rule would refuse every article, which is a failure mode worth catching here
  // rather than in a PR that happens to add a suffix.
  assert.equal(existsSync(join(REPO_ROOT, 'templates', 'article.json')), true);
  const alternates = readdirSync(join(REPO_ROOT, 'templates')).filter((f) => /^article\..+\.json$/.test(f));
  for (const file of alternates) {
    const suffix = file.slice('article.'.length, -'.json'.length);
    assert.equal(templateFileFor(suffix), `templates/${file}`, 'an existing alternate must round-trip through the resolver');
  }
});
