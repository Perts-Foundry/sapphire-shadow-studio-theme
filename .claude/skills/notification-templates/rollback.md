# rollback

For a saved template that misbehaves in real mail: re-paste the last synced version from git.
`rollback <id> [--from <ref>]`.

1. **Source.** The state file's `seen[<id>].sha` (or `--from`). Extract both the template and its
   manifest from that commit to the scratchpad:
   `git show <sha>:marketing/notifications/<id>.liquid > <scratch>/<id>.liquid` and
   `git show <sha>:marketing/notifications/manifest.json > <scratch>/manifest.json`. The
   version is that manifest's entry for the id; the render check below passes that manifest with
   `--manifest`, because the checkout's manifest carries the newer version.
2. **STOP** with the id, the current Admin version (read with `editor-probe.js` after the browser
   opt-in ask, its own turn), the target version and sha.
3. Run the `sync` per-id loop from its step 3 with the scratch file as the paste source: clipboard,
   paste, byte check against the scratch file, Preview read from the network response,
   `verify-render.mjs --preview-response <file> --id <id> --version <target> --manifest
   <scratch>/manifest.json`, Save, reload, re-verify, `state.mjs seen` with the target sha and ref.
4. If no earlier version exists, or the target also fails its checks, a second **STOP** offers
   Revert to default as the last resort (stock is Shopify-maintained and known-good); on approval,
   click "Revert changes", Save, reload, confirm `SSSREVERT true`, and record nothing in `seen`.
