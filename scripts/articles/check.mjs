#!/usr/bin/env node
// Offline, CI-safe consistency check over marketing/articles/.
//
// WHAT A GREEN CHECK PROVES: the repo is self-consistent and every article is safe to send. Each
// directory has its three files, the manifest and the directories are in bijection, each body is in
// canonical form and hashes to what the manifest records, no body carries markup that would execute
// on the storefront, no authored string carries an em dash or anything that looks like personal
// contact detail, every image resolves to a recorded CDN URL with alt text, and every internal link
// names something this repo can prove exists.
//
// WHAT IT DOES NOT PROVE: that Shopify holds these bytes. Nothing here touches the network, by
// design. `articles:verify --live` is the command that answers that, and it is a separate chunk.
//
// AND IT NEVER READS MACHINE-LOCAL STATE. The observation state is per-machine, so CI has no
// opinion about it and could not have one.
//
//   node scripts/articles/check.mjs              check and report
//   node scripts/articles/check.mjs --root <dir> operate on another checkout (tests)
//
// marketing/articles/README.md documents the on-disk format.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOGUE_PATH, parseCatalogue } from '../lib/catalogue-manifest.mjs';
import { hasEmDash } from '../lib/prose.mjs';
import {
  ARTICLES_DIR,
  ARTICLE_FILES,
  ARTICLE_KEYS,
  DESC_MAX,
  DESC_MIN,
  NON_ARTICLE_FILES,
  POLICY_HANDLES,
  RULES,
  TITLE_MAX,
  articleFieldTypeErrors,
  authoredStrings,
  bodyFromFileText,
  classifyLink,
  emDashFindings,
  finding,
  headingFindings,
  hrefsOf,
  imageHostRefusal,
  imagesFieldTypeErrors,
  imagesOf,
  isHandle,
  manifestEntryFor,
  safetyFindings,
  sensitiveFindings,
  stripVersionQuery,
  templateFileFor,
} from './lib/articles.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const OK_MARKER = 'articles:check ok';

/** Where the local processed photos live. Gitignored; the repo records URLs, never bytes. */
export const IMAGE_ROOT_DIR = 'article-images';

export function paths(root) {
  const dir = join(root, ...ARTICLES_DIR.split('/'));
  return {
    dir,
    manifest: join(dir, 'manifest.json'),
    article: (handle) => join(dir, handle),
    imageRoot: join(root, IMAGE_ROOT_DIR),
  };
}

export function readManifest(root) {
  const p = paths(root);
  const manifest = JSON.parse(readFileSync(p.manifest, 'utf8'));
  if (!manifest.articles || typeof manifest.articles !== 'object' || Array.isArray(manifest.articles)) {
    throw new Error('manifest.json: missing "articles" object');
  }
  return manifest;
}

/** Every article directory under marketing/articles/, sorted. Files other than the two allowed are findings. */
function readTree(root, findings) {
  const p = paths(root);
  const handles = [];
  if (!existsSync(p.dir)) return handles;
  for (const name of readdirSync(p.dir).sort()) {
    const full = join(p.dir, name);
    if (statSync(full).isDirectory()) {
      handles.push(name);
      continue;
    }
    if (!NON_ARTICLE_FILES.includes(name)) {
      findings.push(finding(RULES.UNEXPECTED_FILE, null, `${name}: unexpected file under ${ARTICLES_DIR}/`));
    }
  }
  return handles;
}

/**
 * The product census, or null when this root has no catalogue.
 *
 * Read from the GIVEN ROOT, not from the committed one: the suite runs this checker against fixture
 * roots, and `readCommittedCatalogue()` memoises against its own module's repo root, so it would
 * silently validate fixture links against the real store's products.
 */
function readCatalogue(root) {
  const file = join(root, CATALOGUE_PATH);
  if (!existsSync(file)) return null;
  return parseCatalogue(readFileSync(file, 'utf8'));
}

/**
 * Side-effect-free. Reads the manifest and marketing/articles/, touches nothing, never reaches the
 * network.
 *
 * Returns:
 *   findings  Array<{rule, handle, detail}>  every refusal, each carrying a rule id
 *   notes     string[]                       advisory, never a failure
 *   handles   string[]                       the article directories seen
 */
export function plan(root = REPO_ROOT) {
  const p = paths(root);
  const findings = [];
  const notes = [];
  const manifest = readManifest(root);

  const handles = readTree(root, findings);
  const listed = Object.keys(manifest.articles).sort();

  for (const handle of listed) {
    if (!handles.includes(handle)) {
      findings.push(finding(RULES.MANIFEST_ORPHAN, handle, 'listed in manifest.json but has no directory'));
    }
  }
  for (const handle of handles) {
    if (!listed.includes(handle)) {
      findings.push(finding(RULES.DIRECTORY_UNLISTED, handle, `has a directory but no manifest entry; run npm run articles:reindex`));
    }
  }

  const catalogue = readCatalogue(root);
  if (catalogue === null) notes.push(`no ${CATALOGUE_PATH} at this root, so /products/ links were not resolved`);

  // NOT "verified when the directory is present". An earlier note said the hashes went unverified
  // only because article-images/ was absent, which implied a local run with the directory did verify
  // them. Nothing in this checker compares them in either case, so the note says exactly that.
  if (handles.length > 0) {
    notes.push(
      `images.json image sha256 values are not compared with the local files in ${IMAGE_ROOT_DIR}/, ` +
        'whether or not that directory is present; the shape and presence rules still ran',
    );
  }

  /** Every previousHandle seen, so two articles cannot compete for one redirect. */
  const claimedRedirects = new Map();

  for (const handle of handles) {
    const dir = p.article(handle);

    if (!isHandle(handle)) {
      findings.push(finding(RULES.HANDLE_SHAPE, handle, 'the directory name is not a kebab-case handle'));
    }

    const missing = ARTICLE_FILES.filter((f) => !existsSync(join(dir, f)));
    if (missing.length) {
      findings.push(finding(RULES.MISSING_FILE, handle, `missing ${missing.join(', ')}`));
      continue;
    }

    // Unparseable JSON is its own refusal, per file. It used to be reported as a MISSING file, which
    // sent an operator looking for a file that was sitting right there.
    const article = readJsonFile(join(dir, 'article.json'), 'article.json', handle, findings);
    const images = readJsonFile(join(dir, 'images.json'), 'images.json', handle, findings);
    if (article === INVALID || images === INVALID) continue;

    const rawBody = readFileSync(join(dir, 'body.html'), 'utf8');
    const body = bodyFromFileText(rawBody);
    if (rawBody !== `${body}\n`) {
      findings.push(finding(RULES.NOT_CANONICAL, handle, 'body.html is not in canonical form (BOM, CRLF, trailing whitespace, or a missing final newline)'));
    }

    // The body rules need nothing from the metadata, so they run whatever state article.json is in.
    // The em-dash and sensitive scans read the RAW text, so they also run when the markup is
    // malformed and every element rule has gone quiet for this body.
    findings.push(...safetyFindings(body, handle));
    findings.push(...headingFindings(body, handle));
    findings.push(...emDashFindings(null, body, handle));
    findings.push(...sensitiveFindings(body, handle, 'the body'));

    const typeErrors = [
      ...articleFieldTypeErrors(article).map((d) => `article.json: ${d}`),
      ...imagesFieldTypeErrors(images).map((d) => `images.json: ${d}`),
    ];
    if (typeErrors.length) {
      for (const detail of typeErrors) findings.push(finding(RULES.FIELD_TYPE, handle, detail));
      continue;
    }

    for (const key of Object.keys(article)) {
      if (!ARTICLE_KEYS.includes(key)) {
        findings.push(finding(RULES.UNKNOWN_KEY, handle, `article.json carries the unknown key "${key}"`));
      }
    }

    if (article.handle !== handle) {
      findings.push(finding(RULES.DIR_NAME_MISMATCH, handle, `article.json declares handle "${article.handle}"`));
    }

    findings.push(...emDashFindings(article, '', handle));
    for (const [label, value] of authoredStrings(article)) {
      findings.push(...sensitiveFindings(value, handle, label));
    }
    // images.json alt text is authored prose too, and the push sends it to Shopify as the media alt,
    // so it gets the same two sweeps as the article's own strings.
    for (const [i, entry] of images.images.entries()) {
      if (hasEmDash(entry.alt)) findings.push(finding(RULES.EM_DASH, handle, `images.json images[${i}].alt contains an em dash`));
      findings.push(...sensitiveFindings(entry.alt, handle, `images.json images[${i}].alt`));
    }

    if (typeof article.title !== 'string' || article.title.trim() === '') {
      findings.push(finding(RULES.TITLE_EMPTY, handle, 'title must be a non-empty string'));
    }
    if (typeof article.summary !== 'string' || article.summary.trim() === '') {
      findings.push(finding(RULES.SUMMARY_EMPTY, handle, 'summary must be a non-empty string'));
    }
    if (typeof article.author !== 'string' || article.author.trim() === '') {
      findings.push(finding(RULES.AUTHOR_EMPTY, handle, 'author must be a non-empty string'));
    }

    const tags = article.tags ?? [];
    if (new Set(tags).size !== tags.length) {
      findings.push(finding(RULES.TAG_DUPLICATE, handle, 'tags contains a duplicate'));
    }

    const seoTitle = article.seo?.title ?? '';
    const seoDesc = article.seo?.description ?? '';
    if (seoTitle.length > TITLE_MAX) {
      findings.push(finding(RULES.SEO_TITLE_LONG, handle, `seo.title is ${seoTitle.length} characters, over ${TITLE_MAX}`));
    }
    if (seoDesc.length > 0 && seoDesc.length < DESC_MIN) {
      findings.push(finding(RULES.SEO_DESC_SHORT, handle, `seo.description is ${seoDesc.length} characters, under ${DESC_MIN}`));
    }
    if (seoDesc.length > DESC_MAX) {
      findings.push(finding(RULES.SEO_DESC_LONG, handle, `seo.description is ${seoDesc.length} characters, over ${DESC_MAX}`));
    }

    const templateFile = templateFileFor(article.templateSuffix);
    if (templateFile !== null && !existsSync(join(root, templateFile))) {
      findings.push(finding(RULES.TEMPLATE_SUFFIX_UNKNOWN, handle, `templateSuffix "${article.templateSuffix}" names ${templateFile}, which does not exist`));
    }

    for (const old of article.previousHandles ?? []) {
      if (!isHandle(old)) {
        findings.push(finding(RULES.PREVIOUS_HANDLE_SHAPE, handle, `previousHandles entry "${old}" is not a kebab-case handle`));
      }
      if (old === handle) {
        findings.push(finding(RULES.PREVIOUS_HANDLE_SELF, handle, `previousHandles lists this article's own handle`));
        continue;
      }
      // A redirect from a handle another article currently LIVES at would point that article's own
      // URL somewhere else. Shopify refuses to create it, so the push would fail halfway; refusing it
      // here keeps that failure in review.
      if (handles.includes(old)) {
        findings.push(finding(RULES.PREVIOUS_HANDLE_COLLISION, handle, `previousHandles entry "${old}" is the current handle of another article`));
      }
      const claimedBy = claimedRedirects.get(old);
      if (claimedBy !== undefined && claimedBy !== handle) {
        findings.push(finding(RULES.PREVIOUS_HANDLE_COLLISION, handle, `previousHandles entry "${old}" is also claimed by "${claimedBy}"`));
      }
      claimedRedirects.set(old, handle);
    }

    // Media. Every recorded URL must be on the CDN, every body img must resolve to one, and every
    // recorded image must be referenced by the body or be the featured image.
    const byUrl = new Map();
    for (const entry of images.images) {
      const url = stripVersionQuery(entry.url);
      byUrl.set(url, entry);
      const refusal = imageHostRefusal(entry.url);
      if (refusal !== null) {
        findings.push(finding(RULES.IMAGE_HOST, handle, `images.json records ${url}, which ${refusal}`));
      }
    }

    // The alt text itself was already swept for sensitive content as part of the raw body above.
    const used = new Set();
    for (const img of imagesOf(body)) {
      if (img.alt.trim() === '') {
        findings.push(finding(RULES.IMG_MISSING_ALT, handle, 'the body has an <img> with no alt text'));
      }
      if (img.src === null) continue; // refused by the URL rules already
      const src = stripVersionQuery(img.src);
      if (!byUrl.has(src)) {
        findings.push(finding(RULES.IMG_SRC_UNKNOWN, handle, `the body references ${src}, which images.json does not record`));
      } else {
        used.add(src);
      }
    }

    const featured = stripVersionQuery(article.image ?? '');
    if (featured !== '') {
      if (!byUrl.has(featured)) {
        findings.push(finding(RULES.FEATURED_IMAGE_UNRESOLVED, handle, `image "${featured}" is not recorded in images.json`));
      } else {
        used.add(featured);
      }
    }

    for (const url of byUrl.keys()) {
      if (!used.has(url)) {
        findings.push(finding(RULES.IMAGE_ORPHAN, handle, `images.json records ${url}, which nothing references`));
      }
    }

    // Links. `hrefsOf` returns only hrefs the URL rules admitted, decoded, so everything here is
    // https, mailto, a fragment, or a single-slash storefront path; `http://` was refused as
    // link/external-not-https by the safety pass, where the raw value is still in hand.
    for (const href of hrefsOf(body)) {
      const link = classifyLink(href);
      if (link.kind === 'relative-unknown') {
        findings.push(finding(RULES.RELATIVE_ROOT_UNKNOWN, handle, `link ${href} names no known storefront root`));
      }
      if (link.kind === 'relative' && link.root === '/policies/' && !POLICY_HANDLES.includes(link.handle)) {
        findings.push(finding(RULES.POLICY_LINK_UNKNOWN, handle, `link ${href} names no tracked shop policy`));
      }
      if (link.kind === 'relative' && link.root === '/products/') {
        // An EMPTY handle is refused with or without a catalogue: `/products/` is a link to nothing
        // whatever the census holds, so there is nothing to wait for.
        if (link.handle === '') {
          findings.push(finding(RULES.PRODUCT_LINK_UNKNOWN, handle, `link ${href} names no product handle`));
        } else if (catalogue !== null && !catalogue.products.has(link.handle)) {
          findings.push(finding(RULES.PRODUCT_LINK_UNKNOWN, handle, `link ${href} names no product in ${CATALOGUE_PATH}`));
        }
      }
    }

    // Hashes agree. This is what makes a stale manifest a refusal rather than a silent pass, and it
    // is why `articles:reindex --check` is deliberately NOT also wired into CI. The expected entry
    // comes from `manifestEntryFor`, the function reindex writes with, so the two cannot diverge.
    const entry = manifest.articles[handle];
    if (entry) {
      const expected = manifestEntryFor(body, article, images);
      if (entry.bodySha256 !== expected.bodySha256) {
        findings.push(finding(RULES.BODY_SHA_MISMATCH, handle, 'manifest bodySha256 does not match body.html; run npm run articles:reindex'));
      }
      if (entry.bodyLength !== expected.bodyLength) {
        findings.push(finding(RULES.BODY_LENGTH_MISMATCH, handle, 'manifest bodyLength does not match body.html; run npm run articles:reindex'));
      }
      if (entry.metaSha256 !== expected.metaSha256) {
        findings.push(finding(RULES.META_SHA_MISMATCH, handle, 'manifest metaSha256 does not match article.json; run npm run articles:reindex'));
      }
      if (JSON.stringify(entry.images) !== JSON.stringify(expected.images)) {
        findings.push(finding(RULES.IMAGES_MISMATCH, handle, 'manifest images does not match images.json; run npm run articles:reindex'));
      }
    }
  }

  return { findings, notes, handles };
}

/** Sentinel for a JSON file that did not parse. Distinct from any value JSON can produce. */
const INVALID = Symbol('invalid-json');

/** Parse one article JSON file, recording `structure/json-invalid` and returning INVALID on failure. */
function readJsonFile(file, label, handle, findings) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    findings.push(finding(RULES.JSON_INVALID, handle, `${label} is not valid JSON: ${err.message}`));
    return INVALID;
  }
}

export function check(root = REPO_ROOT) {
  const { findings, notes } = plan(root);
  return { findings, notes };
}

export const USAGE = 'usage: node scripts/articles/check.mjs [--root <dir>]';

/**
 * The root a `--root` flag names, the default root, or null when the flag has no value.
 *
 * `resolve(undefined)` throws a TypeError that escapes main as an uncaught stack trace, which tells
 * the operator nothing about the flag they forgot.
 */
function rootFrom(args) {
  const i = args.indexOf('--root');
  if (i === -1) return REPO_ROOT;
  const value = args[i + 1];
  return value === undefined || value.startsWith('--') ? null : resolve(value);
}

function main(argv) {
  const root = rootFrom(argv.slice(2));
  if (root === null) {
    console.error('error: --root needs a directory');
    console.error(USAGE);
    return 1;
  }
  let result;
  try {
    result = check(root);
  } catch (err) {
    console.error(`error: ${err.message}`);
    console.error(`articles:check failed: ${ARTICLES_DIR}/ could not be read`);
    return 1;
  }
  const { findings, notes } = result;
  for (const n of notes) console.log(`note: ${n}`);
  for (const f of findings) {
    console.error(`error: [${f.rule}] ${f.handle === null ? '' : `${f.handle}: `}${f.detail}`);
  }
  if (findings.length) {
    console.error(`articles:check failed: ${findings.length} refusal(s).`);
    return 1;
  }
  console.log(OK_MARKER);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
