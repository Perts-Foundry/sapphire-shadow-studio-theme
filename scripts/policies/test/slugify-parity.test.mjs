// The coupling between `slugify` in scripts/policies/lib/policies.mjs and `slugify` in
// assets/policy-nav.js.
//
// Those ids are the shareable /policies/...#section links. If the two implementations drift, the
// manifest pins ids the browser never assigns and the anchor contract quietly stops meaning
// anything. `node --test` cannot run the component (it imports @theme/component and needs a DOM),
// so this extracts the function's source and evaluates that function alone.
//
// What this DOES prove: the two slugify implementations agree, over the real heading texts and a
// deliberately awkward corpus.
//
// What it does NOT prove, and what the manual check in marketing/policies/README.md covers: that
// `extractHeadings` derives the same heading TEXT a browser's `textContent` does. That is the
// entity-decoding and nested-markup half, which needs a real DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, paths } from '../check.mjs';
import { POLICY_TYPES, bodyFromFileText, extractHeadings, slugify } from '../lib/policies.mjs';

const COMPONENT = join(REPO_ROOT, 'assets', 'policy-nav.js');

/**
 * The `slugify` function declared in policy-nav.js, as a callable. Extracted by source rather than
 * imported, because the module's import of `@theme/component` and its `customElements.define` call
 * cannot run under node.
 */
function loadComponentSlugify() {
  const source = readFileSync(COMPONENT, 'utf8');
  // Anchored to the start of a line, so the mention of the same string inside the function's own
  // JSDoc block is not mistaken for the declaration. (It was, the first time.)
  const start = source.indexOf('\nfunction slugify(text) {') + 1;
  assert.notEqual(start, 0, 'policy-nav.js no longer declares `function slugify(text)` at column 0');
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, 'could not find the end of policy-nav.js slugify');
  const body = source.slice(start, end + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return slugify;`)();
}

const componentSlugify = loadComponentSlugify();

/** Deliberately awkward inputs, plus the shapes real policy headings take. */
const CORPUS = [
  'Production & Delivery Times',
  'Custom & Personalized Orders',
  'Questions?',
  'Rush Orders',
  'Lost Package Policy',
  'Porch Piracy & Theft',
  '  leading and trailing  ',
  'MiXeD CaSe',
  'Café Crème',
  'naïve résumé',
  'multiple   internal   spaces',
  'punctuation!@#$%^&*()',
  'trailing hyphens ---',
  '--- leading hyphens',
  '!!!',
  '',
  '123 numbers 456',
  'a'.repeat(80),
  'a'.repeat(49) + ' b',
  'non-breaking space',
  'en–dash',
  'emoji \u{1F600} here',
];

test('the two slugify implementations agree over an awkward corpus', () => {
  for (const input of CORPUS) {
    assert.equal(slugify(input), componentSlugify(input), `slugify disagreed on ${JSON.stringify(input)}`);
  }
});

test('the two slugify implementations agree over every committed heading', () => {
  let checked = 0;
  for (const type of POLICY_TYPES) {
    const body = bodyFromFileText(readFileSync(paths(REPO_ROOT).file(type), 'utf8'));
    for (const heading of extractHeadings(body)) {
      assert.equal(slugify(heading.text), componentSlugify(heading.text), `${type}: ${heading.text}`);
      if (heading.level === 2) {
        assert.equal(heading.id, componentSlugify(heading.text) || 'section', `${type}: ${heading.text}`);
      }
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'no committed headings were checked; the corpus is vacuous');
});

test('both files carry the comment naming the other, so the coupling is discoverable', () => {
  const component = readFileSync(COMPONENT, 'utf8');
  const lib = readFileSync(new URL('../lib/policies.mjs', import.meta.url), 'utf8');
  assert.ok(component.includes('scripts/policies/lib/policies.mjs'), 'policy-nav.js does not name the library');
  assert.ok(lib.includes('assets/policy-nav.js'), 'lib/policies.mjs does not name the component');
});
