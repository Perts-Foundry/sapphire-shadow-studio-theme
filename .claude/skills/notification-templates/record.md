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
4. Return to SKILL.md and run `change` from its step 2: the generator refuses if an anchor moved
   (re-add the override per the README), otherwise regenerate, verify, PR. Then `sync` for that id.
