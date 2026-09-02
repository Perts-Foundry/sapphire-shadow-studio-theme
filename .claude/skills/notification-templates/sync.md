# sync

Push the repo's branded templates into Admin, byte-verified before Save and again after reload.
One STOP for the whole batch (SKILL.md records the operator's reason). No git writes here.

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
   flagged in the table and not pasted unless the operator named that id explicitly.
   If the scope contains no non-pickup id that will be pasted or is already `in-sync`, the plan
   table says so and the STOP offers adding one `in-sync` non-pickup id to the run for its render
   check only (paste, verify, discard; no Save); a scope of pickup ids alone is refused otherwise.
   **STOP** once with the table: per id, Admin version and FNV before, repo version after, the
   `match`, and the count of live saves. No per-template stops after this.

3. **Order and per-id loop.** The id-list argument if given, else `pending` order, else manifest
   order; the two pickup ids always move to the end, after at least one non-pickup template on the
   same stylesheet has passed its render check. Per id, per `browser.md`:
   1. `node scripts/notifications/clipboard.mjs marketing/notifications/<id>.liquid`.
   2. Navigate to the editor with `editor-probe.js` as the initScript, fresh snapshot, click the
      editor, select all, paste.
   3. Read `SSSPOLL`; require the repo file's length and FNV. Always before Save.
   4. Click "Preview template with content"; read the preview from the network response;
      `node scripts/notifications/verify-render.mjs --preview-response <file> --id <id> --version <n>`;
      close the dialog.
   5. Click "Save" (uid from a fresh snapshot). Reload. Require `SSSPOLL` to equal the repo file
      and `SSSSTAMP` to say `<id> <n>`. On the first Save of the run, apply the normalisation
      probe.
   6. `node scripts/notifications/state.mjs --store <store> seen <id> --version <n> --fnv <fnv>
      --length <len> --sha <sha of --from> --ref <--from>`.

   For the two pickup ids, Save comes after step 3 and before step 4, and the render check runs
   on the stored version.

4. **Failure.** Any failing check stops the run with the id, the failing check and its evidence,
   verbatim. Never Save on a failed check; discard the dirty editor per `browser.md`. On exit the
   skill still records `seen` for every id verified after reload, prints the partial table, and
   lists the ids not attempted. Do not Revert to default here.

5. **End of run.** Re-run the read pass (`editor-probe.js`) over the pasted ids as a batch
   summary, print the final table, and `pending-remove` those ids. State plainly that `sync`
   proves Admin holds the bytes, and that the sample-data render is what the render check proves.
