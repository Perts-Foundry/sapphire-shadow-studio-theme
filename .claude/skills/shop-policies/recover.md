# Recovery

**A restore is a push. All five absolutes apply unchanged. There is no emergency exception, and a
bad live body is not an emergency: it is a wrong body that stays wrong until a human authorizes the
next write.**

Read `push.md` before running anything on this page that writes.

Five entry points, in the order you are most likely to need them. The first two are the states
`policies:status` names; the rest are what a push can leave behind. Find the one matching what you
are actually looking at.

---

## You are here if `policies:status` says `Admin moved: pull and review`

Someone edited the policy in Shopify Admin since this machine last observed it. The repo has not
moved; Admin has.

1. See what changed, without writing anything:

   ```bash
   npm run policies:pull -- --check
   ```

2. Show the operator the diff. Whose text should win is their decision, not yours.
3. If Admin's version should win:

   ```bash
   npm run policies:pull
   ```

   This overwrites the committed body with Admin's. It refuses if the body is dirty in git; commit
   or stash first rather than reaching for `--discard-local`.
4. Commit the result through the ordinary PR flow. Admin's edit is now the repo's text, and the
   diff is what a reviewer sees.

If the repo's version should win instead, this is not a pull at all: it is an outstanding push, and
`push.md` is the page.

---

## You are here if `policies:status` says `CONFLICT: edited locally AND Admin moved`

Both sides moved. **Nothing here resolves that automatically, and nothing should.** Two different
people wrote two different legal texts.

1. Read both, writing nothing:

   ```bash
   npm run policies:pull -- --check
   npm run policies:verify
   ```

2. Present both versions to the operator with the diff, and say plainly that taking either one
   discards the other.
3. Whichever they choose, it lands the ordinary way: a merge of the two texts, edited by hand into
   `marketing/policies/<type>.html`, restamped, reviewed in a PR, then pushed. Do not use
   `--discard-local` or `--force-overwrite-live` to "resolve" it; those throw one side away without
   a diff anyone reviewed.

---

## A push landed the wrong body

Every push prints its own `--restore` command, naming a backup that was written, fsynced and read
back before the mutation. Backups live outside the checkout at
`$XDG_STATE_HOME/shop-policies/`, because the repo is not an adequate backup: `HEAD~` matches live
only if nobody edited the policy in Admin since.

Dry run it first, exactly like any other push. Without `--confirm` it prints the diff and the
command to apply it, `--expect-live-sha` included:

```bash
npm run policies:push -- --restore <backup file>
npm run policies:push -- --restore <backup file> \
  --expect-live-sha=<core sha from that dry run> --confirm=<type>
```

`--expect-live-sha` is required on a restore too. The restore skips the repo gates and the freshness
gate; it does not skip the "you are overwriting exactly what you think you are" gate.

This is a push. It needs a fresh operator ask, quoted verbatim, exactly like any other. It leaves
the repo body untouched and rewrites the observation state, so `policies:status` will then say a
push is outstanding, which is correct: the repo still holds the wording that was wrong to send.

If no backup exists for what you need, say so. Do not reconstruct a body from a diff and push that.

---

## A push did not return a readable result

A timeout, a killed process, a lost connection, an ambiguous error, or the tool's own message
saying the live body could not be read back.

**Do not re-run the push.** The write may have landed. Re-running is how one ambiguous outcome
becomes two.

1. Find out what is actually live:

   ```bash
   npm run policies:verify
   ```

2. Report what it says, in full, to the operator.
3. Anything after that is a new decision needing a fresh dry run and a fresh ask.

---

## `policies:status` itself failed

Stop and report. Print what it said and what you were about to do. A tool that could not read a
state has told you nothing, and choosing a recovery anyway means guessing about a legal document.
