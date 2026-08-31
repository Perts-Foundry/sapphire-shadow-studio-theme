import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractRunBodies } from './composite-shell.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A minimal composite action in the shape of the real ones: a sequence of steps under
// `runs.steps`, each with `name`, `id`, `shell` and a `run: |` block.
function action(steps) {
  return ['runs:', '  using: composite', '  steps:', ...steps].join('\n') + '\n';
}

// --- extraction ----------------------------------------------------------------------------

test('extracts every bash run body in a file', () => {
  const text = action([
    '    - name: First',
    '      id: first',
    '      shell: bash',
    '      run: |',
    '        echo one',
    '',
    '    - name: Second',
    '      shell: bash',
    '      run: |',
    '        echo two',
  ]);
  const { bodies, skipped } = extractRunBodies(text, { source: 'a/action.yml' });
  assert.equal(bodies.length, 2);
  assert.deepEqual(skipped, []);
  assert.deepEqual(bodies.map((b) => b.script), ['echo one', 'echo two']);
  assert.deepEqual(bodies.map((b) => b.stepId), ['first', 'second']);
  assert.deepEqual(bodies.map((b) => b.fileName), [
    'a-action__first.sh',
    'a-action__second.sh',
  ]);
});

test('dedents to the block indent and preserves relative indentation', () => {
  const text = action([
    '    - name: Nested',
    '      shell: bash',
    '      run: |',
    '        if [ -n "$X" ]; then',
    '          echo deep',
    '        fi',
  ]);
  const [body] = extractRunBodies(text, { source: 'a/action.yml' }).bodies;
  assert.equal(body.script, 'if [ -n "$X" ]; then\n  echo deep\nfi');
});

test('blank lines inside a body survive; trailing ones do not', () => {
  const text = action([
    '    - name: Gappy',
    '      shell: bash',
    '      run: |',
    '        echo one',
    '',
    '        echo two',
    '',
    '',
    '    - name: Next',
    '      shell: bash',
    '      run: |',
    '        echo three',
  ]);
  const { bodies } = extractRunBodies(text, { source: 'a/action.yml' });
  assert.equal(bodies[0].script, 'echo one\n\necho two');
  assert.equal(bodies[1].script, 'echo three');
});

test('padding puts each body line at its own action.yml line number', () => {
  const text = action([
    '    - name: Padded',
    '      shell: bash',
    '      run: |',
    '        echo one',
    '        echo two',
  ]);
  const [body] = extractRunBodies(text, { source: 'a/action.yml' }).bodies;
  // `run: |` is line 7 of the document (3 header lines + name + shell + run = 6), so the first
  // body line is line 7. Assert against the source text rather than a hand-counted constant.
  const sourceLines = text.split('\n');
  const paddedLines = body.padded.split('\n');
  assert.equal(sourceLines[body.runLine - 1].trim(), 'run: |');
  assert.equal(paddedLines[body.firstBodyLine - 1], 'echo one');
  assert.equal(paddedLines[body.firstBodyLine], 'echo two');
  // Everything ahead of the body is blank, so shellcheck reports source line numbers.
  assert.equal(paddedLines.slice(0, body.firstBodyLine - 1).join(''), '');
});

// --- guard 1: unsupported `run:` forms ------------------------------------------------------

for (const [label, runLine] of [
  ['strip chomping', '      run: |-'],
  ['keep chomping', '      run: |+'],
  ['indentation indicator', '      run: |2'],
  ['folded scalar', '      run: >'],
  ['trailing comment', '      run: | # inline'],
  ['single line', '      run: npm ci --ignore-scripts'],
  ['quoted single line', '      run: "echo hi"'],
]) {
  test(`unsupported run form raises: ${label}`, () => {
    const text = action(['    - name: Odd', '      shell: bash', runLine, '        echo one']);
    assert.throws(
      () => extractRunBodies(text, { source: 'a/action.yml' }),
      /a\/action\.yml:6: unsupported `run:` form/
    );
  });
}

test('an unsupported form later in the file still raises, after a good body', () => {
  const text = action([
    '    - name: Good',
    '      shell: bash',
    '      run: |',
    '        echo one',
    '    - name: Bad',
    '      shell: bash',
    '      run: echo two',
  ]);
  assert.throws(() => extractRunBodies(text, { source: 'a/action.yml' }), /unsupported `run:` form/);
});

test('a `run:` inside a comment is not a run key', () => {
  const text = action([
    '    - name: Commented',
    '      shell: bash',
    '      # never interpolate into the run: line',
    '      run: |',
    '        echo one',
  ]);
  const { bodies } = extractRunBodies(text, { source: 'a/action.yml' });
  assert.equal(bodies.length, 1);
});

// --- guard 2: zero bodies -------------------------------------------------------------------

test('zero extracted bodies raises', () => {
  const text = action(['    - name: Uses only', '      uses: ./.github/actions/setup-shopify-cli']);
  assert.throws(() => extractRunBodies(text, { source: 'a/action.yml' }), /no bash `run:` bodies/);
});

test('allowEmpty defeats the zero-body guard, for tests only', () => {
  const text = action(['    - name: Uses only', '      uses: ./.github/actions/setup-shopify-cli']);
  const { bodies } = extractRunBodies(text, { source: 'a/action.yml', allowEmpty: true });
  assert.deepEqual(bodies, []);
});

// --- guard 3: surviving `${{ }}` --------------------------------------------------------------

test('a `${{ }}` surviving into a body raises', () => {
  const text = action([
    '    - name: Interpolated',
    '      shell: bash',
    '      run: |',
    '        echo "${{ inputs.mode }}"',
  ]);
  assert.throws(() => extractRunBodies(text, { source: 'a/action.yml' }), /survives into the extracted body/);
});

test('a `${{ }}` in env: does not raise', () => {
  const text = action([
    '    - name: Enveloped',
    '      shell: bash',
    '      env:',
    '        MODE: ${{ inputs.mode }}',
    '      run: |',
    '        echo "$MODE"',
  ]);
  const { bodies } = extractRunBodies(text, { source: 'a/action.yml' });
  assert.equal(bodies[0].script, 'echo "$MODE"');
});

// --- non-bash shells ---------------------------------------------------------------------------

test('a non-bash shell is skipped and reported, not linted', () => {
  const text = action([
    '    - name: Bash one',
    '      shell: bash',
    '      run: |',
    '        echo one',
    '    - name: Python one',
    '      shell: python',
    '      run: |',
    '        print("two")',
  ]);
  const { bodies, skipped } = extractRunBodies(text, { source: 'a/action.yml' });
  assert.deepEqual(bodies.map((b) => b.script), ['echo one']);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].shell, 'python');
  assert.equal(skipped[0].stepId, 'python-one');
});

test('shell: sh is bash-family enough for shellcheck', () => {
  const text = action(['    - name: Posix', '      shell: sh', '      run: |', '        echo one']);
  const { bodies } = extractRunBodies(text, { source: 'a/action.yml' });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].shell, 'sh');
});

// --- the real files ------------------------------------------------------------------------------

// Runs the extractor over the repo's actual composite actions, so drift in those files fails
// `npm run lib:test` rather than first appearing as a red CI row on the step that gates
// auto-deploy. Asserts a non-zero body count for the same reason the CLI prints one: "green" and
// "green having extracted nothing" are indistinguishable from outside.
test('the repo\'s own composite actions extract cleanly', async () => {
  const files = [];
  for await (const f of glob('.github/actions/*/action.yml', { cwd: repoRoot })) files.push(f);
  files.sort();
  assert.ok(files.length >= 2, `expected composite actions, found ${files.length}`);

  let total = 0;
  for (const file of files) {
    const text = await readFile(path.join(repoRoot, file), 'utf8');
    const { bodies } = extractRunBodies(text, { source: file });
    assert.ok(bodies.length > 0, `${file} yielded no run bodies`);
    for (const body of bodies) {
      assert.ok(!body.script.includes('${{'), `${file}:${body.runLine} leaked an expression`);
      assert.ok(body.script.trim().length > 0, `${file}:${body.runLine} extracted an empty body`);
    }
    total += bodies.length;
  }
  assert.ok(total >= 4, `expected at least 4 run bodies across the composite actions, got ${total}`);
});
