#!/usr/bin/env bash
# One retry engine, three named policies, for the Shopify CLI calls in action.yml.
#
# WHY A SOURCED FILE. Composite steps do not share shell state, so the List and Push steps cannot
# see each other's functions. A file is the only way both get the same code. This is not a new
# loading mechanism on the deploy path: `run_push_attempt` already shells out to
# `${GITHUB_ACTION_PATH}/check-push-rejections.mjs`, and the smoke step to `smoke.mjs`.
#
# WHY THE POLICIES LIVE HERE TOO, rather than inline in action.yml. The engine is the boring part.
# What actually breaks production is exit-97 handling, preview theme-ID re-resolution and the
# transient-only stderr filter, and those are only unit-testable if they are functions in a file
# that a test can source. Leaving them inline would have tested the generic loop while the three
# behaviours that matter stayed uncovered. `retry.test.mjs` covers both halves.
#
# RULES BAKED IN, each already the cause of a regression in this repo:
#
#   A timeout retries; it does not stop. Exit 124 (or 137, after `--kill-after`'s SIGKILL) means no
#   answer was received, so no answer can have been classified: the classify hook is skipped
#   entirely, and the attempt counts normally toward the cap with its usual backoff. A fragment of
#   partial output must never be pattern-matched as an answer. "Short-circuit" here means "skip
#   classification", NOT "stop retrying"; the opposite reading would silently reverse the widening
#   this whole change is about.
#
#   No `cmd || retry`. Every attempt's exit code is captured explicitly into a variable.
#
#   This file never runs `set -e` and never relies on it. Sourcing does not change shell options, so
#   the callers' `set +e` stays load-bearing and keeps its comment. The composite default shell is
#   `bash --noprofile --norc -e -o pipefail`, and an injected `-e` kills a step on attempt 1, before
#   any capture or retry can run.
#
#   `RETRY_EXIT` carries the last attempt's code out. Every call site still ends by propagating it
#   (`exit "$EXIT_CODE"`), unchanged.

# The GITHUB_OUTPUT multiline delimiter, generated per run. `scrub` already neutralises a line that
# forges it, so this is defence in depth rather than a hole being closed: server-sourced text would
# have to guess 16 random hex digits before the neutralisation it also has to get past.
RETRY_OUTPUT_DELIM="GHEOF_$(od -An -N 8 -t x1 /dev/urandom | tr -d ' \n')"

# ANSI-strip, redact tokens, and neutralise any line that is exactly the heredoc delimiter, so
# server-sourced text can never close the block early and forge additional step outputs.
#
# ONE definition, deliberately. There used to be two: the Push step's, and the List step's copy,
# which had drifted and lacked the delimiter neutralisation. Every stderr sink in action.yml routes
# through this: `push.err` and `push.json` via `capture_push_output`, `list.err` on both the
# stop-early and exhausted paths, and `require_json`'s dump of a non-JSON report.
scrub() {
  sed 's/\x1b\[[0-9;]*m//g' \
    | sed -E 's/(shpat|shpca|shpss|shppa|shpua|shptka)_[A-Za-z0-9]{16,}/[REDACTED]/g' \
    | sed "s/^${RETRY_OUTPUT_DELIM}\$/${RETRY_OUTPUT_DELIM}./"
}

# Sleep, through one indirection so a test can stub it. Called in the SAME shell as the loop (never
# a subshell or `bash -c`), so the stub the test installs is the same mechanism production uses
# rather than a parallel path.
retry_sleep() {
  local seconds="${1:-0}"
  if [ "$seconds" -gt 0 ]; then
    sleep "$seconds"
  fi
  return 0
}

# True when an exit code means "no answer was received" rather than "the server answered".
retry_is_timeout() {
  [ "$1" -eq 124 ] || [ "$1" -eq 137 ]
}

# A classify hook that never stops. Used where nothing the command can return is a permanent answer.
retry_always() {
  return 0
}

# retry_run <label> <attempts> <run_fn> <classify_fn> <before_retry_fn>
#
#   run_fn <attempt>            runs one attempt and MUST set RETRY_EXIT.
#   classify_fn <attempt> <exit>  returns 0 to keep retrying, non-zero to stop now. NOT called for a
#                                 timeout (see the rule above). Owns its own "not retrying" message.
#   before_retry_fn <attempt> <exit>  runs between attempts, in this shell, so it can mutate state
#                                 (the preview theme-ID re-resolution does). Sets RETRY_DELAY to the
#                                 backoff seconds and returns 0, or returns non-zero to abandon.
#
# Sets RETRY_EXIT (last attempt's code), RETRY_LABEL and RETRY_ATTEMPTS (readable by the hooks for
# their log lines), and RETRY_STOPPED (1 when a hook abandoned the retries, 0 when the cap was
# reached or the command succeeded). Returns RETRY_EXIT, so a caller can branch on the call itself.
retry_run() {
  local label="$1" attempts="$2" run_fn="$3" classify_fn="$4" before_fn="$5"
  local i

  RETRY_LABEL="$label"
  RETRY_ATTEMPTS="$attempts"
  RETRY_STOPPED=0
  RETRY_EXIT=1

  for ((i = 1; i <= attempts; i++)); do
    # `|| :` so an `errexit` inherited from the composite default shell cannot
    # kill the step on a hook that happens to end on a non-zero command. This is
    # not `cmd || retry`: the attempt's real code is RETRY_EXIT, which the hook
    # captures explicitly, never `$?` from here.
    "$run_fn" "$i" || :

    if [ "$RETRY_EXIT" -eq 0 ]; then
      return 0
    fi

    if ! retry_is_timeout "$RETRY_EXIT"; then
      if ! "$classify_fn" "$i" "$RETRY_EXIT"; then
        RETRY_STOPPED=1
        return "$RETRY_EXIT"
      fi
    fi

    if [ "$i" -ge "$attempts" ]; then
      break
    fi

    RETRY_DELAY=0
    if ! "$before_fn" "$i" "$RETRY_EXIT"; then
      # shellcheck disable=SC2034  # RETRY_STOPPED is read by the caller in action.yml, not here.
      RETRY_STOPPED=1
      return "$RETRY_EXIT"
    fi
    retry_sleep "$RETRY_DELAY"
  done

  return "$RETRY_EXIT"
}

# ---------------------------------------------------------------------------------------------
# Policy: `theme list` (pre-push, both modes)
# ---------------------------------------------------------------------------------------------

# Every RETRY_* budget below takes its value from the environment when one is set. That seam exists
# so the unit tests can shrink a cap; it is NOT a supported knob. Nothing in action.yml or the
# workflows sets one, and a job- or workflow-level `env:` with one of these names would change live
# deploy behaviour with nothing in action.yml mentioning it.
#
# A read-only GET, so retrying is idempotent by construction. Three attempts, because a transient
# 5xx or a hung connection here fails the whole deploy before the push is even attempted.
RETRY_LIST_ATTEMPTS="${RETRY_LIST_ATTEMPTS:-3}"
# Per-attempt wall-clock bound: a hung CLI must not eat the job's 15-minute budget. `timeout` is
# coreutils, present on the Linux runners this action runs on.
RETRY_LIST_TIMEOUT="${RETRY_LIST_TIMEOUT:-60s}"

# The transient-only filter. Every version of this that looks obvious is wrong in one of two
# directions, and both directions have bitten:
#
#   TOO LOOSE. Bare digit alternatives (`401|403`) match durations and byte counts, so
#   `Timed out after 401ms` reads as an auth failure and abandons the retry on exactly the transient
#   the retry exists for. Anchoring the codes to a status word is necessary but NOT sufficient: the
#   code also needs a trailing non-digit, or `Error: 4031ms elapsed` and `error 4030 bytes read`
#   both still match on the `403` inside a four-digit number. And a bare `scope` alternative matches
#   ordinary prose, e.g. `The scope of this deploy is large; uploading 401 files`, so it is
#   contextual now: some word about the scope being missing or required has to be near it.
#
#   TOO TIGHT. `unauthoriz` does not match `not authorized`, the spacing Shopify actually uses, so
#   the real permanent failures were the ones being retried.
#
# Matched case-insensitively against the whole of `list.err`, so any line answering "auth" stops the
# retry even when other lines look transient. That is the intended bias: a rotated token is not
# going to un-rotate on attempt 2.
RETRY_LIST_AUTH_PATTERN='(http|status|error)[^0-9]{0,4}(401|403)([^0-9]|$)|unauthoriz|not authoriz|forbidden|access denied|permission denied|invalid (token|password|api key|credentials)|token[^.]{0,20}expired|(theme|store|shop)[^.]{0,20}(not found|no such)|(missing|required|insufficient|invalid|lacks|needs|not granted)[^.]{0,24}scopes?|scopes?[^.]{0,24}(missing|required|insufficient|denied|not granted)'

list_attempt_run() {
  # Captured in condition context so the capture happens even under an inherited
  # `errexit`, which would otherwise end the step on the failing command itself,
  # before any code reached RETRY_EXIT.
  if timeout --kill-after=10s "$RETRY_LIST_TIMEOUT" npx shopify theme list --json > themes.json 2> list.err; then
    RETRY_EXIT=0
  else
    RETRY_EXIT=$?
  fi
}

# An auth or permission answer is not weather. Sleeping out the full backoff before reporting a
# rotated token helps nobody, so it stops immediately.
list_attempt_classify() {
  local attempt="$1" code="$2"
  if grep -qiE "$RETRY_LIST_AUTH_PATTERN" list.err; then
    echo "::error::theme list failed with a non-transient error (exit ${code}) after ${attempt} attempt(s); not retrying."
    return 1
  fi
  return 0
}

list_attempt_before_retry() {
  local attempt="$1" code="$2"
  RETRY_DELAY=$((attempt * 10))
  echo "::warning::theme list attempt ${attempt}/${RETRY_ATTEMPTS} failed (exit ${code}); retrying in ${RETRY_DELAY}s"
  return 0
}

# ---------------------------------------------------------------------------------------------
# Policy: `theme push` (live and preview)
# ---------------------------------------------------------------------------------------------

RETRY_LIVE_ATTEMPTS="${RETRY_LIVE_ATTEMPTS:-3}"
# 8-minute attempt limit + 10s SIGKILL grace.
#
# BUDGET WARNING, because the obvious reading of this is wrong. `timeout-minutes` on the calling job
# does NOT bound this loop to a safe stopping point; it CANCELS the job. 3 x 8m plus 2 x 60s of
# backoff is 26 minutes against `deploy.yml`'s 15, so a live push that keeps timing out is killed
# mid-upload, with every step after it skipped: no deploy report, no squash merge, no marker, and a
# live theme left half-pushed. Nothing self-heals that, unlike the preview path. The retry caps here
# and the job's `timeout-minutes` are one coupled pair; change either and re-check the other.
RETRY_LIVE_TIMEOUT="${RETRY_LIVE_TIMEOUT:-8m}"

# A preview theme is a draft with no customer exposure, and the preview push runs in `validate.yml`'s
# `deploy-preview` job (`timeout-minutes: 15`), so 2 x 5m is the proportionate version of live's
# 3 x 8m. NOT `preview.yml`, which runs `mode: delete-preview` only and has its own 10-minute cap.
RETRY_PREVIEW_ATTEMPTS="${RETRY_PREVIEW_ATTEMPTS:-2}"
RETRY_PREVIEW_TIMEOUT="${RETRY_PREVIEW_TIMEOUT:-5m}"

# Run one `theme push`, then audit the CLI's own JSON report for assets Shopify refused to store.
#
# WHY: `theme push` exits 0 even when the server rejected individual files. Shopify validates a JSON
# template's settings against the section schema already stored on the theme and refuses the whole
# asset when a value is out of range. The CLI records the per-file failure in its --json payload,
# surfaces the sentence only on the debug/analytics path, and returns normally. That combination
# froze templates/index.json on its last valid version across three consecutive green CI runs, with
# the smoke test green throughout because every probed page still rendered from stale content.
#
# Sets RETRY_EXIT: the pushed command's own code, or 97 when the command exited 0 but the audit
# found rejected assets. The auditor's own code is local to this function (0 clean, 1 rejected, 2
# report unparseable); no caller branches on it, they branch on RETRY_EXIT.
run_push_attempt() {
  local check_rc
  rm -f rejections.txt
  # Both captures are in condition context, so they survive an inherited
  # `errexit` (see list_attempt_run).
  if "$@" > push.json 2> push.err; then
    RETRY_EXIT=0
  else
    RETRY_EXIT=$?
  fi
  if [ "$RETRY_EXIT" -eq 0 ]; then
    if node "${GITHUB_ACTION_PATH}/check-push-rejections.mjs" push.json > rejections.txt 2>&1; then
      check_rc=0
    else
      check_rc=$?
    fi
    if [ -s rejections.txt ]; then
      # Through scrub(): this is server-sourced text going to the run log, and it was the last
      # sink in this file still dumping it raw. GitHub masks the literal secret, but scrub's job
      # is the transformed or partial token the masker does not catch.
      scrub < rejections.txt
    fi
    if [ "$check_rc" -eq 1 ]; then
      RETRY_EXIT=97
    elif [ "$check_rc" -eq 2 ]; then
      # The report could not be parsed, so the audit is inconclusive: leave RETRY_EXIT at 0 and let
      # require_json own that diagnosis (exit 98) rather than masking a contract break as a
      # rejection.
      echo "::warning::Could not audit this push for rejected assets; the CLI's JSON report was unreadable."
    fi
  fi
}

# --- live ---------------------------------------------------------------------------------------

live_push_run() {
  local attempt="$1"
  echo "::group::${RETRY_LABEL} attempt ${attempt}/${RETRY_ATTEMPTS}"
  run_push_attempt timeout --kill-after=10s "$RETRY_LIVE_TIMEOUT" npx shopify theme push --live --allow-live --json
  echo "::endgroup::"
}

live_push_before_retry() {
  local attempt="$1" code="$2"
  if [ "$code" -eq 97 ]; then
    # Rejected assets are not a transient network condition, so skip the 60s backoff. The retry is
    # worth one immediate pass because of the ordering case: a schema change and a JSON template
    # that depends on it fail when uploaded together (the template is validated against the schema
    # version already stored on the theme, not the one in the same batch). The schema landed in this
    # attempt, so the template validates on the next one. A value that is genuinely out of range
    # still fails every attempt and stops the deploy.
    echo "::warning::Push attempt ${attempt} left rejected assets; retrying immediately"
    RETRY_DELAY=0
    return 0
  fi
  echo "::warning::Push attempt ${attempt} failed (exit ${code}); retrying in 60s"
  RETRY_DELAY=60
  return 0
}

# --- preview ------------------------------------------------------------------------------------

# Reads and writes TARGET_ID and THEME_NAME from the caller's shell, which is why the engine calls
# these hooks in-shell rather than through a command substitution.
#
# Every attempt after the theme is known is addressed by ID, never by `--unpublished`: repeating the
# create flag would create a SECOND pr-N-preview theme, which the duplicate-name guard in action.yml
# then refuses on every later run. A create attempt that dies mid-flight may still have created the
# theme, so the ID is re-resolved from the push report here, and failing that from a fresh
# `theme list` in the before-retry hook.
preview_push_run() {
  local attempt="$1"
  echo "::group::${RETRY_LABEL} attempt ${attempt}/${RETRY_ATTEMPTS}"
  if [ -n "$TARGET_ID" ]; then
    run_push_attempt timeout --kill-after=10s "$RETRY_PREVIEW_TIMEOUT" npx shopify theme push --theme "$TARGET_ID" --json
  else
    # `--unpublished --theme <name>` creates a new unpublished theme with the given name in one
    # non-interactive step. The earlier two-step pattern (`--unpublished` then `theme rename`) fails
    # in CI because plain `--unpublished` prompts for a name, and the prompt aborts under
    # SHOPIFY_CLI_TTY=0.
    echo "Creating new unpublished theme: ${THEME_NAME}"
    run_push_attempt timeout --kill-after=10s "$RETRY_PREVIEW_TIMEOUT" npx shopify theme push --unpublished --theme "$THEME_NAME" --json
  fi
  echo "::endgroup::"
  if [ -z "$TARGET_ID" ]; then
    TARGET_ID=$(jq -r '.theme.id // empty' push.json 2>/dev/null) || TARGET_ID=""
  fi
  return 0
}

# The "no ID resolved, do not retry" branch lives HERE and not in a classify hook, because it can
# only be decided after the `theme list` re-resolution below has had its turn. Ordering, not taste.
preview_push_before_retry() {
  local attempt="$1" code="$2"

  if [ -z "$TARGET_ID" ]; then
    # Re-resolve by name: the failed create may have got far enough to register the theme, and a
    # second `--unpublished` would duplicate it. Bounded by the same per-attempt timeout as the push
    # itself; before this it was the one unbounded CLI call on the preview path.
    # RETRY_LIST_TIMEOUT, not RETRY_PREVIEW_TIMEOUT: this is a `theme list`, and the list policy
    # already decided 60s is the right bound for one. Borrowing the push's 5m gave the same call an
    # 8x looser bound here than 30 lines up, on a job that has already spent time on both.
    if timeout --kill-after=10s "$RETRY_LIST_TIMEOUT" npx shopify theme list --json > themes-retry.json 2>/dev/null; then
      TARGET_ID=$(jq -r --arg n "$THEME_NAME" '[.[] | select(.name==$n)][0].id // empty' themes-retry.json 2>/dev/null) || TARGET_ID=""
    fi
  fi

  if [ "$code" -eq 97 ]; then
    # Same ordering case as live mode: the schema landed this attempt, so the template that depends
    # on it validates on the next one. No backoff, because a rejection is not weather.
    if [ -z "$TARGET_ID" ]; then
      echo "::warning::Push left rejected assets and no theme ID could be resolved; not retrying."
      return 1
    fi
    echo "::warning::Push attempt ${attempt} left rejected assets; retrying immediately against theme ${TARGET_ID}"
    RETRY_DELAY=0
    return 0
  fi

  echo "::warning::Preview push attempt ${attempt} failed (exit ${code}); retrying in 30s"
  RETRY_DELAY=30
  return 0
}
