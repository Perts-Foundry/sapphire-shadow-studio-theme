# rollback

For a saved template that misbehaves in real mail: re-paste the last synced version from git.
`rollback <id> [--from <ref>]`.

1. **Source.** `--from <ref>` if given. Otherwise the commit that last changed the template
   before the one Admin holds: `git log -n 2 --format=%H <seen sha> -- marketing/notifications/<id>.liquid`
   and take the second line; refuse with "no earlier version in history" if there is only one.
   Never default to `seen[<id>].sha` itself: that is the version being rolled back. Extract the
   template, its manifest and its stylesheet from the source commit to the scratchpad:
   `git show <sha>:marketing/notifications/<id>.liquid > <scratch>/<id>.liquid`,
   `git show <sha>:marketing/notifications/manifest.json > <scratch>/manifest.json` and
   `git show <sha>:marketing/notifications/lib/brand-style.css > <scratch>/brand-style.css`. The
   version is that manifest's entry for the id; the render check below passes that manifest and
   stylesheet with `--manifest` and `--css`, because the checkout's carry the newer ones.
2. **STOP** with the id, what Admin currently holds and the target. Read Admin with
   `editor-probe.js` after the browser opt-in ask (its own turn), taking `SSSSTORED` and
   `SSSSTOREDSTAMP`, never `SSSPOLL`/`SSSSTAMP`. Present the reading's length and FNV as well as
   the version: those numbers are this run's **before-numbers**, and the paste is gated on them,
   so they belong in what the operator approves. Also present the target version and sha.
3. Run the `sync` per-id loop from its step 3 with the scratch file as the paste source and the
   scratch manifest and stylesheet passed to the render check
   (`verify-render.mjs --preview-response <file> --id <id> --version <target> --manifest
   <scratch>/manifest.json --css <scratch>/brand-style.css`). The loop's before-document, byte
   check, its one re-paste on a pre-Save mismatch (step 3.4, capped at two paste attempts per id),
   Save first, reload and re-verify, render check on the stored version, and restore on a failed
   render all apply. A rollback runs no `classify.mjs` and starts no `run`, so four of the
   loop's inputs come from here instead:

   - the **before-numbers** are the step 2 reading, and the **after-numbers** are
     `dump.mjs --hash <scratch>/<id>.liquid`;
   - the **before-document** comes from `before-doc.mjs --from-response`, with `--expect-gid` and
     the step 2 numbers. `--from-stock` is only right when those numbers equal
     `dump.mjs --hash marketing/notifications/stock/<id>.liquid`;
   - `state.mjs seen` takes its `--version`, `--fnv`, `--length`, `--sha` and `--ref` explicitly,
     because there is no run to derive them from;
   - the render-failure policy is always **halt**. There is no run record, so `run-quarantine` has
     nothing to write to and refuses; a failed render restores, and step 4 is what follows.
4. If no earlier version exists, or the target also fails its checks, a second **STOP** offers
   Revert to default as the last resort (stock is Shopify-maintained and known-good); on approval,
   click "Revert changes", Save, reload, confirm `SSSPOLL` equals
   `node scripts/notifications/dump.mjs --hash marketing/notifications/stock/<id>.liquid` (a
   mismatch means Shopify's stock moved: report it and suggest `record`); `SSSREVERT true`
   corroborates when present. Record nothing in `seen`.
