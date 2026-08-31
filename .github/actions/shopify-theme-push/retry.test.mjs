// Unit tests for lib/retry.sh: the shared retry engine, and the three policies that used to be
// three hand-written loops in action.yml.
//
// HOW THESE RUN. Each case spawns a real `bash`, installs a `sleep` stub as a shell function, and
// sources retry.sh into that shell. The stub is a function, so it shadows the `sleep` command that
// `retry_sleep` calls: the test observes the same code path production uses, rather than a parallel
// one. Nothing here ever sleeps for real, and every backoff assertion is made on the arguments the
// stub recorded, never on wall-clock time.
//
// The engine suite runs TWICE: once in a plain shell, and once with the harness spawned as
// `bash -eo pipefail`, which is the composite default shell GitHub injects. The historical
// regression this refactor is most likely to reintroduce is exactly an `errexit` interaction (a
// failed attempt 1 killing the step instead of retrying), and a non-`-e` harness would pass
// straight through it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RETRY_SH = path.join(here, 'lib', 'retry.sh');

/**
 * Run a bash snippet with retry.sh sourced and `sleep` stubbed.
 *
 * REPORTING RUNS FROM AN EXIT TRAP, and that is load-bearing rather than tidy. It is what lets the
 * engine tests call `retry_run` BARE, which is the only way the errexit variant tests anything:
 * bash disables `errexit` for the entire dynamic extent of a function called on the left of `||`,
 * so a harness that writes `retry_run ... || :` runs the non-errexit path twice and reports it as
 * coverage. Deleting the `|| :` guard inside retry.sh's own loop left such a harness fully green.
 * With a bare call, an errexit kill still fires the trap, so the assertions survive the exit they
 * are there to detect. Production calls `retry_run` bare too (it relies on `set +e`), so this is
 * also the shape action.yml actually uses.
 *
 * A body may define a `report` function; the trap calls it, then prints the exit status and the
 * recorded sleeps.
 */
function runShell(body, { errexit = false } = {}) {
  const script = [
    'SLEEPS=()',
    // The stub production actually reaches: retry_sleep calls `sleep` in this same shell.
    'sleep() { SLEEPS+=("$1"); return 0; }',
    '__on_exit() {',
    '  __rc=$?',
    '  if declare -F report >/dev/null 2>&1; then report; fi',
    '  printf "RC=%s\\n" "$__rc"',
    '  printf "SLEEPS=%s\\n" "${SLEEPS[*]-}"',
    '}',
    'trap __on_exit EXIT',
    `source ${JSON.stringify(RETRY_SH)}`,
    body,
  ].join('\n');

  // `-u` as well as `-e`: both callers run `set -uo pipefail`, and under `-u` an unbound expansion
  // is fatal REGARDLESS of `set +e`. It kills the step before any GITHUB_OUTPUT write, which the
  // parent workflow's failure ladder reads as "step never ran" rather than as a failure.
  const args = errexit ? ['-euo', 'pipefail', '-c', script] : ['-c', script];
  // The RETRY_* budgets read `${VAR:-default}`, so an ambient one silently rewrites the caps these
  // tests assert on. Strip them rather than trusting the developer's shell.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('RETRY_'))
  );
  const res = spawnSync('bash', args, {
    cwd: mkdtempSync(path.join(tmpdir(), 'retry-sh-')),
    encoding: 'utf8',
    env: { ...env, GITHUB_ACTION_PATH: here },
  });
  assert.equal(res.error, undefined, `bash failed to spawn: ${res.error}`);
  return {
    stdout: res.stdout,
    stderr: res.stderr,
    status: res.status,
    /** The last `KEY=value` line the snippet printed for `key`. */
    get(key) {
      const matches = res.stdout.split('\n').filter((l) => l.startsWith(`${key}=`));
      assert.ok(matches.length > 0, `no ${key}= line in:\n${res.stdout}\n--- stderr ---\n${res.stderr}`);
      return matches[matches.length - 1].slice(key.length + 1);
    },
  };
}

// Records every hook call in order, so a test can assert what was consulted as well as what was not.
const HOOKS = `
IDX=0
CALLS=()
fake_run() { RETRY_EXIT="\${CODES[$IDX]}"; IDX=$((IDX + 1)); CALLS+=("run:$1"); return 0; }
fake_classify() { CALLS+=("classify:$1:$2"); return "\${CLASSIFY_RC:-0}"; }
fake_before() { CALLS+=("before:$1:$2"); RETRY_DELAY="\${BACKOFF:-5}"; return "\${BEFORE_RC:-0}"; }
report() {
  printf 'EXIT=%s\\n' "$RETRY_EXIT"
  printf 'STOPPED=%s\\n' "$RETRY_STOPPED"
  printf 'CALLS=%s\\n' "\${CALLS[*]-}"
}
`;

// --- the engine, in both a plain shell and an errexit shell ------------------------------------

for (const errexit of [false, true]) {
  const label = errexit ? 'errexit shell' : 'plain shell';

  test(`[${label}] attempts are capped and the final failure propagates non-zero`, () => {
    const r = runShell(
      `${HOOKS}
       CODES=(1 1 1)
       retry_run "t" 3 fake_run fake_classify fake_before`,
      { errexit }
    );
    assert.equal(r.get('RC'), '1', 'retry_run must return the failing code');
    assert.equal(r.get('EXIT'), '1');
    assert.equal(r.get('STOPPED'), '0', 'reaching the cap is not a "stopped" outcome');
    assert.equal(r.get('CALLS'), 'run:1 classify:1:1 before:1:1 run:2 classify:2:1 before:2:1 run:3 classify:3:1');
    assert.equal(r.get('SLEEPS'), '5 5', 'one backoff between each pair of attempts, none after the last');
  });

  test(`[${label}] success breaks early and never classifies`, () => {
    const r = runShell(
      `${HOOKS}
       CODES=(1 0 0)
       retry_run "t" 3 fake_run fake_classify fake_before`,
      { errexit }
    );
    assert.equal(r.get('EXIT'), '0');
    assert.equal(r.get('CALLS'), 'run:1 classify:1:1 before:1:1 run:2');
    assert.equal(r.get('SLEEPS'), '5');
  });

  test(`[${label}] a timeout never consults the classify hook and still retries to the cap`, () => {
    // The rule that is easiest to reverse by accident: "short-circuit" means "skip classification",
    // not "stop retrying". 124 and 137 both mean no answer was received, so nothing can be
    // classified, but the attempt counts normally and takes its usual backoff.
    const r = runShell(
      `${HOOKS}
       CODES=(124 137 1)
       CLASSIFY_RC=1
       retry_run "t" 3 fake_run fake_classify fake_before`,
      { errexit }
    );
    assert.equal(r.get('CALLS'), 'run:1 before:1:124 run:2 before:2:137 run:3 classify:3:1');
    assert.equal(r.get('SLEEPS'), '5 5', 'a timeout takes the usual backoff');
    assert.equal(r.get('EXIT'), '1');
    // Classification was consulted exactly once, on the one attempt that produced an answer, and
    // its `stop` verdict landed there rather than on either timeout.
    assert.equal(r.get('STOPPED'), '1');
  });

  test(`[${label}] a stop classification abandons retries immediately, without sleeping`, () => {
    const r = runShell(
      `${HOOKS}
       CODES=(5 0 0)
       CLASSIFY_RC=1
       retry_run "t" 3 fake_run fake_classify fake_before`,
      { errexit }
    );
    assert.equal(r.get('RC'), '5');
    assert.equal(r.get('STOPPED'), '1');
    assert.equal(r.get('CALLS'), 'run:1 classify:1:5', 'the before-retry hook must not run');
    assert.equal(r.get('SLEEPS'), '', 'a permanent answer must not sleep out the backoff first');
  });

  test(`[${label}] a before-retry hook can abandon the retries too`, () => {
    const r = runShell(
      `${HOOKS}
       CODES=(97 0 0)
       BEFORE_RC=1
       retry_run "t" 3 fake_run fake_classify fake_before`,
      { errexit }
    );
    assert.equal(r.get('EXIT'), '97');
    assert.equal(r.get('STOPPED'), '1');
    assert.equal(r.get('CALLS'), 'run:1 classify:1:97 before:1:97');
    assert.equal(r.get('SLEEPS'), '');
  });

  test(`[${label}] the sleep sequence is exactly what the backoff hook asked for`, () => {
    const r = runShell(
      `${HOOKS}
       CODES=(1 1 1 1)
       fake_before() { CALLS+=("before:$1:$2"); RETRY_DELAY=$(( $1 * 10 )); return 0; }
       retry_run "t" 4 fake_run fake_classify fake_before`,
      { errexit }
    );
    assert.equal(r.get('SLEEPS'), '10 20 30');
  });

  test(`[${label}] a zero backoff sleeps not at all`, () => {
    const r = runShell(
      `${HOOKS}
       CODES=(1 1)
       BACKOFF=0
       retry_run "t" 2 fake_run fake_classify fake_before`,
      { errexit }
    );
    assert.equal(r.get('SLEEPS'), '', 'retry_sleep 0 must not call sleep at all');
  });
}

// The one case that only means anything under errexit: a run hook whose last command is a failure.
// Without the engine's `|| :` the shell exits here, on attempt 1, and the loop never runs again.
// That is the historical regression, verbatim.
test('[errexit shell] a run hook ending on a non-zero command does not kill the loop', () => {
  const r = runShell(
    `${HOOKS}
     CODES=(1 1 0)
     fake_run() { RETRY_EXIT="\${CODES[$IDX]}"; IDX=$((IDX + 1)); CALLS+=("run:$1"); false; }
     retry_run "t" 3 fake_run fake_classify fake_before`,
    { errexit: true }
  );
  assert.equal(r.get('CALLS'), 'run:1 classify:1:1 before:1:1 run:2 classify:2:1 before:2:1 run:3');
  assert.equal(r.get('EXIT'), '0');
});

// --- scrub, the one definition ------------------------------------------------------------------

// Every token prefix scrub() knows, and two lengths around the regex's 16-character minimum.
// Prefix and body are kept APART in this file and joined at runtime: a fixture shaped exactly like
// a real Shopify token is indistinguishable from one to a secret scanner, and this repo is public,
// so a literal here blocks every push to the branch. scrub() sees the joined string either way,
// which is the thing under test.
const TOKEN_PREFIXES = ['shpat', 'shpca', 'shpss', 'shppa', 'shpua', 'shptka'];
const TOKEN_CHARS = 'A1b2C3d4E5f6G7h8i9J0kLmNoPqR';

test('scrub strips ANSI, redacts every token prefix, and neutralises a forged delimiter line', () => {
  const tokens = TOKEN_PREFIXES.map((p, i) => [p, '_', TOKEN_CHARS.slice(0, 16 + i * 2)].join(''));
  const assigns = tokens.map((t, i) => `T${i}=${JSON.stringify(t)}`).join('\n     ');
  const prints = tokens.map((_, i) => `       printf 'token %s\\n' "$T${i}"`).join('\n');

  const r = runShell(
    `${assigns}
     printf 'DELIM=%s\\n' "$RETRY_OUTPUT_DELIM"
     {
       printf '\\033[31mred\\033[0m\\n'
${prints}
       printf '%s\\n' "$RETRY_OUTPUT_DELIM"
       printf 'a line mentioning %s inline\\n' "$RETRY_OUTPUT_DELIM"
     } > raw.txt
     printf 'OUT=%s\\n' "$(scrub < raw.txt | tr '\\n' '|')"`
  );
  const delim = r.get('DELIM');
  assert.match(delim, /^GHEOF_[0-9a-f]{16}$/, 'the delimiter is generated per run, not the fixed GHEOF');
  const redacted = tokens.map(() => 'token [REDACTED]').join('|');
  // The last line matters as much as the forged one: the neutralising sed is ANCHORED, so a line
  // that merely CONTAINS the delimiter must pass through untouched. Widening that anchor would
  // corrupt ordinary output.
  assert.equal(
    r.get('OUT'),
    `red|${redacted}|${delim}.|a line mentioning ${delim} inline|`,
  );
});

test('scrub leaves a token-shaped string that is too short alone', () => {
  // The regex requires 16+ characters after the prefix. A shorter one is not a token, and
  // redacting it would be a silent lie about what was in the output.
  const short = [TOKEN_PREFIXES[0], '_', TOKEN_CHARS.slice(0, 8)].join('');
  const r = runShell(
    `printf '%s\\n' ${JSON.stringify(short)} > raw.txt
     printf 'OUT=%s\\n' "$(scrub < raw.txt)"`
  );
  assert.equal(r.get('OUT'), short);
});

// --- policy: the exit-97 synthesis path ----------------------------------------------------------

test('run_push_attempt synthesises 97 when the CLI exits 0 but assets were rejected', () => {
  const r = runShell(
    `fake_push() { echo '{"theme":{"id":1}}'; return 0; }
     node() { echo "REJECTED templates/index.json"; return 1; }
     run_push_attempt fake_push
     printf 'EXIT=%s\\n' "$RETRY_EXIT"`
  );
  assert.equal(r.get('EXIT'), '97');
  assert.match(r.stdout, /REJECTED templates\/index\.json/, 'the rejection summary is echoed into the log');
});

test('run_push_attempt leaves 0 when the audit itself is inconclusive', () => {
  // Auditor exit 2 means the report was unreadable. That diagnosis belongs to require_json (exit
  // 98); masking it as a rejection would send the deploy down the wrong branch.
  const r = runShell(
    `fake_push() { echo 'not json'; return 0; }
     node() { return 2; }
     run_push_attempt fake_push
     printf 'EXIT=%s\\n' "$RETRY_EXIT"`
  );
  assert.equal(r.get('EXIT'), '0');
  assert.match(r.stdout, /Could not audit this push for rejected assets/);
});

test('run_push_attempt passes the command\'s own failure through untouched, unaudited', () => {
  const r = runShell(
    `fake_push() { return 124; }
     node() { echo "audit ran"; return 1; }
     run_push_attempt fake_push
     printf 'EXIT=%s\\n' "$RETRY_EXIT"`
  );
  assert.equal(r.get('EXIT'), '124');
  assert.doesNotMatch(r.stdout, /audit ran/, 'a failed push has no report worth auditing');
});

test('live mode retries a rejection immediately, with no backoff, and succeeds on the next pass', () => {
  // The ordering case the immediate retry exists for: the schema landed on attempt 1 and the
  // template that depends on it validates on attempt 2.
  const r = runShell(
    `timeout() { shift 2; "$@"; }
     npx() { echo '{"theme":{"id":1}}'; return 0; }
     AUDITS=0
     node() { AUDITS=$((AUDITS + 1)); [ "$AUDITS" -eq 1 ] && { echo "REJECTED"; return 1; }; return 0; }
     retry_run "Live theme push" "$RETRY_LIVE_ATTEMPTS" live_push_run retry_always live_push_before_retry || :
     printf 'EXIT=%s\\n' "$RETRY_EXIT"`
  );
  assert.equal(r.get('EXIT'), '0');
  assert.equal(r.get('SLEEPS'), '', 'a rejection is not weather, so it skips the 60s backoff');
  assert.match(r.stdout, /left rejected assets; retrying immediately/);
});

test('live mode backs off 60s on an ordinary failure and gives up after three attempts', () => {
  const r = runShell(
    `timeout() { shift 2; "$@"; }
     npx() { return 1; }
     retry_run "Live theme push" "$RETRY_LIVE_ATTEMPTS" live_push_run retry_always live_push_before_retry || :
     printf 'EXIT=%s\\n' "$RETRY_EXIT"`
  );
  assert.equal(r.get('EXIT'), '1');
  assert.equal(r.get('SLEEPS'), '60 60');
});

// --- policy: the `theme list` transient-only classifier --------------------------------------------

const LIST_HARNESS = `
     timeout() { shift 2; "$@"; }
     npx() { printf '%s\\n' "$STDERR_TEXT" >&2; return "\${LIST_RC:-1}"; }
     run_list() {
       retry_run "theme list" "$RETRY_LIST_ATTEMPTS" \\
         list_attempt_run list_attempt_classify list_attempt_before_retry || :
       printf 'EXIT=%s\\n' "$RETRY_EXIT"
       printf 'STOPPED=%s\\n' "$RETRY_STOPPED"
     }
`;

test('theme list stops on an auth answer without sleeping out the backoff', () => {
  const r = runShell(`${LIST_HARNESS}
     STDERR_TEXT="Request failed with HTTP 401 Unauthorized"
     run_list`);
  assert.equal(r.get('STOPPED'), '1');
  assert.equal(r.get('SLEEPS'), '', 'a rotated token must be reported now, not in 30 seconds');
  assert.match(r.stdout, /non-transient error .* not retrying/);
});

test('theme list stops on the spacing Shopify actually uses ("not authorized")', () => {
  // `unauthoriz` does not match `not authorized`, so the real permanent failures were the ones
  // being retried before this pattern was anchored.
  const r = runShell(`${LIST_HARNESS}
     STDERR_TEXT="You are not authorized to edit themes on this shop."
     run_list`);
  assert.equal(r.get('STOPPED'), '1');
  assert.equal(r.get('SLEEPS'), '');
});

// Negative controls on RETRY_LIST_AUTH_PATTERN. Each of these is a plausible CLI stderr line that
// an over-eager pattern reads as a permanent auth answer, abandoning the retry on exactly the
// transient the retry exists for. The first three were verified to match the pre-hardening pattern:
// a bare `scope` alternative matches ordinary prose, and a status-anchored code with no trailing
// boundary matches the `403`/`401` inside a four-digit number.
for (const [label, text] of [
  ['a bare duration', 'Done in 4031ms, then the socket hung up'],
  ['a duration after "Error:"', 'Error: 4031ms elapsed before the socket responded'],
  ['a byte count after "error"', 'error 4030 bytes read, connection reset'],
  ['"scope" used in prose', 'The scope of this deploy is large; uploading 401 files'],
  ['a retryable gateway error', '502 Bad Gateway'],
  ['a plain timeout note', 'socket hang up after 40100 ms'],
]) {
  test(`theme list treats ${label} as weather, not as an auth answer`, () => {
    const r = runShell(`${LIST_HARNESS}
       STDERR_TEXT=${JSON.stringify(text)}
       run_list`);
    assert.equal(r.get('STOPPED'), '0', `must not stop on: ${text}`);
    assert.equal(r.get('SLEEPS'), '10 20', 'linear backoff, three attempts');
    assert.equal(r.get('EXIT'), '1');
  });
}

// Positive controls, so tightening the pattern cannot quietly stop matching the real thing. Only
// two of the twelve alternatives had coverage before.
for (const [label, text] of [
  ['an HTTP 403', 'Request failed: HTTP 403 while listing themes'],
  ['a forbidden answer', '403 Forbidden'],
  ['access denied', 'Access denied for this store'],
  ['an invalid token', 'invalid token supplied'],
  ['an expired token', 'The token you supplied has expired.'],
  ['a missing theme', 'theme not found for this shop'],
  ['a missing scope', 'Missing required scope: write_themes'],
  ['a scope reported as denied', 'scope write_themes denied for this app'],
]) {
  test(`theme list stops on ${label}`, () => {
    const r = runShell(`${LIST_HARNESS}
       STDERR_TEXT=${JSON.stringify(text)}
       run_list`);
    assert.equal(r.get('STOPPED'), '1', `must stop on: ${text}`);
    assert.equal(r.get('SLEEPS'), '', 'a permanent answer is reported now, not after the backoff');
  });
}

test('theme list stops when any line of a multi-line stderr answers "auth"', () => {
  // Deliberate bias, worth pinning: a rotated token will not un-rotate on attempt 2, so one
  // auth line stops the retry even alongside transient-looking noise.
  const r = runShell(`${LIST_HARNESS}
     STDERR_TEXT="warning: retrying upstream
502 Bad Gateway
Access denied for this store"
     run_list`);
  assert.equal(r.get('STOPPED'), '1');
  assert.equal(r.get('SLEEPS'), '');
});

test('theme list retries a plain transient with the linear backoff', () => {
  const r = runShell(`${LIST_HARNESS}
     STDERR_TEXT="502 Bad Gateway"
     run_list`);
  assert.equal(r.get('STOPPED'), '0');
  assert.equal(r.get('SLEEPS'), '10 20');
});

test('theme list never classifies a timeout, even when the partial stderr looks like an auth answer', () => {
  // The reason the timeout short-circuit exists: a fragment of partial output must not be
  // pattern-matched as an answer that was never received.
  const r = runShell(`${LIST_HARNESS}
     STDERR_TEXT="not authorized"
     LIST_RC=124
     run_list`);
  assert.equal(r.get('STOPPED'), '0', 'no answer was received, so nothing can have been classified');
  assert.equal(r.get('SLEEPS'), '10 20');
  assert.equal(r.get('EXIT'), '124');
});

test('theme list succeeds on a retry after one transient', () => {
  const r = runShell(`${LIST_HARNESS}
     ATTEMPT=0
     npx() { ATTEMPT=$((ATTEMPT + 1)); [ "$ATTEMPT" -eq 1 ] && { echo "503" >&2; return 1; }; return 0; }
     run_list`);
  assert.equal(r.get('EXIT'), '0');
  assert.equal(r.get('SLEEPS'), '10');
});

// --- policy: the preview theme-ID re-resolution ----------------------------------------------------

test('preview re-resolves the theme ID from a fresh theme list before retrying', () => {
  // A create attempt that died mid-flight may still have registered the theme. Without this, the
  // retry would repeat `--unpublished` and mint a duplicate pr-N-preview.
  const r = runShell(
    `TARGET_ID=""
     THEME_NAME="pr-140-preview"
     timeout() { shift 2; "$@"; }
     npx() { return 0; }
     jq() { echo 987654321; }
     preview_push_before_retry 1 1
     printf 'FN_RC=%s\\n' "$?"
     printf 'TARGET_ID=%s\\n' "$TARGET_ID"
     printf 'DELAY=%s\\n' "$RETRY_DELAY"`
  );
  assert.equal(r.get('FN_RC'), '0');
  assert.equal(r.get('TARGET_ID'), '987654321');
  assert.equal(r.get('DELAY'), '30');
});

test('preview does not re-resolve when the theme ID is already known', () => {
  const r = runShell(
    `TARGET_ID="111"
     THEME_NAME="pr-140-preview"
     timeout() { echo "LIST RAN"; return 0; }
     preview_push_before_retry 1 1
     printf 'TARGET_ID=%s\\n' "$TARGET_ID"`
  );
  assert.equal(r.get('TARGET_ID'), '111');
  assert.doesNotMatch(r.stdout, /LIST RAN/);
});

test('preview stops rather than retry a rejection with no theme ID resolved', () => {
  // The branch that keeps a second `--unpublished` from creating a duplicate theme, which the
  // duplicate-name guard in action.yml then refuses on every later run.
  const r = runShell(
    `TARGET_ID=""
     THEME_NAME="pr-140-preview"
     timeout() { return 1; }
     preview_push_before_retry 1 97
     printf 'FN_RC=%s\\n' "$?"`
  );
  assert.equal(r.get('FN_RC'), '1', 'a non-zero return abandons the retries');
  assert.match(r.stdout, /no theme ID could be resolved; not retrying/);
});

test('preview retries a rejection immediately once an ID is known', () => {
  const r = runShell(
    `TARGET_ID="222"
     THEME_NAME="pr-140-preview"
     preview_push_before_retry 1 97
     printf 'FN_RC=%s\\n' "$?"
     printf 'DELAY=%s\\n' "$RETRY_DELAY"`
  );
  assert.equal(r.get('FN_RC'), '0');
  assert.equal(r.get('DELAY'), '0', 'a rejection skips the 30s backoff');
});

test('preview addresses a known theme by ID and never repeats --unpublished', () => {
  const r = runShell(
    `TARGET_ID=""
     THEME_NAME="pr-140-preview"
     timeout() { shift 2; "$@"; }
     # Logged to a file, not to stdout or stderr: run_push_attempt redirects both of those into
     # push.json / push.err, which is the whole point of the require_json guard.
     npx() { printf 'NPX %s\\n' "$*" >> npx.log; return 1; }
     jq() { echo 333; }
     retry_run "Preview theme push" "$RETRY_PREVIEW_ATTEMPTS" \\
       preview_push_run retry_always preview_push_before_retry || :
     printf 'EXIT=%s\\n' "$RETRY_EXIT"
     sed 's/^/LOG /' npx.log`
  );
  assert.equal(r.get('EXIT'), '1');
  assert.equal(r.get('SLEEPS'), '30');
  const npxCalls = r.stdout.split('\n').filter((l) => l.startsWith('LOG NPX '));
  assert.equal(npxCalls.length, 2, `expected two push attempts, got:\n${r.stdout}`);
  assert.match(npxCalls[0], /--unpublished --theme pr-140-preview/);
  assert.match(npxCalls[1], /--theme 333/);
  assert.doesNotMatch(npxCalls[1], /--unpublished/, 'a second create would duplicate the theme');
});
