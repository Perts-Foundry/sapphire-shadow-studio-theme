// The five absolutes are duplicated ON PURPOSE, in three files. This asserts the copies match.
//
// WHY DUPLICATE THEM AT ALL. CLAUDE.md is always loaded. `SKILL.md` loads only if the skill
// triggers, and `push.md` only if the agent routes there. An agent reaching `policies:push` from
// `package.json`, from shell history, or from a command someone pasted sees none of it. So the
// rules that must bind unconditionally are copied to the files most likely to be open at the
// moment they matter, and `push.md` carries a copy specifically because it is the file open at the
// moment of the write, possibly after a compaction dropped `SKILL.md`.
//
// Three copies of a rule is three chances to drift, and a drifted absolute is worse than no
// absolute: an agent that finds two versions picks the convenient one. So each copy sits between
// the same pair of markers, this test compares them byte for byte, and every copy carries the line
// telling a reader what to do if they ever differ.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../check.mjs';

const BEGIN = '<!-- policies-absolutes:begin -->';
const END = '<!-- policies-absolutes:end -->';

/** CLAUDE.md is the canonical copy; the other two are copies of it. */
const CANONICAL = join(REPO_ROOT, 'CLAUDE.md');
const COPIES = [
  join(REPO_ROOT, '.claude', 'skills', 'shop-policies', 'SKILL.md'),
  join(REPO_ROOT, '.claude', 'skills', 'shop-policies', 'push.md'),
];

function extract(file) {
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  assert.notEqual(start, -1, `${file}: no ${BEGIN} marker`);
  assert.notEqual(end, -1, `${file}: no ${END} marker`);
  assert.ok(end > start, `${file}: the markers are in the wrong order`);
  assert.equal(text.indexOf(BEGIN, start + 1), -1, `${file}: two begin markers`);
  return text.slice(start + BEGIN.length, end).trim();
}

test('the five absolutes are byte-identical in CLAUDE.md, SKILL.md and push.md', () => {
  const canonical = extract(CANONICAL);
  for (const copy of COPIES) {
    assert.equal(
      extract(copy),
      canonical,
      `${copy} has drifted from CLAUDE.md. CLAUDE.md is canonical; copy it verbatim rather than ` +
        'reconciling the two by hand, because a drifted absolute is worse than no absolute.',
    );
  }
});

test('the block really is the five rules, not an empty region the markers happen to bracket', () => {
  const canonical = extract(CANONICAL);
  assert.ok(canonical.length > 1500, 'the absolutes block is suspiciously short');
  for (const n of ['1.', '2.', '3.', '4.', '5.']) {
    assert.ok(canonical.includes(`\n${n} `) || canonical.startsWith(`${n} `), `rule ${n} is missing`);
  }
  for (const phrase of [
    'Quote their sentence verbatim',
    'No terminal you did not sit at',
    '`CI` set is an absolute refusal',
    'Never bare `npm run policies:pull`',
    'The push runs in the session holding the operator',
  ]) {
    assert.ok(canonical.includes(phrase), `the absolutes no longer say: ${phrase}`);
  }
});

test('the closed paths stay closed: each red-team finding has its clause', () => {
  // A red-team pass over the skill text enumerated every route to a completed push with no
  // quotable operator request. Each of these is the clause that closed one, and each is the kind
  // of sentence a later tightening-for-brevity edit removes without noticing.
  // Whitespace-normalised: the block is hard-wrapped markdown, so a clause that reads as one
  // sentence spans a newline and two spaces of indent.
  const canonical = extract(CANONICAL).replace(/\s+/g, ' ');
  const clauses = {
    'a push spelled as a module import': 'importing the module',
    // Repaired after the adjacent-ask change: the bare substring 'is not a grant' stayed green
    // while the block was edited to assert BOTH 'IS a grant' and 'is not a grant'. A positive
    // substring pin detects a deletion, never a reversal, so this pins the qualified sentence.
    'a bare affirmative with no ask above it read as a grant':
      'A bare affirmative with no such ask directly above it is not a grant',
    'an ask that was not the last thing in the turn': 'is the last thing in your turn',
    'an ask bundling the push with something else':
      'asks for exactly one action, the push, with nothing else bundled',
    'a statement of intent passed off as an ask': '"unless you object" is not an ask',
    'qualified assent read as a grant':
      'Any condition, exception, addition, correction, question or change of scope',
    'an affirmative paired with a non-adjacent ask':
      'not one you have to reach back through intervening turns to pair with an ask',
    'a pairing constructed by argument': 'if the pairing needs an argument, you do not have one',
    'a compaction or resume supplying the ask half':
      'an ask surviving only as a summary of itself is not a pair',
    'a grant quoted without the ask that carried the naming': 'and your own ask with it',
    'a compaction summary supplying the quote': 'compaction artifact',
    'a parent agent\'s task prompt supplying the quote': "parent agent's task prompt",
    'a real pty argued as not simulated': 'Whether the pty is real is not the question',
    'CI unset for some other reason': 'for any reason at all',
    'a theme pull offered as the way to read a policy': 'A theme pull does not show you a policy body',
    'a subagent authorized by its task text': 'you are never authorized to run it',
    'a re-run after a pre-gate typo treated as a new push': 'is the same authorized push',
  };
  for (const [path, clause] of Object.entries(clauses)) {
    assert.ok(canonical.includes(clause), `the absolutes stopped closing "${path}": lost ${JSON.stringify(clause)}`);
  }
});

test('the block never says a bare affirmative IS a grant without the adjacency qualifier', () => {
  // The one NEGATIVE assertion in this file, and the reason it exists: every other pin here is a
  // positive substring, and the adjacent-ask change proved a positive pin cannot see a reversal.
  // It kept 'is not a grant' and narrowed its subject, so the block asserted both polarities and
  // the suite stayed green through an inversion of the property it guards.
  const canonical = extract(CANONICAL).replace(/\s+/g, ' ');
  const idx = canonical.indexOf('IS a grant');
  if (idx !== -1) {
    const window = canonical.slice(Math.max(0, idx - 400), idx + 400);
    assert.ok(
      window.includes('immediately above it'),
      'the absolutes assert a bare affirmative IS a grant without the adjacency qualifier nearby',
    );
  }
});

test('every copy carries the drift instruction, so a reader who finds two knows what to do', () => {
  const instruction = 'If these ever differ, stop and report the drift; do not pick one.';
  for (const copy of COPIES) {
    assert.ok(readFileSync(copy, 'utf8').includes(instruction), `${copy} does not say what to do on drift`);
  }
});

test('the skill names its own backstop: pushing without having read push.md is itself a violation', () => {
  // The description-based trigger can fail. This line is what still binds when it does, so it has
  // to exist in the always-loaded file AND in the skill.
  const line = 'without having read';
  assert.ok(readFileSync(CANONICAL, 'utf8').includes(line), 'CLAUDE.md lost the read-first backstop');
  assert.ok(readFileSync(COPIES[0], 'utf8').includes(line), 'SKILL.md lost the read-first backstop');
});

test('CLAUDE.md names the always-safe commands, not only the forbidden ones', () => {
  // Knowing only what is forbidden produces both over-caution (refusing to run `policies:check`)
  // and under-caution (treating anything not explicitly forbidden as fine).
  const text = readFileSync(CANONICAL, 'utf8');
  for (const command of ['policies:status', 'policies:check', 'policies:restamp', 'policies:verify']) {
    assert.ok(text.includes(command), `CLAUDE.md does not mention ${command}`);
  }
});

test('the skill files exist and each is reachable from SKILL.md', () => {
  const skillDir = join(REPO_ROOT, '.claude', 'skills', 'shop-policies');
  const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  for (const name of ['change.md', 'push.md', 'verify.md', 'recover.md']) {
    readFileSync(join(skillDir, name), 'utf8');
    assert.ok(skill.includes(name), `SKILL.md never routes to ${name}`);
  }
});

test('every routing row in SKILL.md maps a status label to exactly one destination', () => {
  // A state that maps to "it depends" is a state nobody can act on, and it is why the last five
  // PRs each discovered their situation instead of looking it up.
  const skill = readFileSync(join(REPO_ROOT, '.claude', 'skills', 'shop-policies', 'SKILL.md'), 'utf8');
  const labels = [
    'in sync',
    'unknown: no observation state on this machine',
    'repo edited: restamp, then commit',
    'repo ahead: a push is outstanding',
    'Admin moved: pull and review',
    'CONFLICT: edited locally AND Admin moved',
    'in the observation state but not the manifest',
    'status could not classify this policy',
  ];
  for (const label of labels) {
    assert.ok(skill.includes(label), `SKILL.md's routing table has no row for "${label}"`);
  }
  assert.ok(skill.includes('stop and report'), 'SKILL.md never says what to do when status itself fails');
});

test('the routing table covers every label policies/status.mjs can print', () => {
  // Asserted against the source of truth rather than against a second hand-written list, so a new
  // state cannot be added to the tool and left unrouted in the skill.
  const skill = readFileSync(join(REPO_ROOT, '.claude', 'skills', 'shop-policies', 'SKILL.md'), 'utf8');
  const source = readFileSync(join(REPO_ROOT, 'scripts', 'policies', 'status.mjs'), 'utf8');
  const block = source.slice(source.indexOf('export const STATES'), source.indexOf('});', source.indexOf('export const STATES')));
  const labels = [...block.matchAll(/: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(labels.length >= 8, `only ${labels.length} labels found in status.mjs`);
  for (const label of labels) {
    assert.ok(skill.includes(label), `status.mjs can print "${label}" and SKILL.md does not route it`);
  }
});
