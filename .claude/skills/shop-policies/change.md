# Changing policy wording

Repo work only. Nothing here touches the live store, and finishing everything on this page leaves
the live store holding the OLD text.

## Seed the baseline first

If `policies:status` says `unknown: no observation state on this machine`, the machine has no
record of what Admin was last seen holding, and `policies:push` will refuse until it does. Fix it
before editing, not after:

```bash
npm run policies:pull            # repo and Admin agree: this is a no-op on the wording
```

If a wording change is ALREADY committed and unpushed, a bare pull would take Admin's version and
revert it. Use the seeder instead, which writes the state file and not one byte of the repo:

```bash
npm run policies:pull -- --seed
```

## 1. Preflight

```bash
npm run policies:pull -- --check
```

Exit 0 means Admin has not moved under you. Exit 2 means it has, or the repo is ahead; read what it
printed and route with `policies:status` rather than pulling reflexively.

## 2. Edit the body

Edit `marketing/policies/<type>.html` on a branch, in the ordinary way.

**Do not hand-edit the first line.** `<!-- sss-policy <type> vN -->` is the version stamp, and
`restamp` owns it. Do not hand-edit `version`, `coreSha256`, `sha256`, `length` or `headings` in
`manifest.json` either; all five are derived, and `policies:check` refuses a manifest that
disagrees with its own body.

Hygiene, all fail-closed: no carriage returns, no byte-order mark, no `<script>` or `<style>` tag,
and **no em dash in any form** (`U+2014`, `&mdash;`, `&#8212;`, `&#x2014;`). An en dash is fine.

## 3. Restamp

```bash
npm run policies:restamp
```

It bumps `version`, rewrites both hashes, `length` and `headings`, and rewrites the version stamp on
the body's first line.

**If it prints `ANCHOR CHANGE`, stop and read it.** A reworded `h2` changes the id
`assets/policy-nav.js` assigns at runtime, and every `/policies/...#anchor` link anyone has already
been sent stops resolving. Silently. Search the repo for the old anchors before committing, with the
command it prints, and tell the operator which links break. That is a decision for them, not a
warning to note and move past.

## 4. Rewrite the assertion set, if this policy has one

`scripts/policies/assertions.json` pins, per policy, the sentences that must and must not appear in
the LIVE body, plus the `coreSha256` of the repo body they were written against.

If the policy you edited has a set, rewrite its sentences for the new wording and paste in the new
`coreSha256` from `manifest.json`. `policies:verify` refuses a stale set before it reads anything
live, on purpose: a stale positive assertion reports PASS on wording nobody checked.

Each string must DISCRIMINATE. A phrase that appears in both the old and the new wording proves
nothing; quote enough surrounding markup to be unique to the new text, and put the old wording's
distinctive strings in `mustNot`.

## 5. Check, then the ordinary PR flow

```bash
npm run policies:check
```

Then commit, open the PR and merge it the way any change in this repo lands. That flow is not
restated here.

## What a merged wording change does NOT mean

**It has reached no customer.** `policies:check` is green in this state and proves only that the
repo agrees with itself. The live store still holds the old text, and it will keep holding it until
someone runs a separately authorized `policies:push`.

`policies:status` will now say `repo ahead: a push is outstanding` for that policy. That is the
correct end state for repo work. Hand over to the operator with the dry-run command, and read
`push.md` before running anything past it.
