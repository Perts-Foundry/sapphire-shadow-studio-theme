# TODO List

Open items only. Delete an item when it is done; never check it off or annotate it. A partly finished item is deleted and its remainder written as a new item.

## Deferred review findings

- **add-product-run-review-1** (test-engineer, 2026-09-08): the bulk-update-fails-after-option-update path has no test, so the exit code, the repair message and the deliberate non-break are unpinned -> add a fake client whose variant setup returns userErrors.
- **add-product-run-review-2** (test-engineer, 2026-09-08): the count-mismatch warning path has no test, so disabling the branch survives the suite -> re-read fixture returning fewer new variants than planned, asserting the warning and that setup still runs.
- **add-product-run-review-3** (test-engineer, 2026-09-08): receipt behaviour is under-asserted, with three surviving mutants -> assert the file is 0600 under a 0700 directory, that a receipt is written even when the run failed partway, and that a dry run writes none.
- **add-product-run-review-4** (test-engineer, 2026-09-08): the dry-run early return is untested on the repair and hero-attach paths, so nothing proves the recovery command writes nothing -> one test per path asserting no client calls and the exact copy line.
- **add-product-run-review-5** (test-engineer, 2026-09-08): the value-already-exists pre-flight only proves it looked at the first product -> fixture where only the second product carries the value.
- **add-product-run-review-6** (test-engineer, 2026-09-08): the repair path never asserts what it sends, so a hardcoded price or one weight applied to every product both survive -> assert the per-product weight and price, plus the two missing-flag refusals and the zero-target skip.
- **add-product-run-review-7** (test-engineer, 2026-09-08): price validation is entirely untested on both the add and repair paths -> cover the missing and non-numeric refusals.
- **add-product-run-review-8** (test-engineer, 2026-09-08): the shared Admin read module has no test file at 65 percent lines, and every completion verdict turns on the fields it normalises -> cover the missing inventory-item case, two-page pagination and the page-cap refusal.
- **add-product-run-review-9** (test-engineer, 2026-09-08): the option-value command derives its scope as "all handles unless one was named", so passing both a namespace and a handle list silently ignores the namespace and the mutual-exclusion refusal is unreachable there -> make it refuse, or test the precedence deliberately.
- **add-product-run-review-10** (test-engineer, 2026-09-08): three assertions pass for the wrong reason, the loosest being a case-insensitive alternation that matches almost any rewording -> pin the specific phrases.
- **add-product-run-review-11** (test-engineer, 2026-09-08): an empty-string CI value passes the gate by truthiness, matching the policy-push precedent, while the standing rule says emptying it is as forbidden as unsetting it -> decide between presence-checking in both places and recording the truthiness choice with a test.
- **add-product-run-review-12** (test-engineer, 2026-09-08): nothing asserts that no workflow invokes the gated option-value command, which is the stated justification for its unconditional CI refusal; the policy-push suite has that guard -> add the equivalent static check.
- **add-product-run-review-13** (code-review, 2026-09-08): the state directory has no guard against being a symlink or resolving outside the expected root -> validate the resolved path before writing.
- **add-product-run-review-14** (code-review, 2026-09-08): a stale temporary file can trip a permission edge case that the policy tooling already fixed once -> port that fix.
- **add-product-run-review-15** (code-review, 2026-09-08): a re-export in the helper libraries is dead -> remove it.
- **add-product-run-review-16** (code-review, 2026-09-08): the CI and terminal gate logic is duplicated between the option-value helper and the policy push -> consider one shared module, weighing that against keeping the two blast radii independent.
- **add-product-run-review-17** (code-review, 2026-09-08): three read-only fetch helpers await sequentially where the reads are independent -> parallelise if the Admin throttle allows.
- **blank-inventory-backfill-dry-run-1** (test-engineer, 2026-09-10): the dry-run backstop reads only a document's first operation keyword, so a fragment-first or multi-operation mutation document would pass it -> add a source scan confining mutation documents to lib/mutations.mjs, and a test pinning the fragment-first behaviour.
- **add-product-run-review-18** (security-review, 2026-09-08): the run renderer sanitises evidence but prints product titles, ids and channel names from the store raw, so terminal-escape forgery is possible in principle -> sanitise the rendered live-store strings for consistency. Not exploitable today: no untrusted party can write those fields on a single-operator store.
