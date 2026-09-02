# sync

Push the repo's branded templates into Admin, byte-verified before Save and again after reload,
then render-checked on the stored version, with a byte-verified restore of the previous document
if that render fails. One STOP for the whole batch (SKILL.md records the operator's reason). No
git writes here.

1. **Preconditions.** `node scripts/notifications/brand.mjs --check --root <scratch>` passes,
   where `<scratch>` holds `--from` (default `origin/main`; a branch name when `change` handed
   over): `git worktree add <scratch> <ref>`, or
   `git archive <ref> marketing/notifications | tar -x -C <scratch>`. The same `--root` serves
   `--status` and `dump.mjs --hash` below. Load the state file
   (`node scripts/notifications/state.mjs --store <store> show`); a refusal ends the run and is
   reported as such. For each `pending` entry, confirm `--status` on `--from` still carries that
   version and the repo file still has that FNV (`node scripts/notifications/dump.mjs --hash`);
   drop stale entries with `pending-remove` and say so.

2. **Plan** (browser opt-in ask first, its own turn). `node scripts/notifications/brand.mjs
   --status`, then for each id in scope navigate with `editor-probe.js` and read `SSSPOLL`
   (length, FNV), `SSSSTAMP` and `SSSREVERT`. Classify with the `match` enum:

   | Admin | `match` |
   |---|---|
   | bytes equal the repo file | `in-sync` |
   | stamped, lower version than the repo | `behind` |
   | stamped, higher version than the repo | `ahead` |
   | unstamped, bytes equal `stock/<id>.liquid` (`dump.mjs --hash` on it) | `unstamped-stock` |
   | unstamped, any other bytes (hand-edited or an older paste) | `unstamped-edited` |
   | stamped with the repo version, bytes differ | `hash-mismatch` |
   | stamped with a stamp naming a different id, and bytes equal no `<id>.liquid` or `stock/<id>.liquid` on `--from` | `orphan` |

   Rows are tested top to bottom; the first match wins.

   **The paste criterion is bytes**: Admin length and FNV differ from the repo file. The version
   column is informational (a `git revert` moves a version backwards by design). `sync` pastes
   over `behind`, `unstamped-stock`, `unstamped-edited`, `hash-mismatch` and `orphan`; `ahead` is
   flagged in the table and not pasted unless the operator named that id explicitly. If nothing
   in scope will be pasted, the plan table says so and the run ends; `audit` is the mode that
   render-checks what Admin already holds.
   **STOP** once with the table: per id, Admin version and FNV before, repo version after, the
   `match`, and the count of live saves (one per pasted id, plus at most one restoring Save,
   which this approval also covers). No per-template stops after this.

3. **Order and per-id loop.** The id-list argument if given, else `pending` order, else manifest
   order. Per id, per `browser.md`:
   1. Navigate to the editor with `editor-dump.js` as the initScript and save the console
      output to `<scratch>/before-<id>.console`. A dump over the harness's size threshold is
      persisted to a file whose path is in the tool result: use that path. A smaller one arrives
      inline: write the tool result to the file verbatim and whole, and let `dump.mjs`'s own
      length and hash check reject any transcription error. Reassemble it:
      `node scripts/notifications/dump.mjs <scratch>/before-<id>.console --out <scratch>/before-<id>.liquid`.
      Its `SSSLEN`/`SSSHASH` must equal the plan table's "before" numbers for the id. A
      difference means Admin changed since the read pass: do not paste. Discard nothing (the
      editor is clean), re-classify every remaining id, and return to step 2's STOP with a fresh
      table; the ids already pasted stay recorded in `seen`. No id is ever pasted, or restored,
      from a "before" that was not in the approved table. This file is the restore source in
      step 7; it is what Admin held, whatever its provenance, so the restore never depends on git
      or on `stock/`.
   2. `node scripts/notifications/clipboard.mjs marketing/notifications/<id>.liquid`.
   3. Reload with `editor-probe.js` as the initScript, fresh snapshot, click the editor, select
      all, paste.
   4. Read `SSSPOLL`; require the repo file's length and FNV. Always before Save.
   5. Click "Save" (uid from a fresh snapshot) and wait until the Save button is gone from a
      fresh snapshot. Then reload with `editor-probe.js`, declining any leave-page dialog: a
      dialog here means Save did not complete, so cancel it, take a fresh snapshot, and click
      Save once more; a second dialog stops the run per step 4's post-Save rule. Require
      `SSSPOLL` to equal the repo file and `SSSSTAMP` to say `<id> <n>`. On the first Save of
      the run, apply the normalisation probe.
   6. Click "Preview template with content"; read the preview from the network response;
      `node scripts/notifications/verify-render.mjs --preview-response <file> --id <id> --version <n>`;
      close the dialog. The preview now renders the stored version, so this check sees the
      paste on every id, including the ones whose preview ignores unsaved edits.
   7. Render passed: `node scripts/notifications/state.mjs --store <store> seen <id> --version <n>
      --fnv <fnv> --length <len> --sha <sha of --from> --ref <--from>`. Then, and only here, the
      mobile procedure per `browser.md` from the preview response saved in step 6, when the run
      pastes a stylesheet change (every manifest id bumped, or a first sync) and this is the
      first template of the run, and on each `header`-override template pasted; it never runs
      between a failed render and the restore, and `browser.md`'s viewport restore precedes the
      next id's step 1.
      Render failed: **restore**, attempted once, starting on the editor page as step 6 left it
      with the dialog closed (if anything navigated away, navigate back with `editor-probe.js`
      and confirm `SSSPOLL` equals the repo file first). `clipboard.mjs
      <scratch>/before-<id>.liquid`, fresh snapshot, click the editor, select all, paste;
      `SSSPOLL` must equal the before-dump's `SSSLEN` and `SSSHASH`; Save per step 5's wait
      and dialog rule; reload with `editor-probe.js`; `SSSPOLL` must equal them again. Record
      nothing in `seen`. Then the run stops per step 4 below, with the verifier output as the
      evidence.
      If the restore's own byte check fails, do not Save: discard the dirty editor per
      `browser.md` (the stored bytes to confirm are the repo file's numbers from step 5, not the
      before-dump's), and the stop report says that Admin holds branded version `<n>` of the id
      whose render failed, and points at `rollback <id> --from <ref>` with an explicit `--from`
      of the operator's choosing, because `seen` for this id was not written and `rollback`'s
      default source would be wrong.
      If Save cannot be clicked, a second leave-page dialog appears, or the post-reload
      `SSSPOLL` does not equal the before-dump's numbers, do not paste or Save again. Stop; the
      report quotes the last `SSSPOLL` verbatim, states that Admin's stored document for the id
      is unverified (last verified: branded version `<n>`, which failed its render), and points
      at `audit <id>` and then `rollback <id> --from <ref>` as above. `browser.md`'s failure
      bound ending the run inside this step produces the same report.

4. **Failure.** Any failing check stops the run with the id, the failing check and its evidence,
   verbatim. A failed byte check before Save (step 4) means never Save; discard the dirty editor
   per `browser.md` (the stored bytes to confirm are the before-dump's numbers). A failed byte
   check after Save (step 5, including the normalisation probe) means Admin holds bytes nobody
   verified: do not paste anything further, do not restore (the approval covers a restoring Save
   only after a failed render), stop, and the report gives the post-reload `SSSPOLL` numbers
   verbatim, states that Admin's stored document for the id is unverified, and points at
   `audit <id>` and then `rollback <id> --from <ref>`. A failed render check (step 6) means
   restore per step 7, then stop. On exit the skill still records `seen` for every id that
   passed step 7, prints the partial table, and lists the ids not attempted. Do not Revert to
   default here.

5. **End of run.** Re-run the read pass (`editor-probe.js`) over the pasted ids as a batch
   summary, print the final table, and `pending-remove` those ids. State plainly that `sync`
   proves Admin holds the bytes, and that the sample-data render is what the render check proves.
