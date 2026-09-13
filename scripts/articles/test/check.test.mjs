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
// The exhaustive payload table for the markup reader lives in body-markup.test.mjs; this file proves
// each rule id is wired through the checker, and the positive controls that need a whole tree.
//
// EVERY PATH IS UNDER A TEMP ROOT, asserted in an after() hook.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { check } from '../check.mjs';
import { ALL_RULE_IDS, DESC_MAX, DESC_MIN, RULES, TITLE_MAX } from '../lib/articles.mjs';
import { parseCatalogue } from '../../lib/catalogue-manifest.mjs';
import {
  HANDLE,
  REPO_ROOT,
  addSecondArticle,
  cleanRoot,
  cleanup,
  madeRoots,
  readArticle,
  readBody,
  readImages,
  readManifestFile,
  reindexInPlace,
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

/** Apply a mutation and assert NO rule fires: the positive control for a rule's boundary. */
function expectClean(name, mutate) {
  test(name, () => {
    const root = cleanRoot();
    mutate(root);
    assert.deepEqual(check(root).findings, [], 'expected no finding at all');
  });
}

/** Append markup to the body, keeping the manifest current. */
function appendToBody(root, markup) {
  writeBodyKeepingHashes(root, `${readBody(root).trimEnd()}\n${markup}\n`);
}

// ---------------------------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------------------------

test('the committed clean article passes every rule', () => {
  const root = cleanRoot();
  const { findings, notes } = check(root);
  assert.deepEqual(findings, [], 'the golden article must be clean, or every case below is measuring noise');
  // The degradation is REPORTED, never silent: this root has no catalogue.
  assert.ok(notes.some((n) => n.includes('catalogue')), 'the absent catalogue must be noted');
  // And the image-hash note says what is true: the hashes are compared in NEITHER case. An earlier
  // note implied a run with article-images/ present did compare them, and nothing ever has.
  const hashNote = notes.find((n) => n.includes('article-images'));
  assert.ok(hashNote, 'the unverified image hashes must be noted');
  assert.match(hashNote, /not compared/);
  assert.match(hashNote, /whether or not that directory is present/);
});

test('the image-hash note is the same with article-images/ present, because nothing compares them', () => {
  const root = cleanRoot();
  mkdirSync(join(root, 'article-images'), { recursive: true });
  const { findings, notes } = check(root);
  assert.deepEqual(findings, []);
  assert.ok(notes.some((n) => n.includes('not compared')), 'a present directory must not silence the note');
});

// ---------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------

expectRule('a handle that is not kebab-case', RULES.HANDLE_SHAPE, (root) => {
  // The second directory gets an entry computed from ITS OWN files. Copying the first article's
  // entry was the obvious shortcut and it is wrong: the copy's metaSha256 describes a different
  // handle, so the case also tripped the hash rule and failed for a reason unrelated to the shape.
  addSecondArticle(root, 'Not_A_Handle');
  reindexInPlace(root);
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
  article.draftNotes = 'not a field this format defines';
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

expectRule('a manifest image list that disagrees with images.json', RULES.IMAGES_MISMATCH, (root) => {
  // The checker used to compare three of the entry's four fields. This is the fourth.
  const manifest = readManifestFile(root);
  manifest.articles[HANDLE].images = [];
  writeManifestFile(root, manifest);
});

expectRule('article.json that is not valid JSON', RULES.JSON_INVALID, (root) => {
  writeFileSync(join(root, 'marketing', 'articles', HANDLE, 'article.json'), '{ "handle": ', 'utf8');
});

expectRule('images.json that is not valid JSON', RULES.JSON_INVALID, (root) => {
  writeFileSync(join(root, 'marketing', 'articles', HANDLE, 'images.json'), 'not json\n', 'utf8');
});

expectRule('tags written as a string rather than an array', RULES.FIELD_TYPE, (root) => {
  // The first version iterated this a character at a time and reported nothing.
  const article = readArticle(root);
  article.tags = 'studio';
  writeArticleKeepingHashes(root, article);
});

expectRule('a numeric seo.title, which the length rules used to skip silently', RULES.FIELD_TYPE, (root) => {
  const article = readArticle(root);
  article.seo.title = 12345;
  writeArticleKeepingHashes(root, article);
});

expectRule('article.json holding an array rather than an object', RULES.FIELD_TYPE, (root) => {
  writeArticleKeepingHashes(root, ['not', 'an', 'object']);
});

expectRule('images.json with no images array', RULES.FIELD_TYPE, (root) => {
  writeImagesKeepingHashes(root, { images: 'none' });
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
  reindexInPlace(root);
});

expectRule('a previous handle that is another article\'s CURRENT handle', RULES.PREVIOUS_HANDLE_COLLISION, (root) => {
  const second = 'a-second-post';
  addSecondArticle(root, second);
  const first = readArticle(root);
  first.previousHandles = [second];
  writeArticle(root, first);
  reindexInPlace(root);
});

// ---------------------------------------------------------------------------------------------
// Safety. The body renders raw.
// ---------------------------------------------------------------------------------------------

expectRule('markup the strict reader refuses', RULES.MALFORMED_MARKUP, (root) => {
  appendToBody(root, '<!-- a note to self -->');
});

expectRule('a script tag in the body', RULES.FORBIDDEN_ELEMENT, (root) => {
  appendToBody(root, '<script>alert(1)</script>');
});

expectRule('an attribute not on the element\'s allowlist', RULES.FORBIDDEN_ATTRIBUTE, (root) => {
  // `form` on a div is not itself dangerous, but nothing a body needs carries it, and an allowlist
  // refuses by default rather than by somebody remembering the name.
  appendToBody(root, '<div form="checkout">x</div>');
});

expectRule('the same attribute twice on one element', RULES.DUPLICATE_ATTRIBUTE, (root) => {
  appendToBody(root, '<p class="a" class="b">x</p>');
});

expectRule('an event-handler attribute in any case', RULES.EVENT_HANDLER, (root) => {
  appendToBody(root, '<p OnClick="steal()">x</p>');
});

expectRule('a javascript: URL', RULES.DANGEROUS_URL, (root) => {
  appendToBody(root, '<p><a href="javascript:alert(1)">x</a></p>');
});

test('malformed markup silences the element rules but not the raw-text scans', () => {
  // Fail closed in both directions. A heading finding computed past the point the reader stopped
  // would be a guess, so it is not reported; the em-dash and sensitive scans read raw text and need
  // no reading of the markup, so they still run.
  const root = cleanRoot();
  const dash = String.fromCharCode(0x2014);
  appendToBody(root, `<!-- x -->\n<h1>Second title</h1>\n<p>Call 555-867-5309 ${dash} soon.</p>`);
  assert.deepEqual(rulesFired(root), [RULES.EM_DASH, RULES.PHONE_SHAPED, RULES.MALFORMED_MARKUP].sort());
});

// ---------------------------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------------------------

expectRule('an em dash in an authored string', RULES.EM_DASH, (root) => {
  const article = readArticle(root);
  article.title = `Welcome ${String.fromCharCode(0x2014)} at last`;
  writeArticleKeepingHashes(root, article);
});

expectRule('an em dash in an images.json alt', RULES.EM_DASH, (root) => {
  const images = readImages(root);
  images.images[0].alt = `A bench ${String.fromCharCode(0x2014)} at dusk`;
  writeImagesKeepingHashes(root, images);
});

expectRule('an h1 in the body', RULES.BODY_H1, (root) => {
  appendToBody(root, '<h1>A second page heading</h1>');
});

expectRule('a heading level skip', RULES.HEADING_SKIP, (root) => {
  appendToBody(root, '<h2>Fine</h2>\n<h5>Too far</h5>');
});

// ---------------------------------------------------------------------------------------------
// Sensitive content, because this repo is public
// ---------------------------------------------------------------------------------------------

expectRule('an email-shaped string in the body', RULES.EMAIL_SHAPED, (root) => {
  appendToBody(root, '<p>Write to someone@example.com about it.</p>');
});

expectRule('a phone-shaped string in the body', RULES.PHONE_SHAPED, (root) => {
  appendToBody(root, '<p>Call 555 867 5309 for details.</p>');
});

expectRule('a phone-shaped string in an images.json alt', RULES.PHONE_SHAPED, (root) => {
  const images = readImages(root);
  images.images[0].alt = 'A card reading (555) 867-5309';
  writeImagesKeepingHashes(root, images);
});

expectRule('a machine path in the body', RULES.MACHINE_PATH, (root) => {
  appendToBody(root, '<p>The file lives at ~/repos/example.</p>');
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
  appendToBody(root, '<img src="https://cdn.shopify.com/s/files/1/0000/0001/files/missing.jpg" alt="Not recorded">');
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

// Hosts that CONTAIN the CDN name without being it. The first version asked `includes(IMAGE_HOST)`,
// which every one of these but the plain http case passes. Each case moves only the recorded URL and
// the featured image, and drops the body img, so the URL rules on the body never see the value and
// the host rule is the only one left to refuse it.
for (const moved of [
  'https://images.example.com/bench-overview.jpg',
  'https://cdn.shopify.com.evil.example/a.jpg',
  'https://evil.example/cdn.shopify.com/a.jpg',
  'http://cdn.shopify.com/a.jpg',
  'https://cdn.shopify.com@evil.example/a.jpg',
  'not a url at all',
]) {
  expectRule(`an image recorded at ${moved}`, RULES.IMAGE_HOST, (root) => {
    const images = readImages(root);
    images.images[0].url = moved;
    writeImages(root, images);
    writeBody(root, readBody(root).replace(/<img [^>]*>\n\n/, ''));
    const article = readArticle(root);
    article.image = moved;
    writeArticleKeepingHashes(root, article);
  });
}

// ---------------------------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------------------------

expectRule('an empty title', RULES.TITLE_EMPTY, (root) => {
  const article = readArticle(root);
  article.title = '  ';
  writeArticleKeepingHashes(root, article);
});

expectRule('a missing title', RULES.TITLE_EMPTY, (root) => {
  const article = readArticle(root);
  delete article.title;
  writeArticleKeepingHashes(root, article);
});

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

/** Set the seo field to a string of `length` characters. */
function seoOfLength(field, length) {
  return (root) => {
    const article = readArticle(root);
    article.seo[field] = 'A'.repeat(length);
    writeArticleKeepingHashes(root, article);
  };
}

// The bounds are checked at the edge on both sides. A `>=` where `>` was meant moves the boundary by
// one character, which no case far from the edge would ever see.
expectClean(`an seo title of exactly TITLE_MAX (${TITLE_MAX})`, seoOfLength('title', TITLE_MAX));
expectRule(`an seo title of TITLE_MAX + 1`, RULES.SEO_TITLE_LONG, seoOfLength('title', TITLE_MAX + 1));
expectRule(`an seo description of DESC_MIN - 1`, RULES.SEO_DESC_SHORT, seoOfLength('description', DESC_MIN - 1));
expectClean(`an seo description of exactly DESC_MIN (${DESC_MIN})`, seoOfLength('description', DESC_MIN));
expectClean(`an seo description of exactly DESC_MAX (${DESC_MAX})`, seoOfLength('description', DESC_MAX));
expectRule(`an seo description of DESC_MAX + 1`, RULES.SEO_DESC_LONG, seoOfLength('description', DESC_MAX + 1));

expectRule('a templateSuffix naming no template in this repo', RULES.TEMPLATE_SUFFIX_UNKNOWN, (root) => {
  const article = readArticle(root);
  article.templateSuffix = 'not-a-real-template';
  writeArticleKeepingHashes(root, article);
});

expectClean('a templateSuffix naming a template that exists at this root', (root) => {
  // The positive half. Without it, a resolver that refused every suffix would pass the case above.
  mkdirSync(join(root, 'templates'), { recursive: true });
  writeFileSync(join(root, 'templates', 'article.photo-story.json'), '{}\n', 'utf8');
  const article = readArticle(root);
  article.templateSuffix = 'photo-story';
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

expectRule('a product link with an empty handle, with no catalogue to consult', RULES.PRODUCT_LINK_UNKNOWN, (root) => {
  writeBodyKeepingHashes(root, readBody(root).replace('/policies/refund-policy', '/products/'));
});

/** A real product handle, read the way the checker reads it rather than typed into this file. */
function realProductHandle() {
  const catalogue = parseCatalogue(readFileSync(join(REPO_ROOT, 'catalogue.json'), 'utf8'));
  const [first] = catalogue.products.keys();
  assert.ok(first, 'the real catalogue declares no product, so this control would prove nothing');
  return first;
}

for (const suffix of ['', '?variant=1', '/']) {
  expectClean(`a link to a real product${suffix === '' ? '' : ` with "${suffix}"`} produces no finding`, (root) => {
    // The positive control for the product rule. Without it, a rule that refused every product link
    // would pass the negative case above.
    withRealCatalogue(root);
    const link = `/products/${realProductHandle()}${suffix}`;
    writeBodyKeepingHashes(root, readBody(root).replace('/policies/refund-policy', link));
  });
}

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
