// The Flow run-list console parser.
//
// EVERY INPUT HERE IS SYNTHETIC AND HAND-WRITTEN. No sample of real probe output may be committed,
// as a fixture or as an illustration: run ids and timestamps from a real store are live operational
// data, and this repo is public. That rule is the reason the probe itself has no test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlowRuns, describeFlowRuns, normaliseStatus, IN_PROGRESS_STATUSES, TERMINAL_STATUSES } from '../lib/flow-runs.mjs';

const run = (id, status, retrying, startedAt) => `SSSFLOWRUN ${id} ${status} ${retrying} ${startedAt}`;
const T = '2026-01-01T00:00:00.000Z';

test('counts runs by status and separates the retrying in-progress ones', () => {
  const reading = parseFlowRuns(
    [
      'SSSFLOWPAGE 4',
      run('r1', 'IN_PROGRESS', 'true', '2026-01-01T00:00:10.000Z'),
      run('r2', 'IN_PROGRESS', 'false', '2026-01-01T00:00:20.000Z'),
      run('r3', 'SUCCESS', 'false', '2026-01-01T00:00:30.000Z'),
      run('r4', 'FAILED', 'false', '2026-01-01T00:00:40.000Z'),
    ].join('\n')
  );
  assert.equal(reading.runs, 4);
  assert.equal(reading.inProgress, 2);
  assert.equal(reading.inProgressWithRetries, 1);
  assert.deepEqual(reading.byStatus, { inprogress: 2, success: 1, failed: 1 });
  assert.equal(reading.pages, 1);
});

test('the oldest in-progress timestamp ignores finished runs, however old they are', () => {
  const reading = parseFlowRuns(
    [
      run('old-and-done', 'SUCCESS', 'false', '2025-01-01T00:00:00.000Z'),
      run('r1', 'IN_PROGRESS', 'false', '2026-01-01T00:05:00.000Z'),
      run('r2', 'IN_PROGRESS', 'false', '2026-01-01T00:01:00.000Z'),
    ].join('\n')
  );
  assert.equal(reading.oldestInProgressAt, '2026-01-01T00:01:00.000Z');
});

test('a run seen in several responses is counted ONCE, and the last status wins', () => {
  // The run-list page refetches as it paginates and polls, so one run legitimately appears more
  // than once. Counting each appearance would inflate exactly the number being watched.
  const reading = parseFlowRuns([run('r1', 'IN_PROGRESS', 'true', T), 'SSSFLOWPAGE 1', run('r1', 'SUCCESS', 'false', T)].join('\n'));
  assert.equal(reading.runs, 1);
  assert.equal(reading.inProgress, 0);
  assert.deepEqual(reading.byStatus, { success: 1 });
});

test('an unrecognised status is counted and NAMED, never folded into finished', () => {
  // Flow's run-list statuses are unversioned Admin internals. A parser that rounded an unknown one
  // into "done" would under-report the pile-up this exists to see.
  const reading = parseFlowRuns(run('r1', 'SOME_NEW_STATE', 'false', T));
  assert.equal(reading.runs, 1);
  assert.equal(reading.inProgress, 0);
  assert.deepEqual(reading.unclassified, ['somenewstate']);
  assert.match(describeFlowRuns(reading).join('\n'), /UNCLASSIFIED/);
});

test('a short, over-long or malformed line is reported, never silently dropped', () => {
  // A missing field would otherwise shift every field left and turn a status into a run id.
  const reading = parseFlowRuns(
    [
      'SSSFLOWRUN r1 IN_PROGRESS true',
      'SSSFLOWRUN r2 IN_PROGRESS true 2026-01-01T00:00:00.000Z extra',
      'SSSFLOWRUN r3 IN_PROGRESS maybe 2026-01-01T00:00:00.000Z',
      'SSSFLOWRUN r4 IN_PROGRESS true not-a-date',
      run('r5', 'IN_PROGRESS', 'true', T),
    ].join('\n')
  );
  assert.equal(reading.runs, 1, 'only the well-formed line counts');
  assert.equal(reading.malformed.length, 4);
  assert.match(describeFlowRuns(reading).join('\n'), /unparseable/);
});

test('unrelated console noise between the probe lines is ignored', () => {
  const reading = parseFlowRuns(['[Report Only] Refused to load', run('r1', 'SUCCESS', 'false', T), 'Download the React DevTools'].join('\n'));
  assert.equal(reading.runs, 1);
  assert.deepEqual(reading.malformed, []);
});

test('no matching response at all is reported as such, not as a healthy empty run list', () => {
  // The difference between "the Flow is quiet" and "the probe matched nothing" is the whole
  // reliability of the reading, and they look identical in a count of zero.
  const reading = parseFlowRuns('SSSFLOWNONE ShopQuery,PolarisBanner');
  assert.equal(reading.sawNone, true);
  assert.equal(reading.runs, 0);
  assert.match(describeFlowRuns(reading)[0], /matched nothing/);
});

test('an empty or absent blob parses to a zero reading rather than throwing', () => {
  for (const input of ['', null, undefined]) {
    const reading = parseFlowRuns(input);
    assert.equal(reading.runs, 0);
    assert.equal(reading.oldestInProgressAt, null);
  }
});

test('normaliseStatus folds case and separators, so IN_PROGRESS and "In progress" agree', () => {
  assert.equal(normaliseStatus('IN_PROGRESS'), 'inprogress');
  assert.equal(normaliseStatus('In progress'), 'inprogress');
  assert.equal(normaliseStatus('in-progress'), 'inprogress');
});

test('no status token is in both the in-progress and the terminal set', () => {
  // An overlap would make the classification order-dependent and the in-progress count arbitrary.
  const both = [...IN_PROGRESS_STATUSES].filter((s) => TERMINAL_STATUSES.has(s));
  assert.deepEqual(both, []);
});

test('every listed status token is already in its normalised spelling', () => {
  // The sets are compared against normaliseStatus output, so a token carrying an underscore or a
  // capital could never match anything and would silently classify nothing.
  for (const status of [...IN_PROGRESS_STATUSES, ...TERMINAL_STATUSES]) {
    assert.equal(status, normaliseStatus(status), `${status} is not in normalised form`);
  }
});

test('describeFlowRuns dates the oldest in-progress run against an injected clock', () => {
  const reading = parseFlowRuns(run('r1', 'IN_PROGRESS', 'true', '2026-01-01T00:00:00.000Z'));
  const lines = describeFlowRuns(reading, { now: Date.parse('2026-01-01T00:04:00.000Z') });
  assert.match(lines.join('\n'), /240s ago/);
  assert.match(lines.join('\n'), /1 in progress, of which 1 retrying/);
});

test('describeFlowRuns offers no verdict, only a reading', () => {
  // Nothing downstream consumes this, and a green run list is never permission to apply. A line
  // that said "safe to proceed" would be the exact thing the design rejects.
  const reading = parseFlowRuns(run('r1', 'SUCCESS', 'false', T));
  const text = describeFlowRuns(reading).join('\n').toLowerCase();
  for (const word of ['safe', 'ok to', 'proceed', 'healthy', 'go ahead']) {
    assert.ok(!text.includes(word), `the reading must not say "${word}"`);
  }
});
