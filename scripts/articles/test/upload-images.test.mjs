// The image uploader against a recording fake client and a recording fake fetch. NOTHING HERE REACHES
// A STORE: the fake refuses every operation outside the uploader's four reviewed names.
//
// EXEMPT IMPORTER. This file is the one path test/no-invocation.test.mjs allows to import the
// uploader, and it is held to that file's rules: it imports named functions and `run`, never `main`,
// builds every context with an explicit fake client, reads no environment, and builds no path to the
// module. That is why there is no spawned-CLI case here, as there is none for the push: spawning the
// uploader is exactly the invocation the guard refuses. What such a case proved (the CI refusal comes
// before a client is built) is held instead by reading `main`'s source text, below.
//
// Real images, made with sharp, carry the metadata cases: a JPEG with EXIF, one with XMP, one with a
// COM segment spliced in. IPTC and text chunks cannot be written into a JPEG by sharp, so those cases
// inject the metadata reader, which is also how the suite proves the metadata check runs on the exact
// buffer that is then sent.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';

import { createContext } from '../lib/context.mjs';
import { FILE_CREATE, UPLOAD_MUTATION_ROOT_FIELDS } from '../lib/mutations.mjs';
import { UPLOAD_QUERY_NAMES } from '../lib/queries.mjs';
import {
  COMMAND,
  MIME,
  UPLOAD_MARKER,
  imageProblems,
  isJpegBytes,
  jpegCommentCount,
  metadataRefusals,
  planSha,
  run,
  sharpMetadata,
  uploadClient,
  uploadNameFor,
  uploadNameRe,
} from '../upload-images.mjs';
import { TEST_DIR } from './helpers.mjs';

const HANDLE = 'a-test-post';
const MADE = [];

after(() => {
  for (const dir of MADE) {
    assert.ok(dir.startsWith(tmpdir()), `${dir} is not under the temp root`);
    rmSync(dir, { recursive: true, force: true });
  }
});

function temp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  MADE.push(dir);
  return dir;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const jpeg = (colour = '#336699') => sharp({ create: { width: 40, height: 30, channels: 3, background: colour } }).jpeg().toBuffer();
const jpegWithExif = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#993366' } }).withExif({ IFD0: { Copyright: 'test fixture' } }).jpeg().toBuffer();
const jpegWithXmp = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#669933' } })
  .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF></x:xmpmeta>')
  .jpeg()
  .toBuffer();
const png = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#123456' } }).png().toBuffer();

/** A JPEG with one COM segment spliced in straight after the start-of-image marker. */
function withComment(bytes, text = 'a comment a person typed') {
  const body = Buffer.from(text, 'latin1');
  const header = Buffer.from([0xff, 0xfe, 0, 0]);
  header.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([bytes.subarray(0, 2), header, body, bytes.subarray(2)]);
}

/** An image root holding `files` (name to bytes) under the handle's directory. */
function imageRoot(files) {
  const root = temp('article-images-');
  const dir = join(root, HANDLE);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return root;
}

const cdn = (name, v = 3) => `https://cdn.shopify.com/s/files/1/0000/0001/files/${name}?v=${v}`;

/**
 * A recording fake Files API. `existing` maps a filename to the CDN URL Files already holds for it.
 *
 * The Files search is modelled as Shopify's is, NOT as an exact match: a query returns every entry
 * whose name contains the queried stem, so `x-a.jpg` also finds `x-a-old.jpg`. Each recorded call notes
 * whether it arrived through the read-only wrapper, read from the call stack.
 */
function makeClient({
  existing = {},
  scopes = ['write_files'],
  stagedErrors = [],
  createErrorsFor = null,
  createNoFileFor = null,
  failProcessingFor = null,
  statuses = ['PROCESSING', 'READY'],
  events = [],
  redact = (s) => String(s ?? ''),
  onCall = () => {},
} = {}) {
  const calls = [];
  const byId = new Map();
  let next = 1;
  const allowed = [...UPLOAD_QUERY_NAMES, ...Object.keys(UPLOAD_MUTATION_ROOT_FIELDS)];
  return {
    calls,
    redact,
    apiVersion: 'test',
    async scopes() {
      return [...scopes];
    },
    async gql(document, variables = {}) {
      const viaWrapper = /admin-readonly\.mjs/.test(String(new Error().stack));
      const m = /^\s*(query|mutation)\s+([A-Za-z_]\w*)/.exec(String(document));
      if (!m || !allowed.includes(m[2])) throw new Error(`the fake refuses ${m ? `${m[1]} ${m[2]}` : 'an unnamed document'}`);
      calls.push({ kind: m[1], name: m[2], variables: structuredClone(variables), viaWrapper });
      events.push(m[2]);
      const response = (() => {
        switch (m[2]) {
          case 'ArticleImageFiles': {
            const stem = String(variables.query).replace(/^filename:/, '').replace(/\.jpg$/, '');
            const nodes = Object.entries(existing)
              .filter(([name]) => name.includes(stem))
              .map(([, url], i) => ({ id: `gid://shopify/MediaImage/9${i}`, fileStatus: 'READY', image: { url } }));
            return { files: { nodes } };
          }
          case 'ArticleImageStage': {
            const { filename } = variables.input[0];
            if (stagedErrors.length) return { stagedUploadsCreate: { stagedTargets: [], userErrors: stagedErrors } };
            return {
              stagedUploadsCreate: {
                stagedTargets: [{ url: 'https://staged.invalid/upload', resourceUrl: `https://staged.invalid/r/${filename}`, parameters: [{ name: 'key', value: `k/${filename}` }] }],
                userErrors: [],
              },
            };
          }
          case 'ArticleImageCreate': {
            const { filename } = variables.files[0];
            if (createErrorsFor === filename) return { fileCreate: { files: [], userErrors: [{ field: ['files'], message: 'refused by the fake' }] } };
            if (createNoFileFor === filename) return { fileCreate: { files: [], userErrors: [] } };
            const id = `gid://shopify/MediaImage/${next++}`;
            byId.set(id, { filename, polls: 0 });
            return { fileCreate: { files: [{ id, fileStatus: 'UPLOADED', image: null }], userErrors: [] } };
          }
          case 'ArticleImageFileRead': {
            const entry = byId.get(variables.id);
            const status = entry.filename === failProcessingFor ? 'FAILED' : statuses[Math.min(entry.polls++, statuses.length - 1)];
            const image = status === 'READY' ? { url: cdn(entry.filename, 17), width: 40, height: 30 } : null;
            return { node: { id: variables.id, fileStatus: status, image } };
          }
          default:
            throw new Error(`no response for ${m[2]}`);
        }
      })();
      onCall(m[2], variables);
      return response;
    },
  };
}

/** A recording fake staged-upload endpoint. It reads the multipart file part and hashes its bytes. */
function makeFetch({ ok = true, status = 204, events = [], throws = null } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const file = init.body.get('file');
    const bytes = Buffer.from(await file.arrayBuffer());
    calls.push({ url, method: init.method, name: file.name, type: file.type, size: file.size, key: init.body.get('key'), sha256: sha256(bytes) });
    events.push('fetch');
    if (throws) throw throws;
    return { ok, status };
  };
  fn.calls = calls;
  return fn;
}

function ctxFor({ root, client = null, fetch = null, env = {} }) {
  const logs = [];
  const ctx = createContext({
    repoRoot: temp('articles-upload-repo-'),
    imageRoot: root,
    env,
    client: client,
    fetch,
    now: () => '2026-01-02T03:04:05.000Z',
    stateDir: temp('articles-upload-state-'),
    log: (s) => logs.push(String(s)),
    error: () => {},
    sleep: async () => {},
  });
  return { ctx, logs };
}

const mutationsSent = (client) => client.calls.filter((c) => c.kind === 'mutation').map((c) => c.name);

/** The dry run's plan sha for a root, from a throwaway fake. */
async function planFor(root, clientOptions = {}) {
  return (await run(['--handle', HANDLE], ctxFor({ root, client: makeClient(clientOptions), fetch: makeFetch() }).ctx)).planSha;
}

const confirmed = (sha) => ['--handle', HANDLE, `--confirm=${HANDLE}`, `--expect-plan=${sha}`];

test('the metadata fixtures really carry what the refusal cases say they carry', async () => {
  const clean = await jpeg();
  assert.deepEqual(metadataRefusals(await sharpMetadata(clean), clean), []);
  assert.deepEqual(metadataRefusals(await sharpMetadata(await jpegWithExif())), ['EXIF']);
  assert.deepEqual(metadataRefusals(await sharpMetadata(await jpegWithXmp())), ['XMP']);
  assert.deepEqual(metadataRefusals({ exif: Buffer.from('x'), xmp: Buffer.from('y'), iptc: Buffer.from('z') }), ['EXIF', 'XMP', 'IPTC']);
  assert.deepEqual(metadataRefusals({ comments: [{ keyword: 'Comment', text: 'x' }] }), ['text chunk']);

  // A spliced COM segment is still a readable JPEG, sharp does not report it, and the walk does.
  const commented = withComment(clean);
  const meta = await sharpMetadata(commented);
  assert.equal(meta.format, 'jpeg');
  assert.equal('comments' in meta && meta.comments?.length > 0, false, 'sharp reports JPEG COM after all; the segment walk may be redundant');
  assert.equal(jpegCommentCount(clean), 0);
  assert.equal(jpegCommentCount(commented), 1);
  assert.equal(jpegCommentCount(withComment(commented, 'second')), 2);
  assert.deepEqual(metadataRefusals(meta, commented), ['JPEG COM']);
  assert.equal(jpegCommentCount(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), null, 'a truncated header is unreadable, never clean');
  assert.deepEqual(metadataRefusals({}, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), ['unreadable JPEG segment']);

  assert.equal(isJpegBytes(clean), true);
  assert.equal(isJpegBytes(await png()), false);
  assert.deepEqual(imageProblems(await sharpMetadata(await png()), await png()), ['is not a JPEG']);
  assert.deepEqual(imageProblems(meta, clean), []);
});

test('CI present refuses every mode, including an empty CI and an unknown flag, before anything is read or sent', async () => {
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  const modes = [
    ['--handle', HANDLE],
    ['--handle', HANDLE, '--prepare'],
    ['--handle', HANDLE, `--confirm=${HANDLE}`, '--expect-plan=0'],
    // The refusal precedes flag parsing: under CI an unknown flag gets the CI refusal, not a usage error.
    ['--bogus'],
    ['--handle', HANDLE, '--bogus'],
  ];
  for (const argv of modes) {
    for (const value of ['true', '', 'false']) {
      const client = makeClient();
      const fetch = makeFetch();
      const { ctx } = ctxFor({ root, client, fetch, env: { CI: value } });
      await assert.rejects(run(argv, ctx), /refuses to run with CI set/, argv.join(' '));
      assert.deepEqual(client.calls, []);
      assert.deepEqual(fetch.calls, []);
    }
  }
});

test('main refuses CI and parses flags before it builds a client (read from its source, since this file may not run it)', () => {
  // Located by content, not by name: this file may not spell or build the module's path.
  const dir = join(TEST_DIR, '..');
  const marker = `export const COMMAND = '${COMMAND}';`;
  const sources = readdirSync(dir).filter((n) => n.endsWith('.mjs')).map((n) => readFileSync(join(dir, n), 'utf8')).filter((t) => t.includes(marker));
  assert.equal(sources.length, 1, `expected exactly one module declaring ${marker}`);
  const source = sources[0];
  const start = source.indexOf(['export async function ', 'main', '('].join(''));
  assert.ok(start > 0, 'the uploader has no main to read');
  const body = source.slice(start);
  const ci = body.indexOf(['assertNotCI(', ['process', 'env'].join('.')].join(''));
  const flags = body.indexOf('parseFlags(');
  const client = body.indexOf(['createAdmin', 'Client('].join(''));
  assert.ok(ci > 0 && flags > 0 && client > 0, 'main no longer has the three calls this reads');
  assert.ok(ci < flags && flags < client, 'main must refuse CI, then parse flags, and only then build a client');
});

test('flag coupling refuses before any network: a bad handle, a mismatched confirm, confirm without a plan, a plan without confirm', async () => {
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  const cases = [
    [['--handle', '../escape'], /not a valid article handle/],
    [['--handle', HANDLE, '--confirm=other-post', '--expect-plan=abc'], /must be exactly "a-test-post"/],
    [['--handle', HANDLE, `--confirm=${HANDLE}`], /--expect-plan: is required with --confirm/],
    [['--handle', HANDLE, '--expect-plan=abc'], /does nothing without --confirm/],
    [['--handle', HANDLE, '--prepare', `--confirm=${HANDLE}`], /is offline and takes no --confirm/],
    [[], /needs --handle/],
  ];
  for (const [argv, re] of cases) {
    const client = makeClient();
    const { ctx } = ctxFor({ root, client, fetch: makeFetch() });
    await assert.rejects(run(argv, ctx), re, argv.join(' '));
    assert.deepEqual(client.calls, [], argv.join(' '));
  }
});

test('the dry run lists exactly what would upload, skips what Files already holds, and sends no mutation', async () => {
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg(), [`${HANDLE}-b.jpg`]: await jpeg('#aa5500') });
  const client = makeClient({ existing: { [`${HANDLE}-a.jpg`]: cdn(`${HANDLE}-a.jpg`) } });
  const fetch = makeFetch();
  const { ctx, logs } = ctxFor({ root, client, fetch });
  const result = await run(['--handle', HANDLE], ctx);
  assert.equal(result.code, 0);
  assert.equal(result.reason, 'dry-run');
  assert.deepEqual(result.plan, [`${HANDLE}-b.jpg`]);
  assert.deepEqual(mutationsSent(client), []);
  assert.deepEqual(fetch.calls, []);
  const text = logs.join('\n');
  assert.match(text, /a-test-post-a\.jpg: already in Files, will not upload again \(https:\/\/cdn\.shopify\.com\/s\/files\/1\/0000\/0001\/files\/a-test-post-a\.jpg\)/);
  assert.match(text, /would upload a-test-post-b\.jpg: 40x30/);
  assert.match(text, /PUBLIC at its CDN URL at once/);
  assert.ok(logs.includes(`  --confirm=${HANDLE} --expect-plan=${result.planSha}`), text);
  assert.equal(client.calls.filter((c) => c.name === 'ArticleImageFiles').length, 2);
});

test('the dry run goes through the read-only client, which throws on a mutation; the confirmed run does not', async () => {
  // The wrapper itself: a mutation document never reaches the real client.
  const real = makeClient();
  const readOnly = uploadClient(real, false);
  assert.notEqual(readOnly, real);
  await assert.rejects(readOnly.gql(FILE_CREATE, { files: [] }), /read-only client refused a mutation/);
  assert.deepEqual(real.calls, []);
  assert.equal(uploadClient(real, true), real);

  // And run uses it: every dry-run call arrives through the wrapper, and no confirmed-run call does.
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  const dryClient = makeClient();
  const dry = await run(['--handle', HANDLE], ctxFor({ root, client: dryClient, fetch: makeFetch() }).ctx);
  assert.ok(dryClient.calls.length > 0);
  assert.ok(dryClient.calls.every((c) => c.viaWrapper), JSON.stringify(dryClient.calls));

  const liveClient = makeClient();
  await run(confirmed(dry.planSha), ctxFor({ root, client: liveClient, fetch: makeFetch() }).ctx);
  assert.ok(liveClient.calls.length > 0);
  assert.ok(liveClient.calls.every((c) => !c.viaWrapper), JSON.stringify(liveClient.calls));
});

test('a missing write_files scope refuses in both modes, before any Files query', async () => {
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  for (const argv of [['--handle', HANDLE], confirmed('0'.repeat(64))]) {
    const client = makeClient({ scopes: [] });
    const fetch = makeFetch();
    await assert.rejects(run(argv, ctxFor({ root, client, fetch }).ctx), /scopes: Missing required scope\(s\): write_files/, argv.join(' '));
    assert.deepEqual(client.calls, [], argv.join(' '));
    assert.deepEqual(fetch.calls, []);
  }
});

test('the confirmed run uploads exactly the plan, in order, and prints the images.json entries', async () => {
  const bytes = await jpeg('#aa5500');
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg(), [`${HANDLE}-b.jpg`]: bytes });
  const existing = { [`${HANDLE}-a.jpg`]: cdn(`${HANDLE}-a.jpg`) };
  const sha = await planFor(root, { existing });

  const events = [];
  const client = makeClient({ existing, events });
  const fetch = makeFetch({ events });
  const { ctx, logs } = ctxFor({ root, client, fetch });
  const metadata = async (buffer) => {
    events.push('metadata');
    return sharpMetadata(buffer);
  };
  const result = await run(confirmed(sha), ctx, { metadata });
  assert.equal(result.code, 0);
  assert.deepEqual(result.uploaded.map((u) => u.name), [`${HANDLE}-b.jpg`]);

  // Creates only, and only the reviewed two.
  assert.deepEqual(mutationsSent(client), ['ArticleImageStage', 'ArticleImageCreate']);
  // The metadata check is the step IMMEDIATELY before the staged upload is reserved.
  assert.deepEqual(events.slice(events.indexOf('ArticleImageStage') - 1), ['metadata', 'ArticleImageStage', 'fetch', 'ArticleImageCreate', 'ArticleImageFileRead', 'ArticleImageFileRead']);

  const stage = client.calls.find((c) => c.name === 'ArticleImageStage');
  assert.deepEqual(stage.variables, { input: [{ filename: `${HANDLE}-b.jpg`, mimeType: MIME, resource: 'FILE', httpMethod: 'POST', fileSize: String(bytes.length) }] });
  assert.deepEqual(fetch.calls, [{ url: 'https://staged.invalid/upload', method: 'POST', name: `${HANDLE}-b.jpg`, type: MIME, size: bytes.length, key: `k/${HANDLE}-b.jpg`, sha256: sha256(bytes) }]);
  const create = client.calls.find((c) => c.name === 'ArticleImageCreate');
  assert.deepEqual(create.variables, { files: [{ originalSource: `https://staged.invalid/r/${HANDLE}-b.jpg`, contentType: 'IMAGE', filename: `${HANDLE}-b.jpg` }] });

  const text = logs.join('\n');
  assert.ok(text.includes(`${UPLOAD_MARKER} for ${HANDLE}: ${HANDLE}-b.jpg`), text);
  const json = JSON.parse(text.slice(text.indexOf('[\n')));
  assert.deepEqual(json.map((r) => r.url), [
    `https://cdn.shopify.com/s/files/1/0000/0001/files/${HANDLE}-a.jpg`,
    `https://cdn.shopify.com/s/files/1/0000/0001/files/${HANDLE}-b.jpg`,
  ]);
  assert.ok(json.every((r) => r.width === 40 && r.height === 30 && /^[0-9a-f]{64}$/.test(r.sha256) && !('alt' in r)));
});

test('the pre-staging metadata check runs on the EXACT buffer that is uploaded, not on a second read of the file', async () => {
  const bytes = await jpeg('#aa5500');
  const root = imageRoot({ [`${HANDLE}-b.jpg`]: bytes });
  const sha = await planFor(root);

  // Every buffer the metadata reader is handed, by identity, with the hash it had when checked.
  const checked = new WeakMap();
  const metadata = async (buffer) => {
    checked.set(buffer, sha256(buffer));
    return sharpMetadata(buffer);
  };
  // The bytes handed to the multipart body, by identity. The uploader wraps the buffer it checked in
  // a Blob, so recording the Blob's first part is recording what is sent.
  const sent = [];
  const OriginalBlob = globalThis.Blob;
  globalThis.Blob = class RecordingBlob extends OriginalBlob {
    constructor(parts, options) {
      super(parts, options);
      sent.push(parts[0]);
    }
  };
  const client = makeClient();
  const fetch = makeFetch();
  try {
    await run(confirmed(sha), ctxFor({ root, client, fetch }).ctx, { metadata });
  } finally {
    globalThis.Blob = OriginalBlob;
  }
  assert.equal(sent.length, 1);
  assert.ok(checked.has(sent[0]), 'the buffer sent is not a buffer the metadata check saw: the check ran on a different read');
  assert.equal(checked.get(sent[0]), fetch.calls[0].sha256, 'the bytes that reached the staged endpoint differ from the bytes checked');
  assert.equal(fetch.calls[0].sha256, sha256(bytes));
});

test('a plan that moved since the dry run refuses before any mutation', async () => {
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  const sha = await planFor(root);
  writeFileSync(join(root, HANDLE, `${HANDLE}-a.jpg`), await jpeg('#000000'));
  const client = makeClient();
  const fetch = makeFetch();
  await assert.rejects(run(confirmed(sha), ctxFor({ root, client, fetch }).ctx), /the plan now is/);
  assert.deepEqual(mutationsSent(client), []);
  assert.deepEqual(fetch.calls, []);
});

test('a file rewritten on disk after it was listed refuses on the re-hash, before its first mutation', async () => {
  const a = await jpeg();
  const b = await jpeg('#aa5500');
  const replacement = await jpeg('#00aa55');
  const bPath = (root) => join(root, HANDLE, `${HANDLE}-b.jpg`);

  // 1. Rewritten DURING the listing: the listing hashed the bytes it read, so the plan still matches,
  // and only the upload loop's re-read can see the change. The replacement is a clean JPEG, so the
  // metadata check would pass it: the refusal is the re-hash and nothing else.
  let root = imageRoot({ [`${HANDLE}-a.jpg`]: a, [`${HANDLE}-b.jpg`]: b });
  const existing = { [`${HANDLE}-a.jpg`]: cdn(`${HANDLE}-a.jpg`) };
  let sha = await planFor(root, { existing });
  let calls = 0;
  const rewriteDuringListing = async (buffer) => {
    if (++calls === 2) writeFileSync(bPath(root), replacement);
    return sharpMetadata(buffer);
  };
  let client = makeClient({ existing });
  let fetch = makeFetch();
  await assert.rejects(
    run(confirmed(sha), ctxFor({ root, client, fetch }).ctx, { metadata: rewriteDuringListing }),
    /a-test-post-b\.jpg: changed on disk since it was listed; nothing more is uploaded\. Nothing was uploaded in this run\./,
  );
  assert.deepEqual(mutationsSent(client), []);
  assert.deepEqual(fetch.calls, []);

  // 2. Rewritten after the first file landed: the refusal names that file as already public.
  root = imageRoot({ [`${HANDLE}-a.jpg`]: a, [`${HANDLE}-b.jpg`]: b });
  sha = await planFor(root);
  client = makeClient({
    onCall: (name, variables) => {
      if (name === 'ArticleImageCreate' && variables.files[0].filename === `${HANDLE}-a.jpg`) writeFileSync(bPath(root), replacement);
    },
  });
  fetch = makeFetch();
  await assert.rejects(
    run(confirmed(sha), ctxFor({ root, client, fetch }).ctx),
    /a-test-post-b\.jpg: changed on disk since it was listed; nothing more is uploaded\. Already uploaded and PUBLIC in this run: a-test-post-a\.jpg \(gid:\/\/shopify\/MediaImage\/1\)\./,
  );
  assert.deepEqual(mutationsSent(client), ['ArticleImageStage', 'ArticleImageCreate']);
  assert.deepEqual(fetch.calls.map((c) => c.name), [`${HANDLE}-a.jpg`]);
});

test('a Files search near miss is not a duplicate: the file is still planned', async () => {
  // Shopify's filename search returns every entry containing the stem, so `-a-old` comes back for `-a`.
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  const client = makeClient({ existing: { [`${HANDLE}-a-old.jpg`]: cdn(`${HANDLE}-a-old.jpg`) } });
  const { ctx, logs } = ctxFor({ root, client, fetch: makeFetch() });
  const result = await run(['--handle', HANDLE], ctx);
  assert.deepEqual(result.plan, [`${HANDLE}-a.jpg`]);
  assert.equal(/already in Files/.test(logs.join('\n')), false);
  // The fake really did return the near miss, or this proves nothing.
  const search = client.calls.find((c) => c.name === 'ArticleImageFiles');
  assert.equal(search.variables.query, `filename:${HANDLE}-a.jpg`);
});

test('the whole set refuses before any client call: EXIF, XMP, IPTC, a text chunk, a JPEG COM segment, and non-JPEG bytes', async () => {
  const withSharp = (extra) => async (b) => ({ ...(await sharpMetadata(b)), ...extra });
  for (const [bytes, re, metadata] of [
    [await jpegWithExif(), /a-test-post-b\.jpg: carries EXIF metadata/, undefined],
    [await jpegWithXmp(), /a-test-post-b\.jpg: carries XMP metadata/, undefined],
    [await jpeg(), /a-test-post-b\.jpg: carries IPTC metadata/, withSharp({ iptc: Buffer.from('iptc') })],
    [await jpeg(), /a-test-post-b\.jpg: carries text chunk metadata/, withSharp({ comments: [{ keyword: 'Comment', text: 'x' }] })],
    [withComment(await jpeg()), /a-test-post-b\.jpg: carries JPEG COM metadata/, undefined],
    [await png(), /a-test-post-b\.jpg: is not a JPEG/, undefined],
    [Buffer.from('%PDF-1.7 not an image'), /a-test-post-b\.jpg: is not a JPEG/, async () => ({})],
  ]) {
    const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg(), [`${HANDLE}-b.jpg`]: bytes });
    const client = makeClient();
    const deps = metadata ? { metadata } : {};
    await assert.rejects(run(['--handle', HANDLE], ctxFor({ root, client, fetch: makeFetch() }).ctx, deps), re);
    assert.deepEqual(client.calls, [], String(re));
  }
});

test('metadata that appears between the listing and the upload refuses before stagedUploadsCreate', async () => {
  // The listing reads each file once; the pre-upload check is a separate read of the bytes about to be
  // sent. A reader clean on the first reads and dirty on the last proves the second check exists.
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  const sha = await planFor(root);
  let reads = 0;
  const metadata = async (b) => (++reads === 2 ? { ...(await sharpMetadata(b)), exif: Buffer.from('gps') } : sharpMetadata(b));
  const client = makeClient();
  const fetch = makeFetch();
  await assert.rejects(
    run(confirmed(sha), ctxFor({ root, client, fetch }).ctx, { metadata }),
    /carries EXIF metadata; refusing before stagedUploadsCreate\. Nothing was uploaded in this run\./,
  );
  assert.equal(reads, 2);
  assert.deepEqual(mutationsSent(client), []);
  assert.deepEqual(fetch.calls, []);
});

test('a stray file name, an empty directory and a missing directory each refuse, naming the fix', async () => {
  await assert.rejects(run(['--handle', HANDLE], ctxFor({ root: imageRoot({ 'IMG_0001.jpg': await jpeg() }), client: makeClient() }).ctx), /not upload-ready names .*IMG_0001\.jpg/);
  await assert.rejects(run(['--handle', HANDLE], ctxFor({ root: imageRoot({}), client: makeClient() }).ctx), /holds no upload-ready files; run --prepare first/);
  await assert.rejects(run(['--handle', HANDLE], ctxFor({ root: temp('article-images-empty-'), client: makeClient() }).ctx), /does not exist/);
});

test('failures mid-set name what is already uploaded and public, never the failing file, and stop', async () => {
  const two = { [`${HANDLE}-a.jpg`]: await jpeg(), [`${HANDLE}-b.jpg`]: await jpeg('#aa5500') };
  const publicList = (message) => (/Already uploaded and PUBLIC in this run: (.*?)\. Run the dry run again/.exec(message) ?? [null, null])[1];

  // stagedUploadsCreate userErrors: nothing reaches the staged URL or fileCreate.
  let root = imageRoot(two);
  let sha = await planFor(root);
  let client = makeClient({ stagedErrors: [{ field: ['input'], message: 'nope' }] });
  let fetch = makeFetch();
  await assert.rejects(run(confirmed(sha), ctxFor({ root, client, fetch }).ctx), /stagedUploadsCreate: returned userErrors: nope\. Nothing was uploaded/);
  assert.deepEqual(mutationsSent(client), ['ArticleImageStage']);
  assert.deepEqual(fetch.calls, []);

  // A failed staged POST: no fileCreate for it.
  client = makeClient();
  fetch = makeFetch({ ok: false, status: 403 });
  await assert.rejects(run(confirmed(sha), ctxFor({ root, client, fetch }).ctx), /HTTP 403; no file was created for it/);
  assert.deepEqual(mutationsSent(client), ['ArticleImageStage']);

  // A staged POST that throws: the message is passed through the client's redaction.
  client = makeClient({ redact: (s) => String(s).replace(/credential-\w+/g, '[redacted]') });
  fetch = makeFetch({ throws: new Error('socket hang up for credential-fixture') });
  await assert.rejects(run(confirmed(sha), ctxFor({ root, client, fetch }).ctx), (err) => {
    assert.match(err.message, /the staged upload failed \(socket hang up for \[redacted\]\); no file was created for it\. Nothing was uploaded/);
    assert.equal(err.message.includes('credential-fixture'), false);
    return true;
  });
  assert.deepEqual(mutationsSent(client), ['ArticleImageStage']);

  // fileCreate refuses the second file after the first landed: only the first is named as public.
  client = makeClient({ createErrorsFor: `${HANDLE}-b.jpg` });
  await assert.rejects(run(confirmed(sha), ctxFor({ root, client, fetch: makeFetch() }).ctx), (err) => {
    assert.match(err.message, /fileCreate: returned userErrors: refused by the fake\./);
    assert.equal(publicList(err.message), `${HANDLE}-a.jpg (gid://shopify/MediaImage/1)`);
    return true;
  });

  // fileCreate returns no file and no userErrors: not a success, its existence is unknown, and it is
  // not listed as public.
  client = makeClient({ createNoFileFor: `${HANDLE}-b.jpg` });
  await assert.rejects(run(confirmed(sha), ctxFor({ root, client, fetch: makeFetch() }).ctx), (err) => {
    assert.match(err.message, /returned no file and no userErrors for a-test-post-b\.jpg, so whether it exists is unknown/);
    assert.equal(publicList(err.message), `${HANDLE}-a.jpg (gid://shopify/MediaImage/1)`);
    return true;
  });

  // Processing FAILED on the second file: the refusal names the Admin clean-up for IT, and lists only
  // the first as already public. The failed file is never in its own "already uploaded" list.
  client = makeClient({ failProcessingFor: `${HANDLE}-b.jpg` });
  await assert.rejects(run(confirmed(sha), ctxFor({ root, client, fetch: makeFetch() }).ctx), (err) => {
    assert.match(err.message, /a-test-post-b\.jpg: Shopify reports processing FAILED for gid:\/\/shopify\/MediaImage\/2; delete it in Admin/);
    assert.equal(publicList(err.message), `${HANDLE}-a.jpg (gid://shopify/MediaImage/1)`);
    return true;
  });

  // Processing FAILED on the only file: nothing is listed as uploaded.
  root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  sha = await planFor(root);
  client = makeClient({ failProcessingFor: `${HANDLE}-a.jpg` });
  await assert.rejects(run(confirmed(sha), ctxFor({ root, client, fetch: makeFetch() }).ctx), /processing FAILED .*delete it in Admin.*Nothing was uploaded in this run\./);
});

test('a confirmed run with no fetch implementation refuses before any mutation', async () => {
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  const sha = await planFor(root);
  const client = makeClient();
  await assert.rejects(run(confirmed(sha), ctxFor({ root, client, fetch: null }).ctx), /needs a fetch implementation for the staged upload/);
  assert.deepEqual(mutationsSent(client), []);
});

test('an upload still processing after every poll is reported, not recorded with a guessed URL', async () => {
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  const sha = await planFor(root);
  const client = makeClient({ statuses: ['PROCESSING'] });
  const { ctx, logs } = ctxFor({ root, client, fetch: makeFetch() });
  const result = await run(confirmed(sha), ctx);
  assert.equal(result.code, 0);
  assert.deepEqual(result.uploaded.map((u) => u.name), [`${HANDLE}-a.jpg`]);
  assert.match(logs.join('\n'), /still processing; run the dry run again in a moment for its URL/);
  assert.ok(logs.includes('[]'), 'no record may be printed for a file with no URL yet');
});

test('a confirmed run with nothing left to upload is a no-op that still prints the records', async () => {
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  const existing = { [`${HANDLE}-a.jpg`]: cdn(`${HANDLE}-a_1.jpg`, 2) };
  const client = makeClient({ existing });
  const { ctx, logs } = ctxFor({ root, client, fetch: makeFetch() });
  const result = await run(confirmed(planSha([])), ctx);
  assert.equal(result.reason, 'no-op');
  assert.deepEqual(mutationsSent(client), []);
  assert.match(logs.join('\n'), /a-test-post-a_1\.jpg/);
});

test('--prepare writes clean, handle-prefixed JPEGs offline and never overwrites', async () => {
  const root = temp('article-images-prep-');
  const originals = join(root, HANDLE, 'originals');
  mkdirSync(originals, { recursive: true });
  writeFileSync(join(originals, 'Bench Shot.JPG'), await jpegWithExif());
  writeFileSync(join(originals, 'detail.jpg'), withComment(await jpegWithXmp()));
  const { ctx, logs } = ctxFor({ root });
  const result = await run(['--handle', HANDLE, '--prepare'], ctx);
  assert.deepEqual(result.names, [`${HANDLE}-bench-shot.jpg`, `${HANDLE}-detail.jpg`]);
  for (const name of result.names) {
    const bytes = readFileSync(join(root, HANDLE, name));
    const meta = await sharpMetadata(bytes);
    assert.deepEqual(imageProblems(meta, bytes), [], name);
    assert.equal(meta.format, 'jpeg');
    assert.ok(uploadNameRe(HANDLE).test(name));
  }
  const again = ctxFor({ root });
  await run(['--handle', HANDLE, '--prepare'], again.ctx);
  assert.ok(again.logs.some((l) => l.startsWith(`${HANDLE}-bench-shot.jpg: exists, left as it is`)));
  assert.ok(logs.some((l) => l.includes('Nothing was uploaded')));

  writeFileSync(join(originals, 'phone.heic'), 'not really');
  await assert.rejects(run(['--handle', HANDLE, '--prepare'], ctxFor({ root }).ctx), /does not read: phone\.heic/);
  assert.ok(!existsSync(join(root, HANDLE, `${HANDLE}-phone.jpg`)));
});

test('--prepare refuses output that still carries metadata, and writes nothing at all, not even the clean files before it', async () => {
  const root = temp('article-images-prep-dirty-');
  const originals = join(root, HANDLE, 'originals');
  mkdirSync(originals, { recursive: true });
  writeFileSync(join(originals, 'a.jpg'), await jpeg());
  writeFileSync(join(originals, 'b.jpg'), await jpeg('#aa5500'));
  const exif = await jpegWithExif();
  let calls = 0;
  // A processor that leaves EXIF in the second output only: the first output is clean and must still
  // not be written.
  const process = async (buffer) => (++calls === 2 ? { data: exif, width: 40, height: 30 } : { data: await sharp(buffer).jpeg().toBuffer(), width: 40, height: 30 });
  await assert.rejects(run(['--handle', HANDLE, '--prepare'], ctxFor({ root }).ctx, { process }), /a-test-post-b\.jpg: the processed output carries EXIF metadata; nothing was written/);
  assert.deepEqual(readdirSync(join(root, HANDLE)), ['originals']);
});

test('the pure helpers: names and the plan hash', () => {
  assert.equal(uploadNameFor(HANDLE, 'Bench Shot 01.PNG'), `${HANDLE}-bench-shot-01.jpg`);
  assert.equal(uploadNameFor(HANDLE, `${HANDLE}-cover.jpg`), `${HANDLE}-cover.jpg`);
  assert.throws(() => uploadNameFor(HANDLE, '__.jpg'), /no usable characters/);
  assert.equal(uploadNameRe(HANDLE).test(`${HANDLE}-cover.jpg`), true);
  for (const bad of ['cover.jpg', `${HANDLE}-Cover.jpg`, `${HANDLE}-cover.png`, `${HANDLE}--cover.jpg`, `other-${HANDLE}-cover.jpg`]) {
    assert.equal(uploadNameRe(HANDLE).test(bad), false, bad);
  }
  const a = { name: 'x-a.jpg', sha256: '1'.repeat(64) };
  const b = { name: 'x-b.jpg', sha256: '2'.repeat(64) };
  assert.equal(planSha([a, b]), planSha([b, a]));
  assert.notEqual(planSha([a, b]), planSha([a, { ...b, sha256: '3'.repeat(64) }]));
  assert.notEqual(planSha([a]), planSha([]));
});
