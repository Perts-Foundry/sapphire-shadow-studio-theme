# sync

Push the repo's branded templates into Admin, byte-verified before Save and again after reload,
then render-checked on the stored version, with a byte-verified restore of the previous document
if that render fails. One STOP for the whole batch (SKILL.md records the operator's reason). No
git writes here.

`sync [--from <ref>] [--on-render-fail halt|quarantine] [--batch <n>] [--resume] [id ...]`

**One path spelling, throughout.** `<scratch>` is a checkout of `--from`, and every template path
in this file is under it: `<scratch>/marketing/notifications/<id>.liquid`. The working tree is
never the paste source, never the byte-check reference and never where a version is read from. The
plan is classified against `<scratch>`, so anything else means the bytes pasted are not the bytes
approved, and the pre-Save check would compare the editor against the same unapproved file it just
pasted and pass.

1. **Preconditions.** `node scripts/notifications/brand.mjs --check --root <scratch>` passes, where
   `<scratch>` holds `--from` (default `origin/main`; a branch name when `change` handed over):
   `git worktree add <scratch> <ref>`, or
   `git archive <ref> marketing/notifications | tar -x -C <scratch>`. The same `--root` serves
   `--status`, `classify.mjs` and `dump.mjs --hash`. Load the state file
   (`node scripts/notifications/state.mjs --store <store> show`); a refusal ends the run and is
   reported as such. For each `pending` entry, confirm `--status` on `--from` still carries that
   version and the repo file still has that FNV (`node scripts/notifications/dump.mjs --hash`);
   drop stale entries with `pending-remove` and say so.

   **`--resume`** picks up a run recorded in the state file instead of planning a new one:
   `state.mjs --store <store> run-show`, confirm the recorded `sha` still resolves
   (`git rev-parse --verify <ref>^{commit}`, with the run's own `ref` when `--from` is omitted),
   rebuild `<scratch>` at that sha, and continue at `next` under the run's recorded
   `onRenderFail` and `batch`. The recorded approval is the plan approval and nothing more:
   **the browser opt-in is a fresh operator turn on every invocation, `--resume` included**, and
   a positional id list is refused (the run's order is what was approved). A `ref` that no longer
   resolves to the recorded sha refuses and asks for a fresh plan. With no run in flight,
   `--resume` says so and ends. A run that stopped on a failure recorded the failing id in
   `quarantine` before it ended, so nothing resumes onto the template that just failed.

2. **Plan** (browser opt-in ask first, its own turn). Read every id in scope from Admin, one
   navigation each with `editor-probe.js`, and take the whole reading from the **stored** pair:
   `SSSSTORED` for the length, FNV and gid, and `SSSSTOREDSTAMP` for the stamp (`browser.md`, The
   load race). Never `SSSPOLL`/`SSSSTAMP` here, and never a line from a previous navigation: the
   widget can still be painting the stock body, and a stamp read from it reports `none` for a
   stored branded template, which silently downgrades it to `unstamped-edited`. Record the
   readings, one line per id:

   ```
   <id>\t<length>\t<fnv>\t<stamp>\t<gid>
   ```

   `<stamp>` is `<id> <version>` or `none`; `<gid>` is the `SSSSTORED` gid or `-`. Then classify
   them in one pass:

   ```
   node scripts/notifications/classify.mjs --root <scratch> --observed <scratch>/observed.tsv \
     --on-render-fail <policy> [--paste-ahead <id>...] --json <scratch>/plan.json
   ```

   That applies the match table (`classify.mjs` states its rows and their order, and owns them)
   and prints the STOP table. Do not classify by eye and do not hand-roll the join: the enum
   decides which live templates get overwritten, and `test/classify.test.mjs` is what proves the
   table is applied as written.

   **The paste criterion is bytes**: Admin length and FNV differ from the repo file. The version
   column is informational (a `git revert` moves a version backwards by design). `sync` pastes over
   `behind`, `unstamped-stock`, `unstamped-edited`, `hash-mismatch` and `orphan`. `ahead` means
   Admin holds a version above the repo's, so it is flagged and left alone unless the operator
   names that id: pass exactly those ids to `--paste-ahead`, which promotes them to `paste` and
   notes why in the table. If nothing in scope will be pasted, the plan table says so and the run
   ends; `audit` is the mode that render-checks what Admin already holds.

   **STOP** once with the table, plus three things the operator is approving along with it:
   - the count of live saves, which `classify.mjs` prints from the policy: `halt` costs at most one
     restoring Save before the run stops, `quarantine` up to one per pasted id, so the ceiling is
     twice the paste count. Present the line as printed;
   - the **render-failure policy**, `halt` (the default: restore, record, stop the run) or
     `quarantine` (restore, record, carry on). Quarantine is a real relaxation: the run can end
     with some templates branded and others on their previous document, so the customer-facing set
     is temporarily inconsistent. Say that in the STOP rather than burying it. The byte gates are
     **not** relaxed by either policy;
   - the batch cadence, `--batch <n>`: report progress every n ids and keep going. Absent, the run
     reports at the end. A batch report is not a STOP and asks for nothing.

   No per-template stops after this. On approval, record the plan so the run survives a
   compaction, a crash or a new session:

   ```
   node scripts/notifications/state.mjs --store <store> run-start <scratch>/plan.json \
     --ref <--from> --sha <sha> [--on-render-fail quarantine] [--batch <n>]
   ```

3. **Order and per-id loop.** `run-start` records the approved order and `run-show`'s `next` is the
   id to do. Per id, per `browser.md`, and note what is **not** here: no second navigation for a
   dump, no fixed waits, and no snapshot whose only job is to confirm something the next check
   already proves.

   1. Navigate to the editor with `editor-probe.js` as the initScript. Read the console of that
      navigation and require `SSSSTORED` to equal the id's approved `before` numbers from
      `run-show`. A different value means Admin changed since the read pass: do not paste, and go
      to step 3.8.
   2. Materialise the restore source, gated on those same numbers:
      - `beforeSource` `stock`: `node scripts/notifications/before-doc.mjs --from-stock <id>
        --root <scratch> --expect-length <n> --expect-fnv <hex> --out <scratch>/before-<id>.liquid`.
      - `beforeSource` `network`: save the `EmailTemplate` response of the navigation just made
        (`browser.md`, Reading the network), then `before-doc.mjs --from-response <file>
        --expect-gid <the gid from this navigation's SSSSTORED>` with the same `--expect-*` and
        `--out`.
      Either way the file is refused unless it hashes to the approved numbers, and no id is ever
      pasted, or restored, from a "before" that was not in the approved table.
   3. `node scripts/notifications/clipboard.mjs <scratch>/marketing/notifications/<id>.liquid`.
      Fresh snapshot, click the editor, select all, paste.
   4. Read `SSSPOLL`; require the run's approved `after` numbers for this id, and `SSSSTAMP` to
      read `<id> <n>`. Always before Save. Never Save on a mismatch.

      **The bound: at most two paste attempts per id.** Not two per failure kind. A
      `clipboard.mjs` that exits non-zero and an `SSSPOLL` that disagrees are the same budget, and
      a `clipboard.mjs` re-run inside a re-paste is not a fresh allowance. When the two attempts
      are spent, go to step 4.

      Within that, on a mismatch redo step 3.3 once, whole (`clipboard.mjs` on the same
      `<scratch>/marketing/notifications/<id>.liquid`, fresh snapshot, click, select all, paste),
      then read `SSSPOLL` again. Distinguish the two console cases first, because they have
      different owners: a `SSSPOLL` line that is **absent or unchanged** is `browser.md`'s
      read-once-more case (the probe logs only on change, so a paste that did nothing leaves the
      previous line standing); a line **present with the wrong numbers** is this one.

      Why the flaky hop is the clipboard and not the editor: one run halted on
      `pos_exchange_v2_receipt` with `clipboard.mjs` reporting the right file copied and `SSSPOLL`
      reading `338 60a6b193` against an approved `23656 59aa69eb`, and an earlier one pasted a
      U+FEFF byte-order mark, one character too many. Both were caught here, and the first cost the
      remaining 16 ids of the run. `clipboard.mjs` now reads the clipboard back, so most of these
      should fail at the shell before the browser is touched; read its exit code per `browser.md`,
      where exit 0 does **not** always mean verified.

      **This relaxes nothing, and the reason is stronger than "it is before Save".** It is before
      Save, and Save still demands an exact match. But also: the paste criterion is that Admin's
      bytes *differ* from the repo file, so the approved `after` is by construction not the
      document the editor held before the paste. A re-paste that silently does nothing therefore
      leaves the same mismatching reading in place and fails again. Every way this retry can go
      wrong is a false stop; none of them is a false pass. It is not a browser failure and does not
      count against `browser.md`'s failure bound, though a navigation or snapshot that fails while
      doing it still does.

      Count the re-pastes. They go in the batch report and the end-of-run report (step 5): a defect
      that a retry always clears is invisible otherwise, and this is the surface where the U+FEFF
      bug was found precisely because a clipboard defect stopped a run. A rising count is a defect
      to fix in the tool, never tolerance to widen here.
   5. Click "Save" (uid from a fresh snapshot), then reload with `editor-probe.js`, declining any
      leave-page dialog. Require the **reload to have completed** and `SSSSTORED` to equal the
      approved `after` numbers, with `SSSSTAMP`/`SSSPOLL` as corroboration. `SSSSTORED` is the
      check that means anything here: it comes from Admin's own response, so it cannot be
      satisfied by a widget that has held the pasted text all along, which is exactly what a
      cancelled leave-page dialog leaves behind. On the first Save of the run, apply the
      normalisation probe. There is no separate snapshot to confirm the Save button went away: the
      dialog rule and this check both prove the Save landed, and the snapshot proved nothing they
      do not.

      A dialog here means the Save did not complete: cancel it, take a fresh snapshot, click Save
      once more, and reload again. A second dialog ends this id per step 3.8; Admin still holds the
      before-document, so the id is **not attempted**, not unverified.
   6. Click "Preview template with content"; read the preview from the network response;
      `node scripts/notifications/verify-render.mjs --preview-response <file> --id <id>
      --version <n> --root <scratch>`, which takes the manifest and the stylesheet from the same
      checkout the plan was classified against rather than from the working tree. The preview now
      renders the stored version, so this check sees the paste on every id, including the ones
      whose preview ignores unsaved edits. Close the dialog only when the next action is in this
      same editor (a restore, or the mobile procedure): a navigation to the next id discards it.
   7. Render passed: `node scripts/notifications/state.mjs --store <store> seen <id>
      --from-file <scratch>/marketing/notifications/<id>.liquid`, which refuses any file that is
      not the approved `after`, takes the version from the approved row and the sha and ref from
      the run, and advances the run by one. Then, and only here, the mobile procedure per
      `browser.md` from the preview response saved in step 6, when the run pastes a stylesheet
      change (every manifest id bumped, or a first sync) and this is the first template of the run,
      and on each `header`-override template pasted; it never runs between a failed render and the
      restore, and `browser.md`'s viewport restore precedes the next id's step 3.1.

      Render failed: **restore**, attempted once, starting on the editor page as step 6 left it
      with the dialog closed (if anything navigated away, navigate back with `editor-probe.js` and
      confirm `SSSSTORED` equals the approved `after` first). `clipboard.mjs
      <scratch>/before-<id>.liquid`, fresh snapshot, click the editor, select all, paste;
      `SSSPOLL` must equal the approved `before`. One re-paste on a mismatch, exactly as step 3.4
      allows and for the same reason (the same clipboard hop), re-running `clipboard.mjs` on
      `<scratch>/before-<id>.liquid` and not on the branded file. A second mismatch is **this
      step's own failure two paragraphs down, not step 4's**: the dirty-editor bytes to confirm are
      the approved `after`, and the report has to say Admin holds branded version `<n>` and point
      at `rollback`. Step 4's report would send the operator to reconfirm against `before` and
      would omit the rollback pointer, which is wrong on both counts here. Save and reload per step
      3.5; `SSSSTORED` must equal the approved `before` again. Then, under **both** policies:
      `node scripts/notifications/state.mjs --store <store> run-quarantine <id>
      <verifier output file>`, with the verifier output kept verbatim for the end-of-run report.
      Record nothing in `seen`. Then `halt` goes to step 4 and `quarantine` continues at the next
      id.

      Recording the id under `halt` too is not bookkeeping: an id left unsettled is still `next`,
      so a later `--resume` would repaste the template that just failed, under the original
      approval, for as many laps as it is resumed.

      If the restore's own byte check fails, do not Save: discard the dirty editor per `browser.md`
      (the stored bytes to confirm are the approved `after`, from the Save that preceded it), and
      the stop report says that Admin holds branded version `<n>` of the id whose render failed,
      and points at `rollback <id> --from <ref>` with an explicit `--from` of the operator's
      choosing, because `seen` for this id was not written and `rollback`'s default source would be
      wrong. This ends the run under either policy.
   8. **Ending one id short of the loop.** Two cases reach here, and they are different reports.
      A changed `before` at step 3.1 means Admin moved since the plan: nothing was pasted, the
      editor is clean, so re-read the remaining ids, `run-end --reason halt` the approved run, and
      return to step 2's STOP with a fresh table. A new `run-start` refuses while the old run is in
      flight, so end it first; `--force` exists but belongs only immediately after a fresh
      plan-table approval, never as a way past a refusal. Ids already pasted stay recorded in
      `seen`. The Save-dialog case at step 3.5 reports the id as not attempted and ends the run per
      step 4.

   **Cost, an estimate until a run measures it.** The loop was 31 tool calls per id before these
   changes, most of it a redundant dump navigation, four fixed waits and two snapshots that
   confirmed nothing. Counting the steps above it should be about 22 for a `stock`-source id and 24
   for a `network`-source one. The step 3.4 re-paste does not move that **estimate**: it fires only
   on a mismatch, and the clipboard read-back that should make it rare happens inside
   `clipboard.mjs`, in a call the loop already makes. It does of course cost a run in which it
   fires, which is what the re-paste count in the report is for. Quote the current figure and the
   resulting total in the step 2 STOP, so the operator is choosing to spend a known amount rather
   than finding out at the end. Report
   the measured figure at the end of the run and hand it to the operator for a later edit of this
   file; a run makes no git writes, and a guess repeated as a measurement is how the last one went
   wrong.

4. **Failure.** Any failing check stops the run with the id, the failing check and its evidence,
   verbatim, and `state.mjs --store <store> run-end --reason halt` before the report, so nothing
   resumes into a run that stopped. A failed byte check before Save (step 3.4) means never Save;
   discard the dirty editor per `browser.md` (the stored bytes to confirm are the approved
   `before`). A failed byte check after Save (step 3.5, including the normalisation probe) means
   Admin holds bytes nobody verified: do not paste anything further, do not restore (the approval
   covers a restoring Save only after a failed render), stop, and the report gives the post-reload
   numbers verbatim, states that Admin's stored document for the id is unverified, and points at
   `audit <id>` and then `rollback <id> --from <ref>`. A failed render check (step 3.6) is the one
   failure the approved policy governs: both policies restore and quarantine, `halt` then stops the
   run and `quarantine` continues. Nothing else in this file is affected by that flag.
   `browser.md`'s failure bound ending the run inside any step produces the step 4 report. On exit
   the skill still records `seen` for every id that passed step 3.7, prints the partial table, and
   lists the ids not attempted. Do not Revert to default here.

5. **End of run.** Re-run the read pass (`editor-probe.js`, `SSSSTORED`) over the ids in `done` as
   a batch summary, print the final table, and `pending-remove` those ids only: a quarantined id
   still needs syncing, so it keeps its `pending` entry and its place on the backlog. Report the
   quarantine list in full with each verifier output verbatim, in an adaptive fence, and say
   plainly which ids are branded and which are still on their previous document, because a
   quarantined run leaves the set inconsistent on purpose. Then `state.mjs --store <store>
   run-end`. State plainly that `sync` proves Admin holds the bytes, and that the sample-data
   render is what the render check proves.

   Report the re-paste count with those: how many ids needed a second paste attempt at step 3.4 or
   3.7, and which. Zero is worth stating too, because it is what makes a later non-zero mean
   something.

   Report counts against three separate denominators and never mix them: **this batch** (the
   `--batch` window, or the ids the operator last named), **this run** (the ids in `run-show`), and
   **this store** (`seen` overall). Conflating the first two produced a wrong count in front of the
   operator on the run this file was rewritten from.
