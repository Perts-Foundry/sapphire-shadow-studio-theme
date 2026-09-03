# Verifying what actually went live

## `policies:pull --check` is a tautology here

A successful push already reconciled the repo with Admin, so `pull --check` comes back clean whether
the intended wording landed or not. It answers "do the two sides agree", which after a push is a
question with a foregone answer.

## The command

```bash
npm run policies:verify
```

Read-only, through the read-only Admin client, which refuses any document containing a mutation
before it reaches the network.

For each policy it prints the pinned sentence assertions from `scripts/policies/assertions.json`,
the version assertion, and a core-hash comparison against the repo body with a unified diff when
they differ.

## The assertion of record is the VERSION

A byte match without a version match says the two bodies agree. It does not say that the body live
is carrying is the one this repo can name, and that is the entire reason the version stamp exists.

Four outcomes, and they are not interchangeable:

| Line | What it means |
|---|---|
| `PASS live carries the version stamp this repo names` | verified |
| `FAIL live carries vN, the repo names vM` | someone else pushed, or a push landed that this session does not know about |
| `SKIP no stamped write has happened from this machine yet` | normal until the first stamped push; not a failure |
| `FAIL a stamped body was pushed from this machine and live carries no stamp` | Shopify strips HTML comments. Set `"stamped": false` for that policy in `manifest.json`, restamp, and rely on the core hash from then on |

The SKIP and the last FAIL look identical on the wire and need opposite actions. `verify` tells them
apart using `lastPushStamped` from the machine-local observation state.

## Stale assertion sets are refused, before any live read

Each set in `assertions.json` pins the `coreSha256` of the repo body it was written against. A set
whose hash no longer matches is refused, and so is a set with no hash at all. There is no fallback:
a stale positive assertion reports PASS on wording nobody checked, which is worse output than none.

The fix is to rewrite the sentences for the current wording and paste in the new hash. It is not to
delete the hash, and it is not to delete the set unless the sentences genuinely no longer apply.

## The sanctioned read-only ways to look at live

- `npm run policies:verify`
- `npm run policies:pull -- --check` (drift only, in both directions)
- `npm run policies:pull -- --seed` (records what Admin holds; writes nothing in the repo)
- `npx shopify theme pull -s sapphire-shadow-studio --live --path /tmp/live --nodelete`

Never bare `npm run policies:pull` to satisfy curiosity. It is the destructive direction.
