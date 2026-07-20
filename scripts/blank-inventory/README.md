# scripts/blank-inventory/

Tooling for shared-blank stock and the `custom.inventory_blank_sku` variant metafield. **This writes
to the live store.** Read [`../../docs/blank-inventory-sync-flow.md`](../../docs/blank-inventory-sync-flow.md)
first; it is the source of truth for the Flow this tool cooperates with.

The `blank-inventory` Claude skill (`.claude/skills/blank-inventory/`) drives these commands and
holds the human-approval gates. These scripts are what it runs.

## The problem

Several products are printed on the same physical blank garment. Shopify cannot share one inventory
pool across variants with different SKUs, so a Shopify Flow mirrors the quantity across every variant
carrying the same `custom.inventory_blank_sku` value. That works, but feeding it by hand (typing
quantities variant by variant, tagging every new variant) is tedious and silently failure-prone.

## The garment body axis

A blank is a **physical garment**, not a colour+size. The catalogue has several bodies (crewneck,
quarter-zip, women's vest); two products on different bodies share no stock even at the same colour
and size, which is why a count sheet has one table per body. Every blank is keyed on
**body+colour+size**. No Shopify field carries the body, so the tool infers it and the operator
approves the guess; the approved map is hashed and authoritative, and is a precondition of every
other command.

## Commands

```bash
# Propose a body per product (no Shopify writes; writes a proposal file), then approve the hashed
# map. Run this FIRST; every other
# command refuses without it. A product added later is refused on writes until you re-propose.
node scripts/blank-inventory/blank-inventory.mjs bodies --stage propose
node scripts/blank-inventory/blank-inventory.mjs bodies --stage approve   # after editing the proposal
node scripts/blank-inventory/blank-inventory.mjs bodies --stage show      # the approved map

# Health report (no Shopify writes). Start here every time once bodies are approved.
node scripts/blank-inventory/blank-inventory.mjs audit

# Turn an adjustments CSV into a reviewable, hashed plan artifact. No Shopify writes.
node scripts/blank-inventory/blank-inventory.mjs plan --input counts.csv --mode absolute

# Execute an APPROVED artifact. --dry-run prints the writes without making them.
node scripts/blank-inventory/blank-inventory.mjs apply --plan <workdir>/plan-<id>.json

# Poll the affected groups until the Flow settles. --timeout-ms overrides the 300000ms default
# (stale is reported at 3 minutes; polling continues to 5).
node scripts/blank-inventory/blank-inventory.mjs verify --receipt <workdir>/receipt-<id>.json [--timeout-ms 300000]

# Tag untagged variants, then seed them so the Flow propagates. Two separate approvals.
# `propose` WRITES a proposal file (it is Shopify-write-free, not read-only).
node scripts/blank-inventory/blank-inventory.mjs backfill --stage propose
node scripts/blank-inventory/blank-inventory.mjs backfill --stage tag  --plan <workdir>/backfill-<id>.json
node scripts/blank-inventory/blank-inventory.mjs backfill --stage seed --plan <workdir>/backfill-<id>.json

# Mint a NEW blank id onto a scoped set of untagged variants (the bootstrap escape hatch).
# Scoped to one product, capped, and refuses to overwrite an existing family's stock.
node scripts/blank-inventory/blank-inventory.mjs backfill --stage propose --blank BLACK_CREWNECK_0001_M --product lead-ii-crewneck

# Remove variants from a group (metafield first; see the interlock below).
node scripts/blank-inventory/blank-inventory.mjs untag --variant gid://shopify/ProductVariant/123
```

Env: `MYSHOPIFY_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`. The working directory (plan
artifacts, receipts, the body map) defaults **outside the repo** at `~/.local/state/blank-inventory/`
(override with `BLANK_INVENTORY_DIR`); it holds real blank ids, so it must never sit inside this
public checkout. A stray `.blank-inventory/` in the tree makes the tool warn and refuse writes until
it is moved.

## Input format

`--mode` is required. There is no default and no per-row inference, because reading `12` as a count
when it meant `+12` silently destroys stock and the two are the same characters.

The canonical shape is `body,color,size,value` with an optional `raw` column (the token exactly as
written on the source, so the confirmation table is generated from the file rather than re-rendered).
A header row is required, or pass `--format body-color-size`. The shape is never inferred from the
column count: two layouts with the same arity mean opposite things.

```csv
# absolute: a count sheet
body,color,size,value,raw
crewneck,Black,M,14,14
vest-womens,Grey Heather,2XL,3,3
```

```csv
# delta: a receiving slip. Signs are REQUIRED; an unsigned value is refused.
body,color,size,value
crewneck,Black,M,+12
crewneck,Black,L,-3
```

`blank,value` also works (pass `--format blank`) if you have the blank id to hand. One mode per run,
so a mixed sheet is two runs. Duplicate rows for the same body+colour+size are refused rather than
summed or last-wins: a double-counted row and a running total look identical here. Two rows that
differ only by body are **not** duplicates; they are the normal multi-garment case.

The parser also cross-checks the declared mode against the source (signs, arrows, and headings like
"received" or "on hand") and stops on a contradiction or on ambiguity.

## The four mechanics

Each was established by testing against the live store, and each is load-bearing. The rationale is in
the module headers; the short version:

1. **One write per group, on a mismatched member.** The Flow fans the change out, so writing every
   variant is redundant in absolute mode and destructive in delta mode (`+12` across 10 siblings is
   `+120`). And a write to a member that *already holds the target* returns
   `inventoryAdjustmentGroup: null`, fires no trigger, and strands the stale siblings. Taking
   `members[0]` is the obvious implementation and it is wrong.

2. **Tagging is inert; backfill needs a seed write.** `metafieldsSet` fires no inventory event, so on
   a quiet group a freshly tagged variant sits at 0 indefinitely. Observed live: 150 seconds, no
   movement. That is why `backfill` has a separate `seed` stage.

3. **Quiesce before backfilling.** Tagging never triggers the Flow, but any inventory event in that
   group sweeps in whatever is tagged at that moment, including the Flow's own self-retriggering
   cascade. Backfilling mid-cascade gives nondeterministic partial convergence.

4. **Compare-and-swap on every write.** This is what makes a retry safe: an already-applied row's
   baseline no longer matches, so the repeat is refused rather than applied twice. The API also
   requires an `@idempotent(key: ...)` on both inventory mutations, and the key is derived from the
   plan artifact to keep a plan reproducible, but **key collapse is not a safety property here**:
   tested live, an identical repeat about two minutes later was processed as a new call and stopped
   by CAS, not deduplicated.

## The untag interlock

Removing a variant from a group **deletes the metafield first**, confirms the deletion with a
re-read, and only then writes a quantity.

Reversing that order is destructive: zeroing a variant that is still tagged fires the trigger and
propagates 0 across the entire blank group, wiping real stock on every sibling. The re-read is not
belt-and-braces; a silently failed delete followed by a zeroing write is exactly that scenario.

## Safety properties

- **`apply` takes only a plan artifact.** It refuses `--input`/`--mode`, and it verifies the
  artifact's hash. Write-target selection is state-dependent, so an apply that re-derived from live
  state could pick a different variant than the one that was approved, and compare-and-swap would
  not catch it (CAS guards the value on a variant, not the choice of variant).
- **Fails closed on drift.** If the store moved such that the approved target is no longer the right
  variant, or its baseline changed, that row is refused and a re-plan is demanded.
- **Per-row continue-on-error.** One group's failure never abandons the rest.
- **Incremental atomic receipts.** A crash leaves a parseable, resumable record. A half-applied run
  never looks finished. Re-run with `--resume`.
- **A pidfile lock** prevents concurrent writes, and is reclaimed automatically if its holder died.
- **A pre-run snapshot** of every affected group is written into the receipt.

## Tests

```bash
npm run blank-inventory:test    # unit only, no network, no store
npm run blank-inventory:guard   # no real blank id may be committed
```

Both run in CI on every PR. The unit suite covers the decision boundaries that are easy to get
silently wrong: write-target selection, the all-match skip, drift refusal, partial-run receipts,
idempotency key stability *and* distinctness, the mode cross-check (including cases that must NOT
false-stop), convergence polling against a racing cascade, and the untag interlock.

**The live end-to-end checks are operator-invoked by hand and are deliberately not wired into any
npm script.** A CI job writing production inventory from a public repo is the failure that
separation exists to prevent.

## Sensitive data

A blank id is **sensitive if any segment encodes a supplier name or style number**; garment, colour
and size segments are not. Legacy supplier-encoded ids must never be committed. A garment-coded id
under the new scheme (`BLACK_CREWNECK_0001_M`) is safe to write down, which is why the migration
targets that format. If you cannot tell what a segment encodes, treat the id as sensitive.

The vocabulary is **learned from the live store at runtime and never committed**; a body+colour+size
with no precedent is refused rather than guessed. Test fixtures use synthetic ids, and
`check-no-real-blank-ids.mjs` fails CI on any blank-id-shaped token carrying a segment outside a
known-synthetic, garment, colour, or size vocabulary. Its detection rests entirely on supplier
**name** tokens (numeric style segments are exempt), so the allowlist must never gain a word that
could be a company name.
