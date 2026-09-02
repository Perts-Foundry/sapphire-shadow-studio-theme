# audit

Read every Admin template (or the id list) and compare it to the repo, without pasting anything.
Full by default; `--quick` skips the previews.

1. **Read** (browser opt-in ask first, its own turn). For each id, navigate with
   `editor-probe.js` and read `SSSPOLL`, `SSSSTAMP` and `SSSREVERT`, exactly as in the `sync` read
   pass, and classify with the `sync` table, in its order (`SSSREVERT` corroborates an
   `unstamped-stock` row when it is not `unknown`). `--from` defaults to `origin/main`.

2. **Render** (skipped under `--quick`). For each stamped id, open Preview, read it from the
   network response, and run
   `node scripts/notifications/verify-render.mjs --preview-response <file> --id <id> --version <admin version>`;
   record `render: pass` when `manifest-version` is the only FAIL line on a `behind` or `ahead`
   id (its version is not the manifest's by definition), and `fail` on any other FAIL. Unstamped
   ids, and `orphan` or `hash-mismatch` ids (whose `version` check fails by construction), get
   `render: skipped`, with the reason in the table.

3. **Output.** A table with id, repo version, Admin version, `match`, `render`, then one final
   line: `all <N> in sync` (N from `--status`) or the list that is not. Write the table to the scratchpad, never the
   repo. Record the structured result:
   `node scripts/notifications/state.mjs --store <store> audit <results.json>`, where the JSON is
   `{ <id>: { adminVersion, repoVersion, match, render } }` with `adminVersion` null when
   unstamped. Suggest `sync` for anything not `in-sync`; never start it from here.
