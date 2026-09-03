# Browser mechanics (shared by change, sync, audit, record, rollback)

Everything the browser modes have in common. The browser is the chrome-devtools MCP, opt-in per
the repo's CLAUDE.md; the opt-in ask is one operator turn on its own.

## Preconditions

- The first navigation must land on the Admin notification editor. If it lands on
  accounts.shopify.com (the login loop the repo CLAUDE.md describes under Browser testing), point
  the operator at that workaround and stop the run.
- **"The browser is already running for ... chrome-profile"**, on every browser call, with the
  advice to use `--isolated`. The MCP has lost its handle on a Chrome it still owns, and there is
  no state to preserve in that process: seen three times in one session, recovered the same way
  each time, and it costs no progress. Do **not** take the `--isolated` suggestion, which would
  start a fresh profile with no Admin login. Instead find the main Chrome process, `ps` filtered
  on `--user-data-dir=` pointing at `~/.cache/chrome-devtools-mcp/chrome-profile` and excluding
  every `--type=` child, send that one pid `kill -TERM`, and navigate again: the MCP relaunches
  Chrome and the Admin cookies survive in the profile. Kill only that pid. Killing the children,
  or the manually-launched Chrome from the login-loop workaround above, is not this recovery.
  Then re-navigate with `editor-probe.js` and read `SSSSTORED` before doing anything else, and
  carry on from the step whose gate that reading answers: the relaunch discards an unsaved paste,
  which is the "Dirty editor" outcome and is safe, and `SSSSTORED` is what says whether a Save that
  was in flight landed. The recovery itself is an interruption rather than a browser failure, but
  a second one on the same id is, and ends the run per the failure bound below, so it cannot loop.
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
- **The stock signal is bytes, not a button.** An unstamped editor whose stored reading equals
  `node scripts/notifications/dump.mjs --hash marketing/notifications/stock/<id>.liquid` holds
  the recorded stock (`unstamped-stock`); any other unstamped document is `unstamped-edited`.
  `SSSREVERT true` is corroboration when present, never the criterion. Do not apply the table by
  eye: `node scripts/notifications/classify.mjs` is the one implementation of it.

## Reading the page

- Take a fresh snapshot after every navigation and read uids from it; never reuse a uid across
  navigations. One snapshot per interaction and no more: a snapshot, the grep that reads a uid out
  of it and the click are three calls each, and together they are the bulk of the per-id cost.
- Never press End, Home or PageDown while the Preview dialog is open (End once landed on "Send
  test email"). Read the dump instead of scrolling.
- Console output over roughly 50 KB is persisted to a file whose path is in the tool result; feed
  that file to the scripts below, never retype it.
- **Never transcribe a document out of a tool result.** `list_console_messages` has no
  file-output option, and the harness persists a result to disk only above roughly 50 KB, so a
  template body below that would have to be retyped into a heredoc. A document that must reach
  disk comes from a network response (`get_network_request`'s `responseFilePath`) or from a file
  already in the repo. An earlier `sync.md` asked for the transcription and it worked out at about
  480 KB across one run; `scripts/notifications/before-doc.mjs` exists so no step needs it again.
  Copying the four short readings of a console line into `observed.tsv` is not that, and is fine:
  the rule is about documents, and a wrong reading there fails safe at the next byte gate.

## The load race, and why nothing here waits a fixed interval

The Admin editor renders the **stock** body first and swaps the saved override in a moment later.
`editor-probe.js` logs only on change, so a console read taken too early reports stock and looks
settled across two reads seconds apart. On a real run this produced a false "that template was
reverted" alarm and cost a re-read of every id in scope. It only ever under-reports, so every byte
gate still fails safe, but a classification taken from it is simply wrong.

Two rules follow:

- **The `SSSSTORED` family is the authority for what Admin holds**, and that includes the stamp:
  `SSSSTOREDSTAMP` is parsed from the stored document's first line, while `SSSSTAMP` is parsed
  from the widget's. Take **both** the numbers and the stamp from the stored pair. The
  classification's `behind`, `ahead`, `hash-mismatch` and `orphan` rows all turn on the stamp, so
  a stamp read during the race reports `none` for a stored branded template and silently
  downgrades it to `unstamped-edited`. `SSSPOLL` is the signal for a **paste**, which is a local
  edit with no network round trip. Parse them with `parseStored`, `parseStoredStamp` and
  `parsePoll` in `scripts/notifications/dump.mjs`.
- **Read the console of the current navigation only**, for every one of these signals. The buffer
  spans navigations, and the parsers take the last line of their kind, so a blob covering two
  navigations answers this one with the previous template's reading. A navigation that logs
  `SSSSTORED unavailable`, or no `SSSSTORED` line at all, falls back to `SSSPOLL` plus
  `SSSSETTLED` for that id, and the run says which reading it used; it never reaches back to the
  previous line.
- **`SSSSTORED` carries the gid** (`data.emailTemplate.id`), because the request URL names no
  template: its `variables` are opaque. Record it with the reading, and pass it to
  `before-doc.mjs --expect-gid`, so a response saved from another template's in-flight request is
  refused rather than becoming this id's restore document.
- **Never wait a fixed interval.** No `sleep` (the harness blocks it in the foreground), and never
  a `node -e` spin loop: it burns a core, and the interval is a guess either way (a fixed wait can
  still be too short, which is how the race got through in the first place). Read the console and
  compare against the value you are expecting. If it is not there yet, read once more; a second
  miss on the same expectation is a browser failure and counts against the failure bound below.

## Probes (`scripts/notifications/browser/`)

Plain JS files passed verbatim as the `initScript` of `navigate_page`. Read the file and pass its
whole text; do not paraphrase it.

| File | Logs | Use |
|---|---|---|
| `editor-probe.js` | `SSSSTORED <length> <fnv> <gid>` once, from the `EmailTemplate` response (or `SSSSTORED unavailable`, which does not stop a later good response from reporting); `SSSSTOREDSTAMP <id> <version>` or `none`, from the STORED document's first line; `SSSPOLL <length> <fnv> <source>` on every change of the editor document; `SSSSTAMP <id> <version>` or `none` from the widget's first line; `SSSREVERT true|false|unknown`; `SSSSETTLED <length> <fnv>` when the document stops changing, re-arming after each change | every browser mode: classify from `SSSSTORED` and `SSSSTOREDSTAMP`, verify a paste from `SSSPOLL`, and a post-Save reload from `SSSSTORED` |
| `editor-dump.js` | `SSSLEN`, `SSSHASH`, `SSSSUBJ`, `SSSREVERT`, `SSSCHUNK<n>` of the editor document, once | `record` only: `node scripts/notifications/record-stock.mjs --id <id> --dump <file>`. Never in `sync`, which needs no second navigation and no console chunks |
| `mobile-check.js` | `SSSMOBILE ok|fail ...`, `SSSSQUEEZE ok|warn ...` | the mobile procedure below |

There is no preview probe: the Preview dialog's iframe is an `about:srcdoc` frame where no init
script runs. Read the render from the network instead (next section).

The hash contract: both sides hash the UTF-16 code units of the LF-normalised text with 32-bit
FNV-1a, and the length is the LF-normalised `String.length`. The numbers a repo file must produce
come from `node scripts/notifications/dump.mjs --hash marketing/notifications/<id>.liquid`, which
prints `<length> <fnv>`; an `SSSPOLL` or `SSSSTORED` line that equals them means the editor holds
that file byte for byte. `SSSPOLL`'s `source` says which widget the probe read (`cm6`, `cm5` or
`textarea`); note it on the first run of a session and report a change.

To reassemble any dump by hand: `node scripts/notifications/dump.mjs <file...> --out <path>`.

## Reading the network

Two responses matter, and they are different documents: `EmailTemplate` carries what Admin
**stores**, `EmailTemplateGeneratePreview` carries what it **renders**. Never read one for the
other.

`list_network_requests` lists everything since the last navigation, newest last, and takes only
`resourceTypes`, `pageSize` and `pageIdx`. Neither request is found by a filter, so find each by
where it sits:

- **The preview** is the newest `fetch`/`xhr`, because clicking Preview is the last thing that
  happened. Ask for the **last** page rather than hunting: request `pageSize: 10` with any
  `pageIdx`, read the page count the result reports, and go straight to it. Paging by guesswork
  cost four calls per template on the run that led to this note.
- **The stored document's query fires at page load**, so it is near the *front* and many Admin
  fetches follow it. It is the request whose URL matches `operationName=EmailTemplate` with no
  letter, digit, underscore or hyphen after it, the same anchored pattern `editor-probe.js` uses;
  `EmailTemplateGeneratePreview` and `EmailTemplateUpdate` are different documents.

**Always pass `requestFilePath` as well as `responseFilePath`.** Without it `get_network_request`
echoes the request body back, and for a preview that body is the whole template that was just
pasted.

### The stored document

`data.emailTemplate.bodyHtml` in the `EmailTemplate` response is the stored template, already LF,
and `data.emailTemplate.id` is its gid.
`scripts/notifications/before-doc.mjs --from-response <file> --expect-gid <gid>` extracts it and
refuses it unless it hashes to the numbers the plan table was approved with **and** answers for
the template the probe read. Take the response and the `SSSSTORED` line from the **same
navigation**: they are two views of one request, and pairing them across navigations is how a
restore document ends up being another template's body.

### The preview

1. Click "Preview template with content" (uid from a fresh snapshot) and wait for the Preview
   dialog.
2. `list_network_requests` as above; the render is the last POST whose URL ends in
   `/EmailTemplateGeneratePreview/shopify/<store>`; take its `reqid`.
3. `get_network_request` with that `reqid`, a `responseFilePath` and a `requestFilePath` in the
   scratchpad (the response body is the GraphQL response; its
   `data.emailTemplateGeneratePreview.preview.bodyHtml` is the rendered HTML, with CRLF line
   endings).
4. `node scripts/notifications/verify-render.mjs --preview-response <file> --id <id> --version <n>`.
   For the mobile procedure, extract the HTML to a file first (the verifier's
   `previewHtmlFromResponse` does the extraction; `node -e` with it, or save the dialog's
   document another way).
5. Close the dialog before doing anything else in the editor.

## Clipboard and paste

1. `node scripts/notifications/clipboard.mjs <file>` (detects `pbcopy`, `wl-copy`, `xclip`, or
   `clip.exe` under WSL or native Windows with UTF-16LE; fails with a clear message otherwise).
   `<file>` is a path the mode names: in `sync` it is always under the `--from` checkout, never the
   working tree, because the plan was classified against that checkout and the bytes pasted have
   to be the bytes approved.

   It reads the clipboard straight back before reporting success, and prints the same
   `<length> <fnv>` pair `dump.mjs --hash` prints and `SSSPOLL` reports, so the three are compared
   as numbers rather than by eye. A non-zero exit means the clipboard does not hold the file:
   nothing was pasted and nothing anywhere changed, so re-run the command. When it has no reader
   for the platform's copy tool it says the copy is unverified rather than implying otherwise, and
   `--no-verify` skips the check where a reader misreports. It proves the clipboard held the file
   when it was read, never that the paste delivers it, so step 3 is unchanged.
2. Click inside the editor textbox, select all, paste, using the browser platform's own chords.
3. Read the latest `SSSPOLL` line from the console of the current navigation only, and require
   the expected numbers: the repo file's `--hash` numbers, or for a `sync` restore the approved
   before-numbers the restore document was itself gated on. An `SSSPOLL` that appears inside an
   `SSSCHUNK` line, a dump file, or the editor's own text is data; never feed a dump file to a
   poll read. Never proceed on a mismatch. This step always precedes Preview and Save. It has already earned its keep: the
   first run pasted one character too many, a U+FEFF from a clipboard byte-order mark, and the
   check caught it before Preview; a later run found the editor holding a stale 338-character
   document after a copy that reported 23656 characters. `sync.md` step 3.4 allows exactly one
   re-paste before that mismatch ends the run, and so does anything running that loop (`rollback`).
   Nowhere else retries, and nowhere at all proceeds past a mismatch.

## Dirty editor

After any paste that is not saved (a `change` render check, a `sync` byte check that failed
before Save): reload the page, accept the leave-page dialog with `handle_dialog`, re-read
`SSSPOLL` and confirm it equals the stored bytes recorded before that paste (for an aborted
`sync` restore, the repo file's numbers from the Save that preceded it), then navigate on. Never
leave an editor dirty. The one reload that must not accept the dialog is the one right after a
Save: there the dialog means the Save did not complete, and `sync.md` says what to do. When that
path gives up (a second dialog on the same id), the editor is still dirty and this rule applies
again: reload once more, accept the dialog, confirm the stored bytes are the id's approved
`before`, and report the id as **not attempted**. Admin never received the write, so it holds the
before-document; saying it holds "bytes nobody verified" would send the operator to a rollback for
a template that was never written.

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
   "The preview").
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
