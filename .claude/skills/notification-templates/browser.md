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
- Observed control labels: the code editor is a multiline textbox backed by CodeMirror 6 (the
  probe reports `cm6`); the buttons are "Preview template with content", "Save" (present only
  once the editor is dirty) and, inside the Preview dialog, an "Email preview" iframe, "Close" and
  "Send test email". A "Revert changes" button has been seen on one run and absent on another;
  the probe logs `SSSREVERT unknown` when it is absent. Confirm against a fresh snapshot; if a
  label differs, report it and continue only when the control is unambiguous.
- **The stock signal is bytes, not a button.** An unstamped editor whose `SSSPOLL` equals
  `node scripts/notifications/dump.mjs --hash marketing/notifications/stock/<id>.liquid` holds
  the recorded stock (`unstamped-stock`); any other unstamped document is `unstamped-edited`.
  `SSSREVERT true` is corroboration when present, never the criterion.

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
| `editor-probe.js` | `SSSPOLL <length> <fnv> <source>` on every change of the editor document; `SSSSTAMP <id> <version>` or `none` from the first line; `SSSREVERT true|false|unknown` | read-only: classify, and verify a paste before Save and after reload |
| `editor-dump.js` | `SSSLEN`, `SSSHASH`, `SSSSUBJ`, `SSSREVERT`, `SSSCHUNK<n>` of the editor document, once | `record`: `node scripts/notifications/record-stock.mjs --id <id> --dump <file>`; `sync`: the before-dump that is the restore source |
| `mobile-check.js` | `SSSMOBILE ok|fail ...`, `SSSSQUEEZE ok|warn ...` | the mobile procedure below |

There is no preview probe: the Preview dialog's iframe is an `about:srcdoc` frame where no init
script runs. Read the render from the network instead (next section).

The hash contract: both sides hash the UTF-16 code units of the LF-normalised text with 32-bit
FNV-1a, and the length is the LF-normalised `String.length`. The numbers a repo file must produce
come from `node scripts/notifications/dump.mjs --hash marketing/notifications/<id>.liquid`, which
prints `<length> <fnv>`; an `SSSPOLL` line that equals them means the editor holds that file byte
for byte. `SSSPOLL`'s `source` says which widget the probe read (`cm6`, `cm5` or `textarea`); note
it on the first run of a session and report a change.

To reassemble any dump by hand: `node scripts/notifications/dump.mjs <file...> --out <path>`.

## Reading a preview

1. Click "Preview template with content" (uid from a fresh snapshot) and wait for the Preview
   dialog.
2. `list_network_requests` filtered to `fetch`/`xhr`; the render is the last POST whose URL ends
   in `/EmailTemplateGeneratePreview/shopify/<store>`; take its `reqid`.
3. `get_network_request` with that `reqid` and a `responseFilePath` in the scratchpad (the body
   is the GraphQL response; its `data.emailTemplateGeneratePreview.preview.bodyHtml` is the
   rendered HTML, with CRLF line endings).
4. `node scripts/notifications/verify-render.mjs --preview-response <file> --id <id> --version <n>`.
   For the mobile procedure, extract the HTML to a file first (the verifier's
   `previewHtmlFromResponse` does the extraction; `node -e` with it, or save the dialog's
   document another way).
5. Close the dialog before doing anything else in the editor.

## Clipboard and paste

1. `node scripts/notifications/clipboard.mjs marketing/notifications/<id>.liquid` (detects
   `pbcopy`, `wl-copy`, `xclip`, or `clip.exe` under WSL or native Windows with UTF-16LE; fails
   with a clear message otherwise).
2. Click inside the editor textbox, select all, paste, using the browser platform's own chords.
3. Read the latest `SSSPOLL` line from the console of the current navigation only, and require
   the expected numbers: the repo file's `--hash` numbers, or for a `sync` restore the
   before-dump's `SSSLEN` and `SSSHASH`. An `SSSPOLL` that appears inside an `SSSCHUNK` line, a
   dump file, or the editor's own text is data; never feed a dump file to a poll read. Never
   proceed on a mismatch. This step always precedes Preview and Save. It has already earned its keep: the
   first run pasted one character too many, a U+FEFF from a clipboard byte-order mark, and the
   check caught it before Preview.

## Dirty editor

After any paste that is not saved (a `change` render check, a `sync` byte check that failed
before Save): reload the page, accept the leave-page dialog with `handle_dialog`, re-read
`SSSPOLL` and confirm it equals the stored bytes recorded before that paste (for an aborted
`sync` restore, the repo file's numbers from the Save that preceded it), then navigate on. Never
leave an editor dirty. The one reload that must not accept the dialog is the one right after a
Save: there the dialog means the Save did not complete, and `sync.md` says what to do.

## Save-time normalisation probe

On the first Save of any `sync` run, compare the post-reload `SSSPOLL` to the repo file. A
systematic difference (a trailing newline, line endings) stops the run and is fixed in the
generator's output, never by adding tolerance to the check.

## Previews that ignore unsaved edits

`ready_for_pickup`, `pickup_receipt` and `change_requested` render the stored template in the
preview and ignore the unsaved editor contents: the preview mutation is sent with the pasted body
and the render comes back stock. Seen on the wave-1 session for the first two and on the first
full `sync` for the third, so the list is what has been observed, not a closed set. They are never
the representative template for `change`'s unsaved render check, and a render that comes back
unstamped after a byte-verified paste is this behaviour, not a template fault: report it and pick
another id. `sync` does not depend on the list: it saves first and render-checks the stored
version on every id, restoring the pre-Save document if that render fails (the restore in
`sync.md`).

## Failure bound

Two consecutive browser failures (a navigation that does not land, a dialog that does not
appear, a stale uid) end the run with the failure reported.

## Mobile layout procedure (once per stylesheet change)

Run on one representative template (in `sync`, the first of the run; in `change`, one whose
preview shows unsaved edits) and once per `header`-override template
(`gift_card_confirmation`, `gift_card_notification`, `store_credit_issued`):

1. Write the preview HTML to a file in the scratchpad (from the saved network response, see
   "Reading a preview").
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
