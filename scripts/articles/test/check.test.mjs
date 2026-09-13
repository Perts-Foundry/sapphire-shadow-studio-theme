// scripts/articles/check.mjs: every rule, one case each, plus the meta-test that keeps the set
// honest.
//
// THE SHAPE OF THIS SUITE. A committed clean article passes every rule. Each case then applies ONE
// mutation to a disposable copy of it and asserts that exactly one rule id fires, and that it is
// the expected one. Two properties come out of that which neither half gives alone:
//
//   - No rule is decorative. A rule nobody can trip is a rule that does not work, and the meta-test
//     at the bottom refuses any id in RULES that no case exercises.
//   - No rule is over-broad. A case that trips its own id AND two others means the mutation is not
//     isolated or the rules overlap, and both are bugs worth failing on. This is the assertion that
//     would have caught a checker that simply refused everything.
//
// EVERY PATH IS UNDER A TEMP ROOT, asserted in an after() hook.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { check } from '../check.mjs';
import { ALL_RULE_IDS, RULES, metaSha256, sha256 } from '../lib/articles.mjs';
import {
  HANDLE,
  addSecondArticle,
  cleanRoot,
  cleanup,
  madeRoots,
  readArticle,
  readBody,
  readImages,
  readManifestFile,
  reindexHandle,
  withRealCatalogue,
  writeArticle,
  writeBody,
  writeImages,
  writeManifestFile,
} from './helpers.mjs';

const TEMP_ROOT = statSync(tmpdir()).isDirectory() ? tmpdir() : null;

/** Every rule id some case in this file expects to fire. Filled by `expectRule`. */
const EXERCISED = new Set();

after(() => {
  assert.ok(TEMP_ROOT, 'no usable temp directory');
  const roots = madeRoots();
  assert.ok(roots.length > 0, 'the temp-root guard ran before anything was created, so it checked nothing');
  for (const root of roots) assert.ok(root.startsWith(TEMP_ROOT), `${root} is not under the temp root`);
  cleanup();
});

/** The rule ids a root's findings carry, deduplicated and sorted. */
function rulesFired(root) {
  return [...new Set(check(root).findings.map((f) => f.rule))].sort();
}

/**
 * Apply a mutation and assert it trips EXACTLY the named rule.
 *
 * The exactness is the point. Asserting only that the expected id appears would pass for a checker
 * that refused every article for every reason.
 */
function expectRule(name, rule, mutate) {
  EXERCISED.add(rule);
  test(name, () => {
    const root = cleanRoot();
    mutate(root);
    assert.deepEqual(rulesFired(root), [rule], `expected exactly ${rule}`);
  });
}

// ---------------------------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------------------------

test('the committed clean article passes every rule', () => {
  const root = cleanRoot();
  const { findings, notes } = check(root);
  assert.deepEqual(findings, [], 'the golden article must be clean, or every case below is measuring noise');
  // The degradation is REPORTED, never silent: this root has no catalogue and no local image bytes.
  assert.ok(notes.some((n) => n.includes('catalogue')), 'the absent catalogue must be noted');
  assert.ok(notes.some((n) => n.includes('article-images')), 'the absent image root must be noted');
});

// ---------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------

expectRule('a handle that is not kebab-case', RULES.HANDLE_SHAPE, (root) => {
  // The second directory gets an entry computed from ITS OWN files. Copying the first article's
  // entry was the obvious shortcut and it is wrong: the copy's metaSha256 describes a different
  // handle, so the case also tripped the hash rule and failed for a reason unrelated to the shape.
  const bad = 'Not_A_Handle';
  addSecondArticle(root, bad);
  reindexHandle(root, bad);
});

expectRule('a missing file in an article directory', RULES.MISSING_FILE, (root) => {
  rmSync(join(root, 'marketing', 'articles', HANDLE, 'images.json'));
});

expectRule('a stray file directly under marketing/articles', RULES.UNEXPECTED_FILE, (root) => {
  writeFileSync(join(root, 'marketing', 'articles', 'notes.txt'), 'scratch\n', 'utf8');
});

expectRule('a manifest entry with no directory', RULES.MANIFEST_ORPHAN, (root) => {
  const manifest = readManifestFile(root);
  manifest.articles['a-ghost'] = { ...manifest.articles[HANDLE] };
  writeManifestFile(root, manifest);
});

expectRule('a directory with no manifest entry', RULES.DIRECTORY_UNLISTED, (root) => {
  addSecondArticle(root, 'a-second-post');
});

expectRule('a body that is not in canonical form', RULES.NOT_CANONICAL, (root) => {
  writeBody(root, `${readBody(root).trimEnd()}   \n`);
});

expectRule('an unknown key in article.json', RULES.UNKNOWN_KEY, (root) => {
  const article = readArticle(root);
  article.publishedAt = '2026-09-13';
  writeArticleKeepingHashes(root, article);
});

expectRule('article.json declaring a different handle', RULES.DIR_NAME_MISMATCH, (root) => {
  const article = readArticle(root);
  article.handle = 'some-other-handle';
  writeArticleKeepingHashes(root, article);
});

expectRule('a body edit the manifest has not caught up with', RULES.BODY_SHA_MISMATCH, (root) => {
  // Same length, different bytes, so only the hash rule fires and not the length rule.
  const body = readBody(root);
  writeBody(root, body.replace('workbook', 'notebook'));
});

expectRule('a body length the manifest disagrees with', RULES.BODY_LENGTH_MISMATCH, (root) => {
  const manifest = readManifestFile(root);
  manifest.articles[HANDLE].bodyLength += 1;
  writeManifestFile(root, manifest);
});

expectRule('metadata the manifest has not caught up with', RULES.META_SHA_MISMATCH, (root) => {
  const manifest = readManifestFile(root);
  manifest.articles[HANDLE].metaSha256 = '0'.repeat(64);
  writeManifestFile(root, manifest);
});

expectRule('a previousHandle that is not a handle', RULES.PREVIOUS_HANDLE_SHAPE, (root) => {
  const article = readArticle(root);
  article.previousHandles = ['Not A Handle'];
  writeArticleKeepingHashes(root, article);
});

expectRule('an article claiming its own handle as a previous one', RULES.PREVIOUS_HANDLE_SELF, (root) => {
  const article = readArticle(root);
  article.previousHandles = [HANDLE];
  writeArticleKeepingHashes(root, article);
});

expectRule('two articles claiming the same previous handle', RULES.PREVIOUS_HANDLE_COLLISION, (root) => {
  // Two posts competing for one redirect. Whichever is written second cannot have it, and silently
  // picking one would send readers of an old link to an arbitrary article.
  const second = 'a-second-post';
  addSecondArticle(root, second);
  const first = readArticle(root);
  first.previousHandles = ['an-old-handle'];
  writeArticle(root, first);
  const other = readArticle(root, second);
  other.previousHandles = ['an-old-handle'];
  writeArticle(root, other, second);
  reindexHandle(root, HANDLE);
  reindexHandle(root, second);
});

// ---------------------------------------------------------------------------------------------
// Safety. The body renders raw.
// ---------------------------------------------------------------------------------------------

expectRule('a script tag in the body', RULES.FORBIDDEN_ELEMENT, (root) => {
  writeBodyKeepingHashes(root, `${readBody(root).trimEnd()}\n<script>alert(1)</script>\n`);
});

expectRule('a forbidden name used as an ATTRIBUTE rather than an element', RULES.FORBIDDEN_ATTRIBUTE, (root) => {
  // The plan left "element or attribute" ambiguous and it is resolved deliberately. A `form`
  // attribute on a div is not itself dangerous, but it is a strong signal that something generated
  // markup nobody reviewed, which is the same reason the element is refused.
  writeBodyKeepingHashes(root, `${readBody(root).trimEnd()}\n<div form="checkout">x</div>\n`);
});

expectRule('an event-handler attribute in any case', RULES.EVENT_HANDLER, (root) => {
  writeBodyKeepingHashes(root, `${readBody(root).trimEnd()}\n<p OnClick="steal()">x</p>\n`);
});

expectRule('a javascript: URL', RULES.DANGEROUS_URL, (root) => {
  writeBodyKeepingHashes(root, `${readBody(root).trimEnd()}\n<p><a href="javascript:alert(1)">x</a></p>\n`);
});

// ---------------------------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------------------------

expectRule('an em dash in an authored string', RULES.EM_DASH, (root) => {
  const article = readArticle(root);
  article.title = `Welcome ${String.fromCharCode(0x2014)} at last`;
  writeArticleKeepingHashes(root, article);
});

expectRule('an h1 in the body', RULES.BODY_H1, (root) => {
  writeBodyKeepingHashes(root, `${readBody(root).trimEnd()}\n<h1>A second page heading</h1>\n`);
});

expectRule('a heading level skip', RULES.HEADING_SKIP, (root) => {
  writeBodyKeepingHashes(root, `${readBody(root).trimEnd()}\n<h2>Fine</h2>\n<h5>Too far</h5>\n`);
});

// ---------------------------------------------------------------------------------------------
// Sensitive content, because this repo is public
// ---------------------------------------------------------------------------------------------

expectRule('an email-shaped string in the body', RULES.EMAIL_SHAPED, (root) => {
  writeBodyKeepingHashes(root, `${readBody(root).trimEnd()}\n<p>Write to someone@example.com about it.</p>\n`);
});

expectRule('a phone-shaped string in the body', RULES.PHONE_SHAPED, (root) => {
  writeBodyKeepingHashes(root, `${readBody(root).trimEnd()}\n<p>Call 555 867 5309 for details.</p>\n`);
});

expectRule('a machine path in the body', RULES.MACHINE_PATH, (root) => {
  writeBodyKeepingHashes(root, `${readBody(root).trimEnd()}\n<p>The file lives at ~/repos/example.</p>\n`);
});

// ---------------------------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------------------------

expectRule('an image with no alt text', RULES.IMG_MISSING_ALT, (root) => {
  writeBodyKeepingHashes(root, readBody(root).replace(/ alt="[^"]*"/, ' alt=""'));
});

expectRule('a body image images.json does not record', RULES.IMG_SRC_UNKNOWN, (root) => {
  // ONE mutation. An earlier version also pushed an unreferenced entry into images.json, which
  // legitimately tripped the orphan rule as well: two mutations, two findings, and the "exactly
  // one" assertion doing its job.
  writeBodyKeepingHashes(
    root,
    `${readBody(root).trimEnd()}\n<img src="https://cdn.shopify.com/s/files/1/0000/0001/files/missing.jpg" alt="Not recorded">\n`,
  );
});

expectRule('a recorded image nothing references', RULES.IMAGE_ORPHAN, (root) => {
  const images = readImages(root);
  images.images.push({
    url: 'https://cdn.shopify.com/s/files/1/0000/0001/files/orphan.jpg',
    alt: 'An orphan',
    width: 10,
    height: 10,
    sha256: '0'.repeat(64),
  });
  writeImagesKeepingHashes(root, images);
});

expectRule('a featured image images.json does not record', RULES.FEATURED_IMAGE_UNRESOLVED, (root) => {
  const article = readArticle(root);
  article.image = 'https://cdn.shopify.com/s/files/1/0000/0001/files/not-recorded.jpg';
  writeArticleKeepingHashes(root, article);
});

expectRule('an image served from somewhere other than the CDN', RULES.IMAGE_HOST, (root) => {
  const images = readImages(root);
  const moved = 'https://images.example.com/bench-overview.jpg';
  images.images[0].url = moved;
  writeImagesKeepingHashes(root, images);
  writeBodyKeepingHashes(root, readBody(root).replace(/src="[^"]*"/, `src="${moved}"`));
  const article = readArticle(root);
  article.image = moved;
  writeArticleKeepingHashes(root, article);
});

// ---------------------------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------------------------

expectRule('an empty summary', RULES.SUMMARY_EMPTY, (root) => {
  const article = readArticle(root);
  article.summary = '   ';
  writeArticleKeepingHashes(root, article);
});

expectRule('an empty author', RULES.AUTHOR_EMPTY, (root) => {
  const article = readArticle(root);
  article.author = '';
  writeArticleKeepingHashes(root, article);
});

expectRule('a duplicated tag', RULES.TAG_DUPLICATE, (root) => {
  const article = readArticle(root);
  article.tags = ['studio', 'studio'];
  writeArticleKeepingHashes(root, article);
});

expectRule('an seo title over the bound', RULES.SEO_TITLE_LONG, (root) => {
  const article = readArticle(root);
  article.seo.title = 'A'.repeat(80);
  writeArticleKeepingHashes(root, article);
});

expectRule('an seo description under the bound', RULES.SEO_DESC_SHORT, (root) => {
  const article = readArticle(root);
  article.seo.description = 'Too short.';
  writeArticleKeepingHashes(root, article);
});

expectRule('an seo description over the bound', RULES.SEO_DESC_LONG, (root) => {
  const article = readArticle(root);
  article.seo.description = 'A'.repeat(200);
  writeArticleKeepingHashes(root, article);
});

expectRule('a templateSuffix naming no template in this repo', RULES.TEMPLATE_SUFFIX_UNKNOWN, (root) => {
  const article = readArticle(root);
  article.templateSuffix = 'not-a-real-template';
  writeArticleKeepingHashes(root, article);
});

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

expectRule('a policy link naming no tracked policy', RULES.POLICY_LINK_UNKNOWN, (root) => {
  writeBodyKeepingHashes(root, readBody(root).replace('/policies/refund-policy', '/policies/not-a-policy'));
});

expectRule('a relative link to no known storefront root', RULES.RELATIVE_ROOT_UNKNOWN, (root) => {
  writeBodyKeepingHashes(root, readBody(root).replace('/policies/refund-policy', '/nowhere/at-all'));
});

expectRule('an external link that is not https', RULES.EXTERNAL_NOT_HTTPS, (root) => {
  writeBodyKeepingHashes(root, readBody(root).replace('https://www.astm.org/', 'http://www.astm.org/'));
});

expectRule('a product link naming no product in the catalogue', RULES.PRODUCT_LINK_UNKNOWN, (root) => {
  withRealCatalogue(root);
  writeBodyKeepingHashes(root, readBody(root).replace('/policies/refund-policy', '/products/not-a-real-product'));
});

// ---------------------------------------------------------------------------------------------
// The meta-test
// ---------------------------------------------------------------------------------------------

test('every rule id in RULES is exercised by a case in this file', () => {
  // A rule nobody trips is a rule nobody has proved works. This is what stops the set rotting as
  // rules are added.
  const missing = ALL_RULE_IDS.filter((id) => !EXERCISED.has(id)).sort();
  assert.deepEqual(missing, [], `these rule ids have no case:\n${missing.join('\n')}`);
});

test('every exercised id is a real member of RULES', () => {
  // The other direction: a typo in a case would otherwise silently exercise nothing.
  const unknown = [...EXERCISED].filter((id) => !ALL_RULE_IDS.includes(id)).sort();
  assert.deepEqual(unknown, [], `these expectations name no rule in RULES:\n${unknown.join('\n')}`);
});

// ---------------------------------------------------------------------------------------------
// Helpers that keep the manifest in step, so a case trips ONE rule
// ---------------------------------------------------------------------------------------------

/**
 * Most cases are about content being wrong, not about the manifest being stale. Rewriting the
 * manifest after the mutation keeps the hash rules quiet so the case under test is the only one
 * that fires. The hash rules have their own cases above, where staleness IS the subject.
 */
function reindexInPlace(root) {
  const manifest = readManifestFile(root);
  const article = readArticle(root);
  const body = readBody(root).replace(/\n$/, '');
  const images = readImages(root);
  const entry = manifest.articles[HANDLE];
  entry.bodySha256 = sha256(body);
  entry.bodyLength = body.length;
  entry.metaSha256 = metaSha256(article);
  entry.images = images.images.map((e) => String(e.url).split('?')[0]).sort();
  writeManifestFile(root, manifest);
}

function writeBodyKeepingHashes(root, text) {
  writeBody(root, text);
  reindexInPlace(root);
}

function writeArticleKeepingHashes(root, article) {
  writeArticle(root, article);
  reindexInPlace(root);
}

function writeImagesKeepingHashes(root, images) {
  writeImages(root, images);
  reindexInPlace(root);
}
