# Browser mechanics (shared by change, sync, audit, record, rollback)

Everything the browser modes have in common. The browser is the chrome-devtools MCP, opt-in per
the repo's CLAUDE.md; the opt-in ask is one operator turn on its own.

## Preconditions

- The first navigation must land on the Admin notification editor. If it lands on
  accounts.shopify.com (the login loop the repo CLAUDE.md describes under Browser testing), point
  the operator at that workaround and stop the run.
- Keep the window at least 1200 wide (`resize_page`) before looking for the Preview button; a
  narrow window moves it under "Page actions".
- The editor URL per id: `https://admin.shopify.com/store/<store>/email_templates/<id>/edit`, with
  `<store>` the handle from SKILL.md's State section and `<id>` a manifest id. Observed on a
  previous run; if the first navigation of a run lands elsewhere, stop and report the URL.
- Observed control labels: the code editor is a multiline textbox; the buttons are "Preview
  template with content", "Revert changes button" (disabled when the stored template is stock,
  the only stock signal Shopify offers), "Save", and, inside the Preview dialog, an "Email
  preview" iframe, "Close" and "Send test email". Confirm against a fresh snapshot; if a label
  differs, report it and continue only when the control is unambiguous.

## Reading the page

- Take a fresh snapshot after every navigation and read uids from it; never reuse a uid across
  navigations.
- Never press End, Home or PageDown while the Preview dialog is open (End once landed on "Send
  test email"). Read the dump instead of scrolling.
- Console output over roughly 50 KB is persisted to a file whose path is in the tool result; feed
  that file to the scripts below, never retype it.

## Probes (`scripts/notifications/browser/`)

Plain JS files passed verbatim as the `initScript` of `navigate_page`. Read the file and pass its
whole text; do not paraphrase it.

| File | Logs | Use |
|---|---|---|
| `editor-probe.js` | `SSSPOLL <length> <fnv> <source>` on every change of the editor document; `SSSSTAMP <id> <version>` or `none` from the first line; `SSSREVERT true|false` | read-only: classify, and verify a paste before Save and after reload |
| `editor-dump.js` | `SSSLEN`, `SSSHASH`, `SSSSUBJ`, `SSSREVERT`, `SSSCHUNK<n>` of the editor document, once | `record`: `node scripts/notifications/record-stock.mjs --id <id> --dump <file>` |
| `preview-dump.js` | `SSSLEN`, `SSSHASH`, `SSSCHUNK<n>` of the Preview iframe's document, once it holds a table | render checks: `node scripts/notifications/verify-render.mjs --dump <file> --id <id> --version <n>` |
| `mobile-check.js` | `SSSMOBILE ok|fail ...`, `SSSSQUEEZE ok|warn ...` | the mobile procedure below |

The hash contract: both sides hash the UTF-16 code units of the LF-normalised text with 32-bit
FNV-1a, and the length is the LF-normalised `String.length`. The numbers a repo file must produce
come from `node scripts/notifications/dump.mjs --hash marketing/notifications/<id>.liquid`, which
prints `<length> <fnv>`; an `SSSPOLL` line that equals them means the editor holds that file byte
for byte. `SSSPOLL`'s `source` says which widget the probe read (`cm6`, `cm5` or `textarea`); note
it on the first run of a session and report a change.

To reassemble any dump by hand: `node scripts/notifications/dump.mjs <file...> --out <path>`.

## Clipboard and paste

1. `node scripts/notifications/clipboard.mjs marketing/notifications/<id>.liquid` (detects
   `pbcopy`, `wl-copy`, `xclip`, or `clip.exe` under WSL with UTF-16LE; fails with a clear message
   otherwise).
2. Click inside the editor textbox, select all, paste, using the browser platform's own chords.
3. Read the latest `SSSPOLL` line and require the repo file's `--hash` numbers. Never proceed on
   a mismatch. This step always precedes Preview and Save.

## Dirty editor

After any paste that is not saved (a `change` render check, any failed `sync` step): reload the
page, accept the leave-page dialog with `handle_dialog`, re-read `SSSPOLL` and confirm it equals
the stored bytes recorded before the paste, then navigate on. Never leave an editor dirty.

## Save-time normalisation probe

On the first Save of any `sync` run, compare the post-reload `SSSPOLL` to the repo file. A
systematic difference (a trailing newline, line endings) stops the run and is fixed in the
generator's output, never by adding tolerance to the check.

## Pickup rule

`ready_for_pickup` and `pickup_receipt` ignore unsaved edits in the preview: the preview renders
the stored template. They are never the representative template for an unsaved render check; in
`sync` they come last, after at least one non-pickup template on the same stylesheet has passed
its render check, and for them Save comes after the byte check and before Preview, so the render
check runs on the stored version.

## Failure bound

Two consecutive browser failures (a navigation that does not land, a dialog that does not
appear, a stale uid) end the run with the failure reported.

## Mobile layout procedure (once per stylesheet change)

Run on one representative non-pickup template and once per `header`-override template
(`gift_card_confirmation`, `gift_card_notification`, `store_credit_issued`):

1. Reassemble the preview dump to a file in the scratchpad
   (`node scripts/notifications/dump.mjs <dump> --out <scratch>/preview-<id>.html`).
2. `emulate` viewport `411x900x2,mobile,touch`; open the file with `navigate_page` on its
   `file://` URL with `browser/mobile-check.js` as the initScript.
3. Read the console: `SSSMOBILE ok` means every `table.container` has the same width and left
   edge and the document does not scroll sideways; `SSSSQUEEZE warn` names any descendant still
   wider than 300px when the containers are forced to 200px (an unshrinkable row), to report as a
   warning.
4. Restore: `emulate` back to none and `resize_page` to at least 1200 wide, or the Admin editor's
   Preview button moves under "Page actions".

## Test send (on request only, never a default step)

Open the id's Preview, click "Send test email"; it goes to the address pre-filled in that dialog.
Tell the operator what to look for on the phone: every card the same width, no seam between the
header and the body card; dark-mode recolouring of the white and pale-blue cards is the mail
client's own and not a template fault.
