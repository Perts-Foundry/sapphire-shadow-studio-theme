# sync

Push the repo's branded templates into Admin, byte-verified before Save and again after reload,
then render-checked on the stored version, with a byte-verified restore of the previous document
if that render fails. One STOP for the whole batch (SKILL.md records the operator's reason). No
git writes here.

`sync [--from <ref>] [--on-render-fail halt|quarantine] [--batch <n>] [--resume] [id ...]`

1. **Preconditions.** `node scripts/notifications/brand.mjs --check --root <scratch>` passes,
   where `<scratch>` holds `--from` (default `origin/main`; a branch name when `change` handed
   over): `git worktree add <scratch> <ref>`, or
   `git archive <ref> marketing/notifications | tar -x -C <scratch>`. The same `--root` serves
   `--status`, `classify.mjs` and `dump.mjs --hash` below. Load the state file
   (`node scripts/notifications/state.mjs --store <store> show`); a refusal ends the run and is
   reported as such. For each `pending` entry, confirm `--status` on `--from` still carries that
   version and the repo file still has that FNV (`node scripts/notifications/dump.mjs --hash`);
   drop stale entries with `pending-remove` and say so.

   **`--resume`** picks up a run recorded in the state file instead of planning a new one:
   `state.mjs --store <store> run-show`, confirm `--from` still resolves to the run's `sha`
   (`git rev-parse <ref>`), and continue at `next` under the run's own `onRenderFail`. The
   recorded approval is the approval; there is no second plan STOP. A `--from` that no longer
   resolves to that sha, or an `--ids` argument that is not a subset of the run's, refuses and
   asks for a fresh plan. With no run in flight, `--resume` says so and ends.

2. **Plan** (browser opt-in ask first, its own turn). Read every id in scope from Admin, one
   navigation each with `editor-probe.js`, and take `SSSSTORED` for what Admin holds
   (`browser.md`, The load race: never the first `SSSPOLL`, which can still be the stock body).
   Record the readings as `<id>\t<length>\t<fnv>\t<stamp>` and classify them in one pass:

   ```
   node scripts/notifications/classify.mjs --root <scratch> --observed <scratch>/observed.tsv \
     --json <scratch>/plan.json
   ```

   That applies the match table (`in-sync | behind | ahead | unstamped-stock | unstamped-edited |
   hash-mismatch | orphan`, first row that matches wins) and prints the STOP table. Do not
   classify by eye and do not hand-roll the join: the enum decides which live templates get
   overwritten, and `test/classify.test.mjs` is what proves the table is applied as written.

   **The paste criterion is bytes**: Admin length and FNV differ from the repo file. The version
   column is informational (a `git revert` moves a version backwards by design). `sync` pastes
   over `behind`, `unstamped-stock`, `unstamped-edited`, `hash-mismatch` and `orphan`; `ahead` is
   flagged in the table and not pasted unless the operator named that id explicitly. If nothing
   in scope will be pasted, the plan table says so and the run ends; `audit` is the mode that
   render-checks what Admin already holds.

   **STOP** once with the table, plus three things the operator is approving along with it:
   - the count of live saves (one per pasted id, plus at most one restoring Save per failed
     render, which this approval also covers);
   - the **render-failure policy**, `--on-render-fail halt` (the default: restore, then stop the
     whole run) or `quarantine` (restore, record, and carry on to the next id). Quarantine is a
     real relaxation: the run can end with some templates branded and others on stock, so the
     customer-facing set is temporarily inconsistent. Say that in the STOP rather than burying it.
     The byte gates are **not** relaxed by either policy;
   - the batch cadence, `--batch <n>`: report progress every n ids and keep going. Absent, the run
     reports at the end. A batch report is not a STOP and asks for nothing.

   No per-template stops after this. On approval, record the plan so the run survives a
   compaction, a crash or a new session:

   ```
   node scripts/notifications/state.mjs --store <store> run-start <scratch>/plan.json \
     --ref <--from> --sha <sha> [--on-render-fail quarantine] [--batch <n>]
   ```

3. **Order and per-id loop.** The id-list argument if given, else `pending` order, else manifest
   order; `run-start` records that order and `run-show`'s `next` is the id to do. Per id, per
   `browser.md`, and note what is **not** here: no second navigation for a dump, no fixed waits,
   and no snapshot whose only job is to confirm something the next check already proves.

   1. Navigate to the editor with `editor-probe.js` as the initScript. Read the console and
      require `SSSSTORED` to equal the id's approved "before" numbers. A different value means
      Admin changed since the read pass: do not paste, re-classify every remaining id, and return
      to step 2's STOP with a fresh table; the ids already pasted stay recorded in `seen`.
   2. Materialise the restore source, gated on those same numbers:
      - `beforeSource` `stock`: `node scripts/notifications/before-doc.mjs --from-stock <id>
        --root <scratch> --expect-length <n> --expect-fnv <hex> --out <scratch>/before-<id>.liquid`.
      - `beforeSource` `network`: save the `EmailTemplate` response of the navigation just made
        (`browser.md`, Reading the network), then `before-doc.mjs --from-response <file>` with the
        same `--expect-*` and `--out`.
      Either way the file is refused unless it hashes to the approved numbers, and no id is ever
      pasted, or restored, from a "before" that was not in the approved table.
   3. `node scripts/notifications/clipboard.mjs marketing/notifications/<id>.liquid`. Fresh
      snapshot, click the editor, select all, paste.
   4. Read `SSSPOLL`; require the repo file's length and FNV, and `SSSSTAMP` to read `<id> <n>`.
      Always before Save. Never Save on a mismatch.
   5. Click "Save" (uid from a fresh snapshot), then reload with `editor-probe.js`, declining any
      leave-page dialog. A dialog here means Save did not complete, so cancel it, take a fresh
      snapshot, and click Save once more; a second dialog stops the run per step 4's post-Save
      rule. Require `SSSPOLL` to equal the repo file and `SSSSTAMP` to say `<id> <n>`. On the
      first Save of the run, apply the normalisation probe. There is no separate snapshot to
      confirm the Save button went away: the reload's dialog rule and this byte check both prove
      the Save landed, and the snapshot proved nothing they do not.
   6. Click "Preview template with content"; read the preview from the network response;
      `node scripts/notifications/verify-render.mjs --preview-response <file> --id <id> --version <n>`.
      The preview now renders the stored version, so this check sees the paste on every id,
      including the ones whose preview ignores unsaved edits. Close the dialog only when the next
      action is in this same editor (a restore, or the mobile procedure): a navigation to the next
      id discards it anyway.
   7. Render passed: `node scripts/notifications/state.mjs --store <store> seen <id>
      --from-file marketing/notifications/<id>.liquid`, which derives the version, length and FNV
      from the file that was pasted, takes the sha and ref from the run, and advances the run by
      one. Then, and only here, the mobile procedure per `browser.md` from the preview response
      saved in step 6, when the run pastes a stylesheet change (every manifest id bumped, or a
      first sync) and this is the first template of the run, and on each `header`-override
      template pasted; it never runs between a failed render and the restore, and `browser.md`'s
      viewport restore precedes the next id's step 1.

      Render failed: **restore**, attempted once, starting on the editor page as step 6 left it
      with the dialog closed (if anything navigated away, navigate back with `editor-probe.js`
      and confirm `SSSPOLL` equals the repo file first). `clipboard.mjs
      <scratch>/before-<id>.liquid`, fresh snapshot, click the editor, select all, paste;
      `SSSPOLL` must equal the approved before-numbers; Save per step 5's wait and dialog rule;
      reload with `editor-probe.js`; `SSSPOLL` must equal them again. Record nothing in `seen`.
      Then, per the approved policy:
      - `halt`: the run stops per step 4, with the verifier output as the evidence.
      - `quarantine`: `node scripts/notifications/state.mjs --store <store> run-quarantine <id>
        <verifier output file>`, then continue at the next id. The verifier output is kept
        verbatim for the end-of-run report; nothing is summarised away.

      If the restore's own byte check fails, do not Save: discard the dirty editor per
      `browser.md` (the stored bytes to confirm are the repo file's numbers from step 5, not the
      before-document's), and the stop report says that Admin holds branded version `<n>` of the
      id whose render failed, and points at `rollback <id> --from <ref>` with an explicit `--from`
      of the operator's choosing, because `seen` for this id was not written and `rollback`'s
      default source would be wrong. This stops the run under either policy.
      If Save cannot be clicked, a second leave-page dialog appears, or the post-reload `SSSPOLL`
      does not equal the before-document's numbers, do not paste or Save again. Stop; the report
      quotes the last `SSSPOLL` verbatim, states that Admin's stored document for the id is
      unverified (last verified: branded version `<n>`, which failed its render), and points at
      `audit <id>` and then `rollback <id> --from <ref>` as above. `browser.md`'s failure bound
      ending the run inside this step produces the same report.

   **Cost.** The loop above was 31 tool calls per id before these changes were made, most of it a
   redundant dump navigation, four fixed waits and two snapshots that confirmed nothing. Without
   them it is about 22 for a `stock`-source id and 24 for a `network`-source one. Quote the
   current figure and the resulting total in the step 2 STOP, so the operator is choosing to spend
   a known amount rather than finding out at the end. Re-measure on the next full run and correct
   this paragraph; a guess repeated as a measurement is how the last one went wrong.

4. **Failure.** Any failing check stops the run with the id, the failing check and its evidence,
   verbatim. A failed byte check before Save (step 4) means never Save; discard the dirty editor
   per `browser.md` (the stored bytes to confirm are the before-document's numbers). A failed byte
   check after Save (step 5, including the normalisation probe) means Admin holds bytes nobody
   verified: do not paste anything further, do not restore (the approval covers a restoring Save
   only after a failed render), stop, and the report gives the post-reload `SSSPOLL` numbers
   verbatim, states that Admin's stored document for the id is unverified, and points at
   `audit <id>` and then `rollback <id> --from <ref>`. A failed render check (step 6) is the one
   failure the approved policy governs: `halt` stops the run, `quarantine` records and continues.
   Nothing else in this file is affected by that flag. On exit the skill still records `seen` for
   every id that passed step 7, prints the partial table, and lists the ids not attempted. Do not
   Revert to default here.

5. **End of run.** Re-run the read pass (`editor-probe.js`, `SSSSTORED`) over the pasted ids as a
   batch summary, print the final table, and `pending-remove` those ids. Report the quarantine
   list in full with each verifier output verbatim, and say plainly which ids are branded and
   which are still on their previous document, because a quarantined run leaves the set
   inconsistent on purpose. Then `state.mjs --store <store> run-end`. State plainly that `sync`
   proves Admin holds the bytes, and that the sample-data render is what the render check proves.

   Report counts against three separate denominators and never mix them: **this batch** (the
   `--batch` window, or the ids the operator last named), **this run** (the ids in `run-show`),
   and **this store** (`seen` overall). Conflating the first two produced a wrong count in front
   of the operator on the run this file was rewritten from.
