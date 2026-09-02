# record

The README's drift procedure, made concrete: bring a Shopify change to one stock template into
the repo. It is the one mode that may Revert to default, for the single id named, after its own
STOP, and it accepts the short window during which that template sends stock, unbranded.

1. **STOP** naming the single id, what the operator will lose (the branded template until
   `sync`), and that the editor's stored copy is about to be replaced by stock.
2. Browser opt-in ask (its own turn). Navigate to the id's editor; the operator reverts it to
   default (or the skill clicks "Revert changes" on the operator's word), then Save.
3. Reload with `editor-dump.js` installed; save the console output to a file; then
   `node scripts/notifications/record-stock.mjs --id <id> --dump <file>` (add `--subject` if the
   dump carried none), and `git diff marketing/notifications/stock/<id>.liquid` to review what
   Shopify changed. The recorder drops any `override` on a changed snapshot and says so;
   `version` and `brandedSha256` survive on purpose so the next generate bumps.
4. Return to SKILL.md and run `change` from its step 2: the generator refuses if an anchor moved
   (re-add the override per the README), otherwise regenerate, verify, PR. Then `sync` for that id.
