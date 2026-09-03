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
| `stamped` | Whether the body carries a version stamp. `false` on `privacy_policy` only: Shopify refuses `shopPolicyUpdate` on it, so a stamp we could never push would be a permanent `check` failure. |
| `version` | An integer, from 1. **Derived, never hand-typed**; see "Versioning" below. |
| `coreSha256` | Of the **core** body, with the version stamp stripped. **This is the hash every comparison in the subsystem runs on.** It is the wording. |
| `sha256`, `length` | Of the canonical body **as committed**, stamp included. An integrity hash and a human-readable diff aid; never compared against anything live. `length` is UTF-16 code units (`String.length`, matching the notifications manifest), so `wc -c` disagrees on any body with non-ASCII text. |
| `headings` | The anchor contract: `{ level, text, id }` per `h2`/`h3`, in document order. See "The anchor contract" below. |

`sha256` and `coreSha256` differ for every stamped policy, and that is the point rather than an
accident. Confusing them is how the stamp self-trips its own gate: comparing a stamped repo body
against an unstamped live one reports a difference that is not a wording change.

**`remote` and `pulledAt` are gone.** They were observations, not reviewed content, and keeping
them here meant a successful push dirtied its own working tree, so the dirty-tree gate blocked the
next push until that side effect had been committed and merged: a PR per push, forever. They live
in a machine-local state file now; see "The observation state" below.

## Versioning

Every policy carries a `version` integer, and every stamped body carries it as an invisible HTML
comment on its first line:

```html
<!-- sss-policy shipping_policy v3 -->
```

So viewing source on the live policy page answers "which version is up?" without an Admin read.

**The version is derived, never hand-typed.** `deriveVersion` in `lib/policies.mjs` is the one
place, and `policies:restamp` is what applies it:

| Previous state | Result |
|---|---|
| no entry, or no `version` | `1` |
| `version` present, `coreSha256` absent | `version` (seed; do not bump) |
| `version` present, `coreSha256` unchanged | `version` |
| `version` present, `coreSha256` differs | `version + 1` |
| `version` not a safe integer >= 1 | refusal, nothing written |
| at or below the monotonic floor, different wording | refusal, nothing written |

**The monotonic floor** exists because `deriveVersion` reads the previous entry from a git-tracked
file. A `git revert` restores body and manifest atomically and walks `version` BACKWARDS while the
live store keeps the higher number; the next wording change then re-derives a version that is
already live against different bytes, and the stamp stops identifying anything. So the state file
records `highestPushed` per policy, and **`push` refuses to write a version at or below it unless
the wording is identical**. Enforcement sits at the write, where the state file is guaranteed
present because the freshness gate already needs it.

**All five seeded at version 1**, meaning "as of the PR that introduced versioning". Seeding the
two already-pushed policies at 2 would have asserted a claim about git history that nothing
enforces, and would be unverifiable either way, because the live store never carried a v1.

**No live write was spent to deploy the stamps.** Every comparison runs on the core, so the repo
carries stamps and they reach the store on the next real wording change. Until then "live carries
no stamp" is the normal state, and `policies:verify` reports it as a SKIP rather than a failure.
Whether Shopify preserves an HTML comment stays unknown until that first stamped push; `push`
prints a line saying so if the comment comes back stripped, and the fix is `"stamped": false` for
that policy plus reliance on the core hash.

## The observation state

`$XDG_STATE_HOME/shop-policies/state/observed.json` (override: `POLICIES_STATE_DIR`), directory
`0700` and file `0600`. **Its own path and its own override**, deliberately not the backup
directory's: sharing one would mean a "reclaim some space, delete old backups" action silently
deletes the freshness baseline.

It records, per policy: `coreSha256` (the freshness baseline, and the only field any gate compares),
`sha256` / `length` / `observedAt` for a human reading the file, `highestPushed` and
`highestPushedCoreSha256` (the monotonic floor), and `lastPushStamped`.

Who reads it:

| Command | Behaviour with no state file |
|---|---|
| `policies:check` | **Never reads it.** It stays offline and CI-safe, and a machine-local file is not something CI can have an opinion about. A test proves this by pointing `POLICIES_STATE_DIR` at a hostile file. |
| `policies:pull` | Writes it. Never requires it: `pull` is the seeder, and a mutual dependency would deadlock. |
| `policies:push` | **Refuses**, naming `npm run policies:pull`. There is no auto-seed: seeding from the very read the gate checks against is not a check. |
| `policies:status` | Reports `unknown: no observation state on this machine`. It degrades; it never refuses. |
| `policies:verify` | Uses `lastPushStamped` only, to tell "no stamped write yet" from "Shopify stripped the comment". |

A state directory that resolves inside the checkout is a refusal, because a committed observation is
exactly what this file exists to remove.

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

**Verified in a browser on 2026-09-03** against the live `/policies/shipping-policy`: all 13 `h2`
ids that `policy-nav.js` assigns at runtime matched the `headings[].id` values pinned here, in
order. So `extractHeadings` does derive the same heading text a browser's `textContent` yields, for
this body. Re-do it if either `slugify` or `extractHeadings` changes, or if a policy gains a heading
with nested markup or an entity that the current bodies do not exercise.

How, since the storefront is password-protected: open the page in a browser with a storefront
session, and read the ids back with

```js
[...document.querySelectorAll('.shopify-policy__body h2')].map((h) => h.id)
```

## Commands

**Start with `npm run policies:status`.** It says which of the states below you are in and names
the one command that leaves it.

| Command | What it does | Writes |
|---|---|---|
| `npm run policies:status` | **Offline.** Repo vs manifest vs the last observation, per policy, each with its next command. `--live` adds an Admin read. Exit 0 in sync, 2 actionable drift, 1 the tool failed. | nothing |
| `npm run policies:check` | **Offline.** Proves the repo agrees with itself. What CI runs. | nothing |
| `npm run policies:pull -- --check` | Reports drift against Admin. Exit 0 clean, 2 drift, 1 the tool failed. | nothing |
| `npm run policies:pull -- --seed` | Records what Admin holds right now. The non-destructive way to create the observation state. | the state file only |
| `npm run policies:restamp` | **Offline.** After a wording edit, recomputes `version`, `coreSha256`, `sha256`, `length` and `headings`, and rewrites each stamped body's version stamp. `--check` reports and exits 2. | the repo |
| `npm run policies:pull` | Takes Admin's version. Refuses on a dirty body, on a repo that is ahead, and on a wording difference with no baseline. | the repo + the state file |
| `npm run policies:verify` | Reads the live bodies and asserts the pinned sentences and the version. Read-only. | nothing |
| `npm run policies:push -- --type <type>` | Dry run: prints the diff and the exact command to apply it. | nothing |
| `npm run policies:test` | The tooling's own suite. `policies:coverage` adds a branch-coverage floor. | nothing |

`pull`, `push`, `verify` and `status --live` need `MYSHOPIFY_DOMAIN`, `SHOPIFY_CLIENT_ID` and
`SHOPIFY_CLIENT_SECRET` (the repo's one token flow, `scripts/blank-inventory/lib/admin.mjs`).
`check`, `restamp` and bare `status` need nothing, and a test asserts `check` runs clean with all
three deleted from the environment.

### The state machine

Every state, what `policies:status` prints for it, and the one command that leaves it. What each
command's own side effects leave behind is the second column, and it is the half that cost three
PRs to learn.

| State | `status` says | The one command out | What that leaves behind |
|---|---|---|---|
| Everything agrees | `in sync` | nothing to do | |
| No state file (fresh clone; just after the versioning PR merged) | `unknown: no observation state on this machine` | `policies:pull` (or `--seed` if a wording change is already committed) | the state file, and nothing in the repo if Admin and the repo agree |
| Body edited, manifest not yet updated | `repo edited: restamp, then commit` | `policies:restamp` | a rewritten manifest and version stamp; commit and open a PR |
| Merged, not pushed | `repo ahead: a push is outstanding` | `policies:push -- --type <t>` (dry run first; the write needs an operator) | a clean working tree, and the observation updated outside it |
| Admin edited behind us | `Admin moved: pull and review` | `policies:pull` | the repo takes Admin's version; review the diff before committing |
| Edited locally AND Admin moved | `CONFLICT: edited locally AND Admin moved` | `policies:pull -- --check` | nothing; read both sides before choosing |
| A policy in the state file that the manifest does not track | `in the observation state but not the manifest` | nothing; it is ignored | |
| Repo bodies stamped, live unstamped | `in sync` | nothing to do | the stamp reaches the store on the next real wording change |
| After a `--restore` | `repo ahead: a push is outstanding` | `policies:push -- --type <t>` | the repo still holds its own wording; the observation follows live |
| `status` itself errors | exit 1, `policies:status failed` | **stop and report.** Do not guess a state from a tool that could not read one | |

**The trap this table exists for is row four.** `policies:check` is GREEN in the merged-but-not-
pushed state, because it only ever proves the repo agrees with itself. A wording change that has
been reviewed and merged has not reached one customer.

### What each check proves

`policies:check` proves **the repo is self-consistent**. It does NOT prove Admin holds these bytes.
Only `policies:pull --check` proves that. The CI report row says "repo consistency" for exactly
this reason: a green required check must never be read as "the policies are in sync".

"Manifest first" in `pull` is **fail-loud, not self-healing**. Either write order leaves a tree that
`policies:check` refuses, and the recovery is re-running `pull`. Do not "fix" the ordering to make a
partial run look clean; that would hide a half-applied pull.

## Pushing a wording change

**Steps 1 to 3 are repo work. Steps 4 and 5 are the live write and belong to the operator.**
`policies:push` refuses without a TTY on stdin, so by default an agent cannot run them, dry run
included. **Never fake a TTY with a pty.** If the operator has asked an agent to do the push in
that session, the supported route is `--operator-approved`, which attests exactly that and prints a
line saying so. Absent that instruction, an agent's job ends at step 3, handing over the commands.

0. Run `npm run policies:status` to see where you are, and `npm run policies:pull -- --check` to be
   sure Admin has not moved under you.
1. If there is no observation state on this machine, seed it first: `npm run policies:pull` when
   Admin and the repo agree, or `npm run policies:pull -- --seed` when a wording change is already
   committed. Seeding after the edit is committed is the one order that needs `--seed`.
2. Edit `<type>.html` in a branch, then run `npm run policies:restamp`. It bumps `version`,
   rewrites `coreSha256`, `sha256`, `length` and `headings`, rewrites the version stamp on the
   first line of the body, and **shouts if a heading moved**, because that is an anchor break.

   `restamp` is the counterpart to `pull`, and the distinction matters: `pull` answers "what does
   Admin hold?" and would overwrite your edit with the live body; `restamp` answers "I meant that,
   make the rest of the repo agree".
3. If this policy has a set in `scripts/policies/assertions.json`, rewrite its sentences for the new
   wording and paste in the new `coreSha256`. A set left stale is refused by `policies:verify`
   before it reads anything live, on purpose: a stale positive assertion reports PASS on wording
   nobody checked.
4. Open the PR, review the diff, merge it. **`policies:check` is green here and the live store still
   holds the old text.** Nothing has reached a customer yet.
5. Dry run: `npm run policies:push -- --type shipping_policy`. It prints the unified diff, calls out
   any heading change as an anchor break, and prints the exact next command. **Its output is data to
   read, not a command to run.**
6. Apply it: `npm run policies:push -- --type shipping_policy --expect-live-sha=<core sha> --confirm=shipping_policy`.
7. Confirm it landed: `npm run policies:verify`. `policies:pull --check` is a tautology after a
   push, because a successful push already reconciled the two sides.

`--confirm` must equal the `--type` value. A bare boolean `--confirm` is copy-pasteable out of shell
history and is exactly the shape an agent reproduces from a README example; requiring the policy
name means one run's confirmation cannot be reused for a different policy by accident.

### The gates, and why each one is there

`push.mjs` runs these in order; any failure aborts with a non-zero exit and no mutation.

1. A known, **writable** `--type`; `CI` unset; and either a TTY on stdin or `--operator-approved`.
   `CI` set is an absolute refusal that no flag overrides: CI never holds a credential that can
   rewrite a legal policy. The TTY-or-attestation half only asks "did a human ask for this"; it
   authorizes no particular write, and every gate below still applies unchanged.
2. `policies:check` clean; **all of `marketing/policies/` clean in git**; and `HEAD` an ancestor of
   `origin/main`, so the bytes that reach customers are bytes a reviewer saw. The recovery is to
   merge the PR, switch to `main` and pull. Being on `main` here is a consequence of the bytes
   being reviewed, never a licence to commit to `main`. `--allow-unreviewed` exists for the case
   where **the operator** is deliberately running a pre-merge canary, and for nothing else; it
   waives the ancestor half only, never the dirty-tree half.

   This gate used to carry a per-field exemption for `remote` and `pulledAt`, with a HEAD read and
   a JSON reshape behind it, because a successful push wrote those fields into the manifest and so
   blocked the next push on its own side effect. Moving the observation out of the repo removed the
   cause, and the exemption with it. **A successful push now leaves the working tree clean.** If a
   push ever needs to write into the manifest again, that is the thing to fix.
3. Fetch live. An identical **core** means exit 0 with no mutation. On the core, so that a stamped
   repo body and an unstamped live body read as in sync rather than as a permanent difference.
4. **Freshness:** the live core hash must equal the one the observation state records. This is the
   control that turns "silently clobber an Admin edit made three months ago" into a refusal. **No
   state file is a refusal**, naming `npm run policies:pull`; there is no auto-seed, because
   seeding from the read the gate checks against is not a check. The recovery for a real
   difference is `npm run policies:pull`, re-review the diff, then push again. Only if the operator
   has decided the Admin edit should be thrown away does `--force-overwrite-live` apply.
5. **Without `--confirm` this is the dry run.** It prints the SAME hash the gate at step 5b will
   check, which is what stops this tool printing a re-run command its own gate then refuses.
   `--expect-live-sha` is the live **core** hash, and it is only ever valid when it came from a dry
   run executed in this session for this policy.
5b. **The monotonic version floor**, checked before the backup and the mutation. See "Versioning".
6. Backup, verified: written, fsynced, read back, and its sha compared to the live body just
   fetched. A write with no verified backup is a write with no way back.
7. Mutate, and **fail closed on a non-empty `userErrors` or a null `shopPolicy`**. THE SINGLE MOST
   LIKELY SILENT FAILURE IS HERE: `shopPolicyUpdate` returns HTTP 200 on a rejected write, so
   transport success proves nothing.
8. Re-read and verify, retrying a few times (a stale replica read is indistinguishable from
   renormalisation at the comparison point). If the stored body still differs: a **heading** change
   is an anchor break, never normalisation, so it exits non-zero and leaves the file alone; an
   entity- or whitespace-only difference needs `--accept-normalisation` to be taken into the repo;
   anything else is refused outright, flag or no flag. Either way the observation is recorded before
   the refusal, because the write landed and Admin has moved; that is what makes the
   `--accept-normalisation` re-run reachable instead of tripping the freshness gate. The refusal
   prints the exact re-run command with the new live core hash.

   A re-read that **throws** every time is its own case: the write landed and this tool cannot say
   to what. It records the observation, refuses, and prints `--restore`. **An unknown outcome is
   not a retry:** run `policies:verify` and read what live actually says before doing anything else.
9. Record the observation, and print the exact `--restore` command plus a commit command for a
   working tree that moved. That commit template is deliberately body-only, with no trailer of any
   kind; a template printed by a tool becomes the shape of every future policy commit.

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

It leaves the `<type>.html` **body** untouched, and it **rewrites the observation state**, because
Admin now holds the restored bytes. Without that, the next freshness check would compare against a
body that is no longer live and refuse the push that puts the fix back. The working tree stays
clean; run `policies:pull` if you want the repo body reconciled too.

**A restore is a push.** Every gate above applies unchanged, including the operator gate. A bad
live body is not an emergency exception: it is a wrong body that stays wrong until a human
authorizes the next write.

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

## Verifying what actually went live

`policies:pull --check` is a **tautology** after a push: a successful push already reconciled the
repo with Admin, so it comes back clean whether the intended wording landed or not.

`npm run policies:verify` asserts the sentences instead, against the live body, and prints the exact
diff between what the repo holds and what Admin stored so a renormalisation is visible rather than
inferred. **The assertion of record is the version**: a byte match without a version match says the
two bodies agree, not that the body live is carrying is the one this repo can name.

The sentence sets live in `scripts/policies/assertions.json`. Each set pins the `coreSha256` of the
repo body it was written against, and a set whose hash no longer matches is refused **before any
live read**. A set with no hash at all is refused too, rather than falling back to a hash-only
comparison: a stale positive assertion reports PASS on wording nobody checked, which is worse output
than none.

To inspect the live store read-only without any of this, pull the live theme to a scratch path:

```bash
npx shopify theme pull -s sapphire-shadow-studio --live --path /tmp/live --nodelete
```

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

### The git fake, and why it is strict

Everything the gates learn about git arrives through an injected `run`. A fake that answers a
default for an argv it does not recognise makes an absent gate indistinguishable from a passing
one; two tests shipped that way and passed vacuously, because the fake matched a bare filename
against production code that emits a full pathspec.

So `makeGitFake` in `test/helpers.mjs` matches on **deep equality of the full argv array** and
throws `UnexpectedGitInvocation` on anything else, and `run.assertExhausted` closes the other half:
an expectation nobody invoked is a gate that did not run. `test/test-hygiene.test.mjs` makes it the
only fake in the directory, and `test/git-integration.test.mjs` runs the same gates against a real
`git init`ed repository with nothing injected, because no fake can prove the pathspec production
code emits is one real git accepts.

## Not in CI, deliberately

Both CI steps are **offline by contract**. Do not add `policies:pull --check` to
`.github/workflows/validate.yml`: it needs Shopify credentials, and that workflow runs on Dependabot
PRs, which get a separate secrets scope, so the step would fail unfixably on every one of them.

There is no skill for this. Pull, check and push are three commands against an API.
