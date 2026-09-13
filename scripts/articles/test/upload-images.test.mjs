// The image uploader against a recording fake client and a recording fake fetch. NOTHING HERE REACHES
// A STORE: the fake refuses every operation outside the uploader's four reviewed names, and the CLI
// cases run with every Shopify variable removed from the child's environment.
//
// Real images, made with sharp, carry the metadata cases: a JPEG with EXIF, one with XMP. IPTC cannot
// be written by sharp, so that case injects the metadata reader, which is also how the suite proves
// the metadata check runs on the exact bytes immediately before `stagedUploadsCreate`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';

import { createContext } from '../lib/context.mjs';
import { UPLOAD_MUTATION_ROOT_FIELDS } from '../lib/mutations.mjs';
import { UPLOAD_QUERY_NAMES } from '../lib/queries.mjs';
import {
  COMMAND,
  MIME,
  UPLOAD_MARKER,
  matchesFilename,
  metadataRefusals,
  planSha,
  run,
  sharpMetadata,
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

const jpeg = (colour = '#336699') => sharp({ create: { width: 40, height: 30, channels: 3, background: colour } }).jpeg().toBuffer();
const jpegWithExif = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#993366' } }).withExif({ IFD0: { Copyright: 'test fixture' } }).jpeg().toBuffer();
const jpegWithXmp = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#669933' } })
  .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF></x:xmpmeta>')
  .jpeg()
  .toBuffer();

/** An image root holding `files` (name to bytes) under the handle's directory. */
function imageRoot(files) {
  const root = temp('article-images-');
  const dir = join(root, HANDLE);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return root;
}

/** A recording fake Files API. `existing` maps a filename to the CDN URL Files already holds for it. */
function makeClient({ existing = {}, scopes = ['write_files'], stagedErrors = [], createErrorsFor = null, statuses = ['PROCESSING', 'READY'], events = [] } = {}) {
  const calls = [];
  const byId = new Map();
  let next = 1;
  const allowed = [...UPLOAD_QUERY_NAMES, ...Object.keys(UPLOAD_MUTATION_ROOT_FIELDS)];
  return {
    calls,
    redact: (s) => String(s ?? ''),
    apiVersion: 'test',
    async scopes() {
      return [...scopes];
    },
    async gql(document, variables = {}) {
      const m = /^\s*(query|mutation)\s+([A-Za-z_]\w*)/.exec(String(document));
      if (!m || !allowed.includes(m[2])) throw new Error(`the fake refuses ${m ? `${m[1]} ${m[2]}` : 'an unnamed document'}`);
      calls.push({ kind: m[1], name: m[2], variables: structuredClone(variables) });
      events.push(m[2]);
      switch (m[2]) {
        case 'ArticleImageFiles': {
          const name = String(variables.query).replace(/^filename:/, '');
          return { files: { nodes: existing[name] ? [{ id: 'gid://shopify/MediaImage/9', fileStatus: 'READY', image: { url: existing[name] } }] : [] } };
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
          const id = `gid://shopify/MediaImage/${next++}`;
          byId.set(id, { filename, polls: 0 });
          return { fileCreate: { files: [{ id, fileStatus: 'UPLOADED', image: null }], userErrors: [] } };
        }
        case 'ArticleImageFileRead': {
          const entry = byId.get(variables.id);
          const status = statuses[Math.min(entry.polls++, statuses.length - 1)];
          const image = status === 'READY' ? { url: `https://cdn.shopify.com/s/files/1/0000/0001/files/${entry.filename}?v=17`, width: 40, height: 30 } : null;
          return { node: { id: variables.id, fileStatus: status, image } };
        }
        default:
          throw new Error(`no response for ${m[2]}`);
      }
    },
  };
}

function makeFetch({ ok = true, status = 204, events = [] } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const file = init.body.get('file');
    calls.push({ url, method: init.method, name: file.name, type: file.type, size: file.size, key: init.body.get('key') });
    events.push('fetch');
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
    client,
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

test('the metadata fixtures really carry what the refusal cases say they carry', async () => {
  assert.deepEqual(metadataRefusals(await sharpMetadata(await jpeg())), []);
  assert.deepEqual(metadataRefusals(await sharpMetadata(await jpegWithExif())), ['EXIF']);
  assert.deepEqual(metadataRefusals(await sharpMetadata(await jpegWithXmp())), ['XMP']);
  assert.deepEqual(metadataRefusals({ exif: Buffer.from('x'), xmp: Buffer.from('y'), iptc: Buffer.from('z') }), ['EXIF', 'XMP', 'IPTC']);
});

test('CI present refuses every mode, including an empty CI, before anything is read or sent', async () => {
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  for (const argv of [['--handle', HANDLE], ['--handle', HANDLE, '--prepare'], ['--handle', HANDLE, `--confirm=${HANDLE}`, '--expect-plan=0']]) {
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
  const client = makeClient({ existing: { [`${HANDLE}-a.jpg`]: `https://cdn.shopify.com/s/files/1/0000/0001/files/${HANDLE}-a.jpg?v=3` } });
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

test('the confirmed run uploads exactly the plan, in order, and prints the images.json entries', async () => {
  const bytes = await jpeg('#aa5500');
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg(), [`${HANDLE}-b.jpg`]: bytes });
  const existing = { [`${HANDLE}-a.jpg`]: `https://cdn.shopify.com/s/files/1/0000/0001/files/${HANDLE}-a.jpg?v=3` };
  const dry = await run(['--handle', HANDLE], ctxFor({ root, client: makeClient({ existing }), fetch: makeFetch() }).ctx);

  const events = [];
  const client = makeClient({ existing, events });
  const fetch = makeFetch({ events });
  const { ctx, logs } = ctxFor({ root, client, fetch });
  const metadata = async (buffer) => {
    events.push('metadata');
    return sharpMetadata(buffer);
  };
  const result = await run(['--handle', HANDLE, `--confirm=${HANDLE}`, `--expect-plan=${dry.planSha}`], ctx, { metadata });
  assert.equal(result.code, 0);
  assert.deepEqual(result.uploaded.map((u) => u.name), [`${HANDLE}-b.jpg`]);

  // Creates only, and only the reviewed two.
  assert.deepEqual(mutationsSent(client), ['ArticleImageStage', 'ArticleImageCreate']);
  // The metadata check is the step IMMEDIATELY before the staged upload is reserved.
  assert.deepEqual(events.slice(events.indexOf('ArticleImageStage') - 1), ['metadata', 'ArticleImageStage', 'fetch', 'ArticleImageCreate', 'ArticleImageFileRead', 'ArticleImageFileRead']);

  const stage = client.calls.find((c) => c.name === 'ArticleImageStage');
  assert.deepEqual(stage.variables, { input: [{ filename: `${HANDLE}-b.jpg`, mimeType: MIME, resource: 'FILE', httpMethod: 'POST', fileSize: String(bytes.length) }] });
  assert.deepEqual(fetch.calls, [{ url: 'https://staged.invalid/upload', method: 'POST', name: `${HANDLE}-b.jpg`, type: MIME, size: bytes.length, key: `k/${HANDLE}-b.jpg` }]);
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

test('a plan that moved since the dry run refuses before any mutation', async () => {
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  const dry = await run(['--handle', HANDLE], ctxFor({ root, client: makeClient(), fetch: makeFetch() }).ctx);
  writeFileSync(join(root, HANDLE, `${HANDLE}-a.jpg`), await jpeg('#000000'));
  const client = makeClient();
  const fetch = makeFetch();
  await assert.rejects(run(['--handle', HANDLE, `--confirm=${HANDLE}`, `--expect-plan=${dry.planSha}`], ctxFor({ root, client, fetch }).ctx), /the plan now is/);
  assert.deepEqual(mutationsSent(client), []);
  assert.deepEqual(fetch.calls, []);
});

test('identifying metadata refuses the whole set before any client call: EXIF, XMP, and IPTC', async () => {
  for (const [bytes, label, metadata] of [
    [await jpegWithExif(), 'EXIF', undefined],
    [await jpegWithXmp(), 'XMP', undefined],
    [await jpeg(), 'IPTC', async (b) => ({ ...(await sharpMetadata(b)), iptc: Buffer.from('iptc') })],
  ]) {
    const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg(), [`${HANDLE}-b.jpg`]: bytes });
    const client = makeClient();
    const deps = metadata ? { metadata } : {};
    await assert.rejects(run(['--handle', HANDLE], ctxFor({ root, client, fetch: makeFetch() }).ctx, deps), new RegExp(`a-test-post-b\\.jpg: carries ${label} metadata`));
    assert.deepEqual(client.calls, [], label);
  }
});

test('metadata that appears between the listing and the upload refuses before stagedUploadsCreate', async () => {
  // The listing reads each file once; the pre-upload check is a separate read of the bytes about to be
  // sent. A reader clean on the first reads and dirty on the last proves the second check exists.
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  const dry = await run(['--handle', HANDLE], ctxFor({ root, client: makeClient(), fetch: makeFetch() }).ctx);
  let reads = 0;
  const metadata = async (b) => (++reads === 2 ? { ...(await sharpMetadata(b)), exif: Buffer.from('gps') } : sharpMetadata(b));
  const client = makeClient();
  const fetch = makeFetch();
  await assert.rejects(
    run(['--handle', HANDLE, `--confirm=${HANDLE}`, `--expect-plan=${dry.planSha}`], ctxFor({ root, client, fetch }).ctx, { metadata }),
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

test('failures mid-set name what is already uploaded and public, and stop', async () => {
  const two = { [`${HANDLE}-a.jpg`]: await jpeg(), [`${HANDLE}-b.jpg`]: await jpeg('#aa5500') };

  // stagedUploadsCreate userErrors: nothing reaches the staged URL or fileCreate.
  let root = imageRoot(two);
  let dry = await run(['--handle', HANDLE], ctxFor({ root, client: makeClient(), fetch: makeFetch() }).ctx);
  let client = makeClient({ stagedErrors: [{ field: ['input'], message: 'nope' }] });
  let fetch = makeFetch();
  await assert.rejects(run(['--handle', HANDLE, `--confirm=${HANDLE}`, `--expect-plan=${dry.planSha}`], ctxFor({ root, client, fetch }).ctx), /stagedUploadsCreate: returned userErrors: nope\. Nothing was uploaded/);
  assert.deepEqual(mutationsSent(client), ['ArticleImageStage']);
  assert.deepEqual(fetch.calls, []);

  // A failed staged POST: no fileCreate for it.
  client = makeClient();
  fetch = makeFetch({ ok: false, status: 403 });
  await assert.rejects(run(['--handle', HANDLE, `--confirm=${HANDLE}`, `--expect-plan=${dry.planSha}`], ctxFor({ root, client, fetch }).ctx), /HTTP 403; no file was created for it/);
  assert.deepEqual(mutationsSent(client), ['ArticleImageStage']);

  // fileCreate refuses the second file after the first landed: the first is named as public.
  client = makeClient({ createErrorsFor: `${HANDLE}-b.jpg` });
  await assert.rejects(
    run(['--handle', HANDLE, `--confirm=${HANDLE}`, `--expect-plan=${dry.planSha}`], ctxFor({ root, client, fetch: makeFetch() }).ctx),
    /fileCreate: returned userErrors: refused by the fake\. Already uploaded and PUBLIC in this run: a-test-post-a\.jpg \(gid:\/\/shopify\/MediaImage\/1\)/,
  );

  // Processing FAILED is a refusal naming the Admin clean-up.
  root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  dry = await run(['--handle', HANDLE], ctxFor({ root, client: makeClient(), fetch: makeFetch() }).ctx);
  client = makeClient({ statuses: ['FAILED'] });
  await assert.rejects(run(['--handle', HANDLE, `--confirm=${HANDLE}`, `--expect-plan=${dry.planSha}`], ctxFor({ root, client, fetch: makeFetch() }).ctx), /processing FAILED .*delete it in Admin/);
});

test('an upload still processing after every poll is reported, not recorded with a guessed URL', async () => {
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  const dry = await run(['--handle', HANDLE], ctxFor({ root, client: makeClient(), fetch: makeFetch() }).ctx);
  const client = makeClient({ statuses: ['PROCESSING'] });
  const { ctx, logs } = ctxFor({ root, client, fetch: makeFetch() });
  const result = await run(['--handle', HANDLE, `--confirm=${HANDLE}`, `--expect-plan=${dry.planSha}`], ctx);
  assert.equal(result.code, 0);
  assert.match(logs.join('\n'), /still processing; run the dry run again in a moment for its URL/);
  assert.ok(logs.includes('[]'), 'no record may be printed for a file with no URL yet');
});

test('a confirmed run with nothing left to upload is a no-op that still prints the records', async () => {
  const root = imageRoot({ [`${HANDLE}-a.jpg`]: await jpeg() });
  const existing = { [`${HANDLE}-a.jpg`]: `https://cdn.shopify.com/s/files/1/0000/0001/files/${HANDLE}-a_1.jpg?v=2` };
  const client = makeClient({ existing });
  const { ctx, logs } = ctxFor({ root, client, fetch: makeFetch() });
  const result = await run(['--handle', HANDLE, `--confirm=${HANDLE}`, `--expect-plan=${planSha([])}`], ctx);
  assert.equal(result.reason, 'no-op');
  assert.deepEqual(mutationsSent(client), []);
  assert.match(logs.join('\n'), /a-test-post-a_1\.jpg/);
});

test('--prepare writes clean, handle-prefixed JPEGs offline and never overwrites', async () => {
  const root = temp('article-images-prep-');
  const originals = join(root, HANDLE, 'originals');
  mkdirSync(originals, { recursive: true });
  writeFileSync(join(originals, 'Bench Shot.JPG'), await jpegWithExif());
  writeFileSync(join(originals, 'detail.jpg'), await jpegWithXmp());
  const { ctx, logs } = ctxFor({ root });
  const result = await run(['--handle', HANDLE, '--prepare'], ctx);
  assert.deepEqual(result.names, [`${HANDLE}-bench-shot.jpg`, `${HANDLE}-detail.jpg`]);
  for (const name of result.names) {
    const meta = await sharpMetadata(readFileSync(join(root, HANDLE, name)));
    assert.deepEqual(metadataRefusals(meta), [], name);
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

test('the pure helpers: names, the duplicate matcher and the plan hash', () => {
  assert.equal(uploadNameFor(HANDLE, 'Bench Shot 01.PNG'), `${HANDLE}-bench-shot-01.jpg`);
  assert.equal(uploadNameFor(HANDLE, `${HANDLE}-cover.jpg`), `${HANDLE}-cover.jpg`);
  assert.throws(() => uploadNameFor(HANDLE, '__.jpg'), /no usable characters/);
  assert.equal(uploadNameRe(HANDLE).test(`${HANDLE}-cover.jpg`), true);
  for (const bad of ['cover.jpg', `${HANDLE}-Cover.jpg`, `${HANDLE}-cover.png`, `${HANDLE}--cover.jpg`, `other-${HANDLE}-cover.jpg`]) {
    assert.equal(uploadNameRe(HANDLE).test(bad), false, bad);
  }
  const url = (stem) => `https://cdn.shopify.com/s/files/1/0000/0001/files/${stem}.jpg?v=9`;
  assert.equal(matchesFilename(url('a-test-post-cover'), 'a-test-post-cover.jpg'), true);
  assert.equal(matchesFilename(url('a-test-post-cover_2'), 'a-test-post-cover.jpg'), true);
  assert.equal(matchesFilename(url('a-test-post-cover-2'), 'a-test-post-cover.jpg'), false);
  assert.equal(matchesFilename(url('a-test-post-cover_x'), 'a-test-post-cover.jpg'), false);
  assert.equal(matchesFilename('not a url', 'a-test-post-cover.jpg'), false);
  const a = { name: 'x-a.jpg', sha256: '1'.repeat(64) };
  const b = { name: 'x-b.jpg', sha256: '2'.repeat(64) };
  assert.equal(planSha([a, b]), planSha([b, a]));
  assert.notEqual(planSha([a, b]), planSha([a, { ...b, sha256: '3'.repeat(64) }]));
  assert.notEqual(planSha([a]), planSha([]));
});

function childEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:MYSHOPIFY_|SHOPIFY_)/.test(key) || key === 'CI') continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

test('the CLI refuses under CI before it builds a client, and without CI fails only for want of credentials', () => {
  const script = join(TEST_DIR, '..', 'upload-images.mjs');
  const refused = spawnSync(process.execPath, [script, '--handle', HANDLE], { encoding: 'utf8', env: childEnv({ CI: '1' }) });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /refuses to run with CI set/);
  assert.match(refused.stderr, new RegExp(`${COMMAND} refused; nothing was uploaded`));
  assert.equal(/MYSHOPIFY_DOMAIN/.test(refused.stderr), false, 'the CI refusal must come before a client is built');

  const noCreds = spawnSync(process.execPath, [script, '--handle', HANDLE], { encoding: 'utf8', env: childEnv({}) });
  assert.equal(noCreds.status, 1, noCreds.stderr);
  assert.match(noCreds.stderr, /Missing required env MYSHOPIFY_DOMAIN/);
});
