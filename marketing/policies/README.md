# Shop policies

The five shop policies (`SHIPPING_POLICY`, `REFUND_POLICY`, `TERMS_OF_SERVICE`,
`CONTACT_INFORMATION`, `PRIVACY_POLICY`), under version control. **Nothing here is theme code.**
These files are never pushed to a theme, never deployed, and never read by the storefront; Shopify
renders the policy pages from what Admin holds.

Unlike `marketing/notifications/` and `marketing/emails/`, where Admin holds a hand-pasted copy
because there is no API, **policies have a read AND a write API**. So the direction is the other
way round: **the repo is the source of truth and pushes to Admin.** A wording change is a reviewed
PR first, then one gated `policies:push`.

Filenames are the Admin `ShopPolicyType` enum lowercased, so `shipping_policy.html` holds
`SHIPPING_POLICY`.

## Layout

| Path | What it is |
|---|---|
| `manifest.json` | One entry per policy. See the field table below. Types come from `POLICY_TYPES` in `scripts/policies/lib/policies.mjs`, never from a directory glob. |
| `<type>.html` | The policy body, exactly as Admin holds it, in canonical form. Never hand-edited except as a reviewed wording change. |
| `privacy_policy.html` | Tracked read-only. Shopify auto-manages it; see `writable` below. |

### Manifest fields

| Field | What it is for |
|---|---|
| `title` | Admin's title for the policy. Read-only metadata: `ShopPolicyInput` takes only `type` and `body`, so a push cannot change it. |
| `handle` | The storefront path (`/policies/<handle>`). `ShopPolicy` has no `handle` field and its `url` is the numeric legacy form, so this is derived from the type and pinned here, where it doubles as the link target the theme's JSON-LD and templates use. |
| `writable` | `false` on `privacy_policy` only, with `reason` inline. `push.mjs` refuses a non-writable type at flag-parse time rather than discovering the refusal at the API, and `check.mjs` downgrades hygiene refusals to notes for it, so an em dash Shopify introduces cannot turn CI permanently red on something nobody here can fix. |
| `sha256`, `length` | Of the canonical body. `length` is UTF-16 code units (`String.length`, matching the notifications manifest), so `wc -c` disagrees on any body with non-ASCII text. It is redundant with `sha256` and exists **only as a human-readable diff aid**. |
| `headings` | The anchor contract: `{ level, text, id }` per `h2`/`h3`, in document order. See "The anchor contract" below. |
| `remote` | `{ sha256, length, observedAt }`: what Admin was last seen holding. This is the optimistic-concurrency token behind push's freshness gate, and it is the highest-value field in the file. `observedAt` reads as "when Admin was first seen holding this body". |
| `pulledAt` | When this entry's body was last refreshed from Admin. |

Both timestamps are carried forward unchanged when nothing moved. A timestamp rewritten on every
pull would churn all five entries, guarantee a conflict between two branches that both pulled, make
`policies:pull --check` report drift on a clean tree, and train reviewers to skim the file that
carries the anchor contract.

## The anchor contract

`assets/policy-nav.js` builds the "On this page" jump nav at runtime, slugifying each `h2`'s text
into an `id`. Those ids are the shareable `/policies/...#section` links. **A reworded heading
silently changes its id and breaks every link anyone has already sent.** Nothing on the storefront
notices; the manifest's `headings` list is the only thing that does.

`id` is non-null for `h2` only, because the component assigns ids to nothing else. `h3` entries are
recorded anyway so a reworded sub-heading still shows up in the diff, and `level` is kept so an `h2`
and an `h3` with identical text stay distinguishable.

Two `h2` headings that slugify to the same id are a **refusal**, not a warning: the component would
silently suffix one with `-2`, and which one got suffixed would depend on document order.

`slugify` in `scripts/policies/lib/policies.mjs` mirrors `slugify` in `assets/policy-nav.js`
character for character, and a comment in each names the other.
`scripts/policies/test/slugify-parity.test.mjs` extracts the component's function by source and
compares the two over the committed headings plus a deliberately awkward corpus, so **that half of
the coupling is checked at CI time**, not by hand.

The half `node --test` cannot reach is the DOM: whether `extractHeadings` derives the same heading
TEXT that a browser's `textContent` yields, which is the entity-decoding and nested-markup half.
That stays a manual check:

- [ ] **Not yet verified in a browser.** Open `/policies/shipping-policy` (via the admin theme's
  Preview link; the storefront is password-protected) and confirm each `h2`'s assigned `id` matches
  the corresponding `headings[].id` here. Re-do it if either `slugify` or `extractHeadings` changes.

## Commands

| Command | What it does |
|---|---|
| `npm run policies:check` | **Offline.** Proves the repo agrees with itself. What CI runs. |
| `npm run policies:pull` | Reads Admin through the read-only client and rewrites the files and manifest. |
| `npm run policies:pull -- --check` | Reports drift against Admin, writes nothing. Exit 0 clean, 2 drift found, 1 the tool failed. |
| `npm run policies:restamp` | **Offline.** After a deliberate local wording edit, recomputes the derived manifest fields (`sha256`, `length`, `headings`) from the committed bodies. `--check` reports what would change and exits 2. |
| `npm run policies:push -- --type <type>` | Dry run: prints the diff and the exact command to apply it. |
| `npm run policies:test` | The tooling's own suite. |

`pull` and `push` need `MYSHOPIFY_DOMAIN`, `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` (the
repo's one token flow, `scripts/blank-inventory/lib/admin.mjs`). `check` needs nothing, and a test
asserts it runs clean with all three deleted from the environment.

### What each check proves

`policies:check` proves **the repo is self-consistent**. It does NOT prove Admin holds these bytes.
Only `policies:pull --check` proves that. The CI report row says "repo consistency" for exactly
this reason: a green required check must never be read as "the policies are in sync".

"Manifest first" in `pull` is **fail-loud, not self-healing**. Either write order leaves a tree that
`policies:check` refuses, and the recovery is re-running `pull`. Do not "fix" the ordering to make a
partial run look clean; that would hide a half-applied pull.

## Pushing a wording change

**Steps 1 to 3 are repo work. Steps 4 and 5 are OPERATOR-ONLY: they are the live write, and
`policies:push` refuses without a TTY on stdin, so no agent can run them, dry run included.** That
refusal is the rule working; do not wrap it in a pty. An agent's job ends at step 3, handing the
operator the commands for 4 and 5.

1. Run `npm run policies:pull -- --check` first, to be sure Admin has not moved under you.
2. Edit `<type>.html` in a branch, then run `npm run policies:restamp`. It rewrites `sha256`,
   `length` and `headings` from what you wrote, and **shouts if a heading moved**, because that is
   an anchor break. It deliberately does NOT touch `remote` or `pulledAt`, so `policies:check` then
   reports the outstanding push rather than pretending Admin already has it.

   `restamp` is the counterpart to `pull`, and the distinction matters: `pull` answers "what does
   Admin hold?" and would overwrite your edit with the live body; `restamp` answers "I meant that,
   make the manifest agree".
3. Open the PR, review the diff, merge it.
4. Dry run: `npm run policies:push -- --type shipping_policy`. It prints the unified diff, calls out
   any heading change as an anchor break, and prints the exact next command.
5. Apply it: `npm run policies:push -- --type shipping_policy --expect-live-sha=<sha> --confirm=shipping_policy`.

`--confirm` must equal the `--type` value. A bare boolean `--confirm` is copy-pasteable out of shell
history and is exactly the shape an agent reproduces from a README example; requiring the policy
name means one run's confirmation cannot be reused for a different policy by accident.

### The gates, and why each one is there

`push.mjs` runs these in order; any failure aborts with a non-zero exit and no mutation.

1. A known, **writable** `--type`; `CI` unset; stdin is a TTY. A legal-policy write is an operator
   action, never a CI one.
2. `policies:check` clean, a clean working tree under `marketing/policies/`, and `HEAD` an ancestor
   of `origin/main`, so the bytes that reach customers are bytes a reviewer saw.
   The recovery is to merge the PR. `--allow-unreviewed` exists for the case where **the operator**
   is deliberately running a pre-merge canary, and for nothing else.
3. Fetch live. Identical to the repo body means exit 0 with no mutation.
4. **Freshness:** live sha must equal `remote.sha256`. This is the control that turns "silently
   clobber an Admin edit made three months ago" into a refusal, and it costs one manifest field.
   The recovery is `npm run policies:pull`, re-review the diff, then push again. Only if the
   operator has decided the Admin edit should be thrown away does `--force-overwrite-live` apply.
5. **Without `--confirm` this is the dry run.**
6. Backup, verified: written, fsynced, read back, and its sha compared to the live body just
   fetched. A write with no verified backup is a write with no way back.
7. Mutate, and **fail closed on a non-empty `userErrors` or a null `shopPolicy`**. THE SINGLE MOST
   LIKELY SILENT FAILURE IS HERE: `shopPolicyUpdate` returns HTTP 200 on a rejected write, so
   transport success proves nothing.
8. Re-read and verify, retrying a few times (a stale replica read is indistinguishable from
   renormalisation at the comparison point). If the stored body still differs: a **heading** change
   is an anchor break, never normalisation, so it exits non-zero and leaves the file alone; an
   entity- or whitespace-only difference needs `--accept-normalisation` to be taken into the repo;
   anything else is refused outright, flag or no flag. Either way the manifest's `remote` token is
   recorded before the refusal, because the write landed and Admin has moved; that is what makes the
   `--accept-normalisation` re-run reachable instead of tripping the freshness gate. The refusal
   prints the exact re-run command with the new live sha.
9. Print the exact `--restore` command.

### Backups and restore

Backups live **outside the checkout**, at `$XDG_STATE_HOME/shop-policies/` (default
`~/.local/state/shop-policies/`), directory `0700` and files `0600`. `POLICIES_BACKUP_DIR`
overrides. Out of tree rather than behind a `.gitignore` line, because this repo is public and a
`.gitignore` entry is defeated by a single `git add -f`.

**The repo is not an adequate backup.** After a wording change lands, `HEAD` holds the new text and
`HEAD~` matches live only if Admin has not been edited since. The backup is the only record of what
Admin actually held at the moment of the write.

To undo a push:

```bash
npm run policies:push -- --restore ~/.local/state/shop-policies/<type>.<timestamp>.json --confirm=<type>
```

A restore reuses the same gating, minus the repo gates and the freshness gate: its bytes come from
the backup file rather than the tree, and it exists precisely to overwrite what is live now.

It leaves the `<type>.html` **body** untouched, but it does move the manifest's `remote` token,
because Admin now holds the restored bytes and `remote` is the record of that. So a restore leaves
`marketing/policies/` dirty, and the **next** push's clean-tree gate will refuse until you commit
it. Commit the manifest, then run `policies:pull` if you want the body reconciled too.

## Hygiene rules (fail closed)

The **hygiene** rules, which are what `writable` downgrades: a carriage return, a byte-order mark,
a `<script>` or `<style>` tag, and an em dash in any form (`U+2014`, `&mdash;`, `&#8212;`,
`&#x2014;`, `&#X2014;`). `U+2013` (en dash) passes; the shipping policy uses 17 of them. On
`privacy_policy` these become notes rather than refusals, per `writable` above.

`check.mjs` also refuses, for **every** policy including `privacy_policy`, on: a sha or length
mismatch, a heading list that disagrees with the body, two `h2` headings that slugify alike, a file
that is not in canonical form (BOM, CRLF, trailing whitespace, a missing final newline), and an
unexpected file under `marketing/policies/`. Those are not hygiene rules and are **not** downgraded;
if Shopify rewrites the auto-managed privacy body, the fix is `npm run policies:pull`.

A refusal writes nothing. Hygiene enforcement lives in `check.mjs` only, and the tests prove the
enforcement rather than reimplementing the rules.

## Live drift detection is manual

The push-time freshness gate (step 4) is the real control: it turns undetected drift into a refusal
at the only moment it can do damage. A scheduled `policies:pull --check` opening a sticky issue is
the fuller answer, but it would put `write_legal_policies` credentials into CI and widen the blast
radius of this whole subsystem to anyone who can trigger a workflow. It is recorded in `TODO.md`
instead.

**Cadence in the meantime:** run `npm run policies:pull -- --check` after any session in Shopify
Admin that touched Settings > Policies, and as part of any release that changes shipping,
turnaround or refund copy.

## What the tests do not prove

The suite runs against a recording fake client, so green tests are not a verified mutation. They
cannot prove:

- the mutation's actual input shape against the live schema,
- token minting and scopes,
- Shopify's real refusal for the auto-managed privacy policy,
- Shopify's actual normalisation of a stored body,
- idempotency.

Mitigations: the fake's response fixtures are shaped from a real captured `pull`, and **the first
real push must be a canary on `contact_information`** (1.2 KB) with the backup verified by hand,
before anything touches the shipping policy. Capture that first real push response as a fixture.

## Not in CI, deliberately

Both CI steps are **offline by contract**. Do not add `policies:pull --check` to
`.github/workflows/validate.yml`: it needs Shopify credentials, and that workflow runs on Dependabot
PRs, which get a separate secrets scope, so the step would fail unfixably on every one of them.

There is no skill for this. Pull, check and push are three commands against an API.
