# record

The README's drift procedure, made concrete: bring a Shopify change to one stock template into
the repo. It is the one mode that may Revert to default, for the single id named, after its own
STOP, and it accepts the short window during which that template sends stock, unbranded.

1. Browser opt-in ask (its own turn). Declined: end.
2. **STOP** naming the single id, what the operator will lose (the branded template until
   `sync`), and that the editor's stored copy is about to be replaced by stock. Approval here is
   what authorises the skill to click "Revert changes" and then Save; nothing else is asked
   before those two clicks.
3. Reload with `editor-probe.js` installed, read `SSSSTORED` for the reverted document's length,
   FNV and gid, and save that navigation's `EmailTemplate` response (`browser.md`, Reading the
   network). Turn it into a file with
   `node scripts/notifications/before-doc.mjs --from-response <response> --expect-length <n>
   --expect-fnv <hex> --expect-gid <gid> --out <scratch>/<id>.liquid`, using the numbers
   `SSSSTORED` just reported, which ties the saved response to the document the probe read. Then
   `node scripts/notifications/record-stock.mjs --id <id> --file <scratch>/<id>.liquid --subject
   "<the Admin subject field>"`, and `git diff marketing/notifications/stock/<id>.liquid` to
   review what Shopify changed. The recorder drops any `override` on a changed snapshot and says
   so; `version` and `brandedSha256` survive on purpose so the next generate bumps.

   `editor-dump.js` and `record-stock.mjs --dump` still work and remain the fallback when the
   network route is unavailable, but only when the harness persists the console output to a file:
   most stock templates are small enough to arrive inline, and `browser.md` forbids retyping a
   document out of a tool result.

   **Two rules on what the fresh snapshot may contain, both silent failures.**

   - **A `<style>` block after `</head>` in the snapshot is shop-injected, not stock.** Admin's
     Settings > Notifications > *Customize email templates* colour settings write it into this
     store's copy, so it comes back on every re-record while that customisation is on, and it wins
     on cascade order over `brand-style.css`. If the snapshot has one, the customisation is still
     on: turn it off and re-record, or record it and expect to carry an `override.replace` that
     drops the block. Do not sync a template in that state (`marketing/notifications/README.md`
     has the whole explanation).
   - **A dropped `override` is a decision to re-make, not a diff to wave through.**
     `record-stock.mjs` deliberately drops any `override` whose anchored stock content changed
     (`record-stock.mjs:53-64`) and says so on stderr; the next `generate` then refuses rather
     than resolving a stale anchor against text that moved. When that happens, the fix that
     override encoded must be re-decided before the next `generate`: work out what the override
     was for, whether the change removes the need for it, and re-add it against the new anchor if
     it does not. Report the dropped field and what it was for; never re-add it unchanged just to
     make the refusal go away.

4. Return to SKILL.md and run `change` from its step 2: the generator refuses if an anchor moved
   (re-add the override per the README), otherwise regenerate, verify, PR. Then `sync` for that id.
