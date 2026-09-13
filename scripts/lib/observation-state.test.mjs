// scripts/lib/observation-state.mjs: the seams that exist only because the mechanism is shared.
//
// WHY THIS IS A SEPARATE FILE from scripts/policies/test/state.test.mjs. That suite exercises the
// mechanism thoroughly, and it will keep doing so, but it reaches it through the policies wrapper:
// every assertion in it sits at ONE point in configuration space. A mutant that deletes the
// parameterisation outright, hardcoding `policies` as the entries key and `1` as the schema
// version, leaves all of those tests green, because at the policies configuration a parameterised
// module and a hardcoded one are indistinguishable. That is not a gap in those tests; it is a
// property of where they stand.
//
// So what is tested HERE is only what a SECOND configuration can reach, which is the entire reason
// the extraction happened. The configuration below is deliberately unlike the policies one in every
// parameterised field, and it is named for the articles subsystem that will be the second consumer.
//
// EVERY PATH IN THIS FILE IS UNDER A TEMP ROOT, asserted by a guard in an `after()` hook: a bug
// that resolved a real XDG path would quietly write to the operator's own state.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { ObservationStateError, createObservationState } from './observation-state.mjs';

const TEMP_ROOT = statSync(tmpdir()).isDirectory() ? tmpdir() : null;
const MADE = [];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'observation-state-'));
  MADE.push(dir);
  return dir;
}

after(() => {
  // The guard runs HERE rather than as a test: as a top-level test it would execute in declaration
  // order, before any test body had called `scratch()`, so `MADE` would be empty and the loop would
  // check nothing. The non-empty assertion is what stops it going quiet.
  assert.ok(TEMP_ROOT, 'no usable temp directory');
  assert.ok(MADE.length > 0, 'the temp-root guard ran before anything was created, so it checked nothing');
  for (const dir of MADE) {
    assert.ok(dir.startsWith(TEMP_ROOT), `${dir} is not under the temp root`);
  }
  for (const dir of MADE) rmSync(dir, { recursive: true, force: true });
});

/** A configuration unlike the policies one in every field that is parameterised. */
const ARTICLES = Object.freeze({
  dirBasename: 'articles-state',
  envVar: 'ARTICLES_STATE_DIR',
  entriesKey: 'articles',
  seedCommand: 'npm run articles:pull',
  schemaVersion: 2,
});

// ---------------------------------------------------------------------------------------------
// The parameterisation, which only a second configuration can see
// ---------------------------------------------------------------------------------------------

test('a second subsystem gets ITS entries key and ITS schema version, not the policies ones', () => {
  // Against a module with the policies configuration inlined, every assertion below fails. That is
  // the point of the test: it is the one that can tell a shared mechanism from a copy of the old
  // file with the parameters pasted back in.
  const store = createObservationState(ARTICLES);
  const dir = scratch();

  assert.deepEqual(store.emptyState(), { schemaVersion: 2, articles: {} });

  const state = store.emptyState();
  state.articles.welcome = { sha256: 'abc' };
  store.write({ dir, state });
  assert.deepEqual(store.read({ dir }), state, 'what was written did not read back');
  assert.equal(store.entry(store.read({ dir }), 'welcome').sha256, 'abc');
  assert.equal(store.entry(store.read({ dir }), 'absent'), undefined);

  // A policies-shaped file is not an articles file, and v1 is not v2. Both refusals name THIS
  // subsystem's seed command, because a refusal naming another subsystem's command is worse than
  // no refusal: it sends the operator to a tool that will not touch this file.
  writeFileSync(store.filePath(dir), JSON.stringify({ schemaVersion: 2, policies: {} }), 'utf8');
  assert.throws(
    () => store.read({ dir }),
    (err) => {
      assert.match(err.message, /has no "articles" object/);
      assert.match(err.message, /npm run articles:pull/);
      return true;
    },
  );

  writeFileSync(store.filePath(dir), JSON.stringify({ schemaVersion: 1, articles: {} }), 'utf8');
  assert.throws(() => store.read({ dir }), /has schemaVersion 1, but this tool understands 2/);
});

test('the directory and the override are the configured ones, and another subsystem cannot move them', () => {
  const store = createObservationState(ARTICLES);
  assert.equal(store.defaultDir({ XDG_STATE_HOME: '/var/state' }), join('/var/state', 'articles-state'));
  assert.equal(store.resolveDir({ ARTICLES_STATE_DIR: '/abs/articles' }), join(sep, 'abs', 'articles'));
  assert.equal(store.filePath('/x'), join('/x', 'observed.json'));
  // The POLICIES override must not relocate this subsystem's file, which is the failure a single
  // shared environment variable would have introduced.
  assert.equal(
    store.resolveDir({ POLICIES_STATE_DIR: '/elsewhere', XDG_STATE_HOME: '/var/state' }),
    join('/var/state', 'articles-state'),
  );
});

test('the containment refusal names THIS subsystem variable, not the basename and not another subsystem', () => {
  // Pre-extraction this was a literal `new PolicyError('POLICIES_STATE_DIR', ...)`. Both halves of
  // it became parameterised in the same change, so both can now be wrong silently: a refusal that
  // names the wrong variable tells the operator to edit something that will not fix it.
  const store = createObservationState(ARTICLES);
  const root = scratch();
  assert.throws(
    () => store.assertOutsideRepo(join(root, 'nested'), root),
    (err) => {
      assert.ok(err instanceof ObservationStateError, `not an ObservationStateError: ${err.name}`);
      assert.equal(err.subject, 'ARTICLES_STATE_DIR', 'the refusal must name the variable the operator sets');
      assert.match(err.message, /inside the checkout/);
      return true;
    },
  );
  assert.doesNotThrow(() => store.assertOutsideRepo(scratch(), root));
});

// ---------------------------------------------------------------------------------------------
// The factory refuses what it cannot use
// ---------------------------------------------------------------------------------------------

test('the factory refuses a configuration it cannot use, rather than defaulting one', () => {
  // Every field here decides where a machine-local file lives or what a refusal tells the operator
  // to run. A blank one that silently became `undefined` in a path would put the state file
  // somewhere nobody looks, and the symptom would be a freshness gate that never fires.
  for (const field of ['dirBasename', 'envVar', 'entriesKey', 'seedCommand']) {
    for (const bad of ['', '   ', undefined, null, 7]) {
      assert.throws(() => createObservationState({ ...ARTICLES, [field]: bad }), TypeError, `${field}=${JSON.stringify(bad)}`);
    }
  }
  for (const bad of [0, -1, 1.5, '1', undefined, null]) {
    assert.throws(() => createObservationState({ ...ARTICLES, schemaVersion: bad }), TypeError, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => createObservationState(ARTICLES));
});

test('a non-constructor ErrorClass is refused at BUILD time, not at the refusal it would have thrown', () => {
  // The failure this prevents is the nastiest shape available: the factory builds, the tool runs,
  // and the `TypeError` surfaces only when something else has already gone wrong and the operator
  // needs to read a message. Omitting it entirely is legitimate and must keep working.
  for (const bad of [7, 'PolicyError', {}, null, []]) {
    assert.throws(
      () => createObservationState({ ...ARTICLES, ErrorClass: bad }),
      (err) => {
        assert.ok(err instanceof TypeError, JSON.stringify(bad));
        assert.match(err.message, /ErrorClass must be a constructor/);
        return true;
      },
      JSON.stringify(bad),
    );
  }

  const store = createObservationState({ ...ARTICLES, ErrorClass: undefined });
  const root = scratch();
  assert.throws(() => store.assertOutsideRepo(root, root), ObservationStateError, 'the default class must still work');
});
