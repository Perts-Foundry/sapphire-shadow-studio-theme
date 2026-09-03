# Watching the Flow run list (read-only)

An operator diagnostic for mechanic 5: the Flow amplifies, and when it is behind, the run list is
where that is visible. It reports three numbers and offers no verdict.

The browser is the chrome-devtools MCP, opt-in per the repo's CLAUDE.md. **The opt-in ask is one
operator turn on its own**, and it covers one run: a previous run's permission is not this run's.

## What this may never do

These are absolutes, not preferences. Each one is what keeps a read-only diagnostic from turning
into a second, unaudited write path or a second source of truth about the store.

- **Never click anything in Flow**, and never edit, enable, disable, duplicate or re-run the
  workflow. Navigation and reading only.
- **Never navigate away from the Flow run-list page during the gated turn**, and never open an
  inventory-editing Admin surface (a product, a variant, the inventory page) while it is open.
- **Never let a reading gate a write.** Nothing in `scripts/` imports the parser, no command runs the
  probe, and the batch gate inside `apply` waits on the **store**, never on this. A quiet run list is
  an operator diagnostic and never permission to apply. If a reading and `verify` disagree, `verify`
  is the answer.
- **Never invoke it from the CLI.** `blank-inventory.mjs` stays headless and CI-runnable.
- **Never write page contents into the repo**, and **never commit probe output of any kind**: counts,
  run ids and timestamps from the live store are operational data, and this repo is public. That
  includes an "illustrative example" in this file, in a README, or in a commit message. Only the
  synthetic inputs in `scripts/blank-inventory/test/flow-runs.test.mjs` are committable.
- **Never wait a fixed interval.** No `sleep` (the harness blocks it in the foreground) and no spin
  loop. Read the console and compare it against what you expect; if the reading is not there yet,
  read once more. A second miss on the same expectation is a browser failure, so report it and stop.

## Preconditions

- **The first navigation must land on the Flow run list.** If it lands on `accounts.shopify.com`,
  that is the login loop the repo's CLAUDE.md describes under Browser testing: point the operator at
  the manual-login workaround (relaunch the same Chrome binary with the same `--user-data-dir` and no
  automation flags, log in, close it) and **stop the run**. Do not retry the navigation.
- If the first navigation lands anywhere else at all, stop and report the URL rather than hunting for
  the page.

## The probe

`scripts/blank-inventory/browser/flow-runs-probe.js`, passed **verbatim** as the `initScript` of a
`navigate_page` call. Read the file and pass its whole text; do not paraphrase it, and do not inline
a shortened version.

It wraps `fetch` and `XMLHttpRequest` before any page script runs and logs only:

| Line | Meaning |
|---|---|
| `SSSFLOWPAGE <n>` | a matching response held `<n>` run nodes |
| `SSSFLOWRUN <runId> <status> <true\|false> <startedAt>` | one run; the boolean is whether it is retrying |
| `SSSFLOWNONE <op,op,...>` | nothing matched, and these are the GraphQL operation names seen instead |

It writes nothing to the DOM, but it is **not inert**: it replaces `window.fetch` and patches
`XMLHttpRequest.prototype.open`/`send` for the life of the page, once (a second install is a no-op),
exactly as `scripts/notifications/browser/editor-probe.js` does.

## Reading the output

**Parse it, never eyeball it.** Take the console with `list_console_messages` and feed it to
`parseFlowRuns` in `scripts/blank-inventory/lib/flow-runs.mjs`; the dedupe, the status
classification and the malformed-line handling live there and are tested there. Console output over
roughly 50 KB is persisted to a file whose path is in the tool result: feed that file to the parser
rather than retyping it.

`describeFlowRuns` renders the three-line reading. It deliberately offers no "safe to proceed"
conclusion, and neither should the report built from it.

Three readings that are not the same thing, and the difference matters more than the numbers:

- **`SSSFLOWNONE` with no runs** means the probe matched nothing, which is not "the Flow is quiet".
  Admin's Flow surface is unversioned and this probe's URL match and field names are the plausible
  shape rather than an observed one, so this is a designed outcome. Report the operation names the
  line lists, and stop; do not widen the match by guessing.
- **An `UNCLASSIFIED` status** means Admin used a status token the parser does not recognise. Those
  runs are in the total but **not** in the in-progress figure, so the in-progress count is a floor,
  not a measurement. Report the token verbatim. Widening `IN_PROGRESS_STATUSES` is a code change with
  a test, made against a real run list and recording what was seen, never an ad-hoc fix mid-run.
- **Unparseable lines** mean the reading is incomplete. Say so rather than reporting the partial
  counts as if they were the whole picture.

## What a reading is for

One thing: telling the operator whether the Flow is currently behind, so that a decision about when
to run a paced `apply` (or whether to wait) is informed. The signals map onto mechanic 5 directly.
A pile of in-progress runs with retries, and an oldest-in-progress age well past the 80-to-90-second
settle, is the shape both incidents took.

It diagnoses a situation the batch gate now prevents, which is the honest case against building it at
all. It exists because when the gate does halt, the operator is owed a way to see *why* that does not
involve reading the store harder.
