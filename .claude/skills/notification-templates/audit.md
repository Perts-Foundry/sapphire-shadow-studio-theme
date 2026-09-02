# audit

Read every Admin template (or the id list) and compare it to the repo, without pasting anything.
Full by default; `--quick` skips the previews.

1. **Read** (browser opt-in ask first, its own turn). For each id, navigate with
   `editor-probe.js` and read `SSSPOLL`, `SSSSTAMP` and `SSSREVERT`, exactly as in the `sync` read
   pass, and classify with the same `match` table: an unstamped template whose bytes equal
   `stock/<id>.liquid` is `unstamped-stock`, any other unstamped template `unstamped-edited`
   (`SSSREVERT` corroborates when it is not `unknown`). A template whose FNV matches no file on
   `--from` (default `origin/main`) and whose stamp names another id is `orphan`.

2. **Render** (skipped under `--quick`). For each stamped id, open Preview, read it from the
   network response, and run
   `node scripts/notifications/verify-render.mjs --preview-response <file> --id <id> --version <admin version>`;
   an Admin version that is not the manifest's fails `manifest-version`, which is expected for a
   `behind` template and is reported as such. Unstamped ids get `render: skipped`.

3. **Output.** A table with id, repo version, Admin version, `match`, `render`, then one final
   line: `all 46 in sync` or the list that is not. Write the table to the scratchpad, never the
   repo. Record the structured result:
   `node scripts/notifications/state.mjs --store <store> audit <results.json>`, where the JSON is
   `{ <id>: { adminVersion, repoVersion, match, render } }` with `adminVersion` null when
   unstamped. Suggest `sync` for anything not `in-sync`; never start it from here.
