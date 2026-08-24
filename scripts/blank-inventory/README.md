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
# It also archives expired seeding receipts (see below); that is a move inside the working
# directory, not a store write.
# --json emits the whole report (catalogue, coverage, groups with per-group histograms and member
# labels, warnings, what the archive step did) as one object. --group narrows to one blank and
# --stale to the non-converged ones; they are different views, so passing both is an error.
# The histogram is the reading that matters, and it is in the human output too: `quantities` is
# deduped, so [0, 2] cannot tell one member at 0 from seven of them, and those are opposite
# situations.
node scripts/blank-inventory/blank-inventory.mjs audit
node scripts/blank-inventory/blank-inventory.mjs audit --json
node scripts/blank-inventory/blank-inventory.mjs audit --group BLACK_CREWNECK_0001_M
node scripts/blank-inventory/blank-inventory.mjs audit --stale

# Reorder review (no Shopify writes, and it never edits thresholds.json). On-hand stock per
# body/colour/size against the committed minimums, a reorder list sorted by shortfall, and
# per-body totals of on-hand against minimum units.
# --below prints only the list; --body narrows to one garment; --json emits the whole report.
node scripts/blank-inventory/blank-inventory.mjs reorder
node scripts/blank-inventory/blank-inventory.mjs reorder --body crewneck --below
node scripts/blank-inventory/blank-inventory.mjs reorder --json

# Net units sold per body/colour/size over a window, and the threshold adjustments that implies.
# Read-only: it prints a from -> to list for the operator, and edits nothing. Needs read_orders.
node scripts/blank-inventory/blank-inventory.mjs demand
node scripts/blank-inventory/blank-inventory.mjs demand --days 30 --json

# The resolvable key space: which body+colour+size combinations have a blank id, in the store's own
# spellings. No Shopify writes.
node scripts/blank-inventory/blank-inventory.mjs vocab

# Check a transcription BEFORE planning it. Exits non-zero if any row cannot resolve, and names the
# store's spelling when one is close ("Navy" -> "Classic Navy"). It never substitutes: a near match
# is a different physical blank, so only the operator may act on a suggestion.
# Pass the SAME --mode and --format the plan will use; both go to the same parser, and checking
# under different ones checks a different file.
node scripts/blank-inventory/blank-inventory.mjs vocab --check counts.csv --mode absolute

# Turn an adjustments CSV into a reviewable, hashed plan artifact. No Shopify writes.
# Refuses while ANY group is non-uniform, whatever its state: "awaiting-seed" explains why a group
# is non-uniform, it never makes it plannable.
node scripts/blank-inventory/blank-inventory.mjs plan --input counts.csv --mode absolute

# Render an artifact for the approval gate. Refuses a hand-edited artifact (the hash check) and one
# missing any key the gate needs, rather than printing a blank cell where a write target belongs.
node scripts/blank-inventory/blank-inventory.mjs show --plan <workdir>/plan-<id>.json

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

Env: `MYSHOPIFY_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, from the repo-root `.env`
via `node --env-file=.env ...` (see [`../README.md`](../README.md) > Credentials). The working
directory (plan
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

## The reorder review

`reorder` answers "where are we thin, and what should I order". It pivots the tagged catalogue into
one colour x size matrix per garment body and compares each cell against
[`thresholds.json`](thresholds.json), a committed table of recommended minimum on-hand quantities.
`demand` is the recalibration pass: it reads recent orders and proposes new minimums.

**Both are read-only, and neither edits `thresholds.json`.** That file is generated once, reviewed in
a PR, and afterwards hand-edited only behind an operator approval. A command that quietly adjusted a
threshold to make its own report pass would destroy the only review surface this feature has.

### thresholds.json

One entry per body+colour+size, holding the resolved minimum. The curves and the budgets it was
derived from are kept as provenance, but the **cells are the source of truth**, because the cells are
what a PR diff shows: a reviewer can judge "crewneck black M: 6" where two curves plus a budget plus
a rounding rule is four things to re-derive by hand.

**The budget is one number per garment body**, and both splits below it are derived. A colour
popularity curve splits the body's budget across colours, then a size curve splits each colour's
share across sizes; both stages use largest-remainder rounding, so a body's cells sum to its budget
exactly with nothing leaking between the stages. Colour is derived rather than stated for the same
reason size is: a hand-entered per-colour budget would be a second source of truth for a number the
curve already determines, and the two would drift with nothing reconciling them.

Keys are the normalised vocabulary form (lowercase `body|color|size`), the same key `vocabKey`
produces, and budgets are keyed by the normalised body. A key that is not already in normalised form
is **rejected, not normalised**: two spellings of one cell would silently become two minimums for one
physical blank.

`provenance.adjustments` is append-only. An entry records the date, the window it came from, a note,
and the per-cell `from`/`to` moves. Entries are never rewritten, reordered or edited, even to correct
one; a correction is a new entry.

### The loud-failure contract

| Condition | `reorder` | `demand` |
|---|---|---|
| a body+colour+size with no entry | **exit 1**, naming every missing key | **exit 1** |
| file missing, unparseable, or wrong version | **exit 1** | **exit 1** |
| a duplicate cell or budget key in the raw text | **exit 1**, naming the key | **exit 1** |
| an entry for a body/colour/size the store no longer has | warning, exit 0 | warning |
| a garment body with no budget | warning, exit 0 | **exit 1** |
| a cell below its minimum | listed, exit 0 | n/a |
| a cell with a minimum but no blank group | listed with `!`, exit 0 | held |

A missing entry is a refusal because that is how a new body, colour or size surfaces at all: nothing
else in the pipeline notices one. A combination that is not made gets an explicit `min: 0` with a
note; it never gets left out. Refusals are global and are computed **before** anything renders, so
`--body` and `--below` cannot narrow a report past the gap that made it untrustworthy. Under `--json`
a refusal emits `{error, keys, refusals}` and still exits 1.

Duplicate keys are detected in the raw text rather than after `JSON.parse`, which is last-wins and
silent: a bad merge leaving two entries for one cell parses cleanly and applies the minimum nobody
reviewed.

### Reading the matrix

```
  crewneck
    Black            XS:2/1  S:9/6  M:4-11/15?  L:14/17*  XL:12/12  2XL:--/6!
```

`on-hand/minimum` per size. `*` is below the minimum. `?` is a group the Flow has not settled yet, so
the member **range** is shown and never an average: averaging invents a number no variant holds. An
unsettled cell is flagged only when even its highest member is below the minimum, because otherwise
every group mid-fan-out reports a shortfall and the report cries wolf during normal operation. `!` is
a cell with a minimum and no blank group at all; it stays exit 0 (`audit` owns group health) but it
is always in the reorder list, and the counts of `?` and `!` cells are printed in both the full and
the `--below` view so a terse read cannot hide them.

The reorder list is sorted by shortfall descending, ties breaking on body, colour, then garment size
order, and the shortfall is the leading column because it is the number the list is read for. A
negative on-hand (Shopify permits an oversell) yields an unclamped shortfall.

### Per-body totals

After the list, `reorder` prints on-hand units against minimum units per garment body, with the
shortfall and the surplus counted separately rather than netted, and the same figures go into
`--json` under `totals`. A body that is short with no surplus needs more units; a body with both is
holding roughly enough units in the wrong sizes or colours, and that is a different decision. The
sums cover only cells whose group has settled: a cell mid-fan-out has a range and not a reading, and
a cell with no blank group has no stock at all, so both are excluded and counted instead, with the
counts printed alongside so an excluded cell cannot read as a zero.

These sums are deliberately not the reorder list's total. The list also carries cells with no group
(at their full minimum) and unsettled cells (measured from their highest member), which is right for
"where do I look first" and wrong for "how does this body's settled stock compare with its settled
minimums".

### The demand model, and what it is not

`demand` redistributes a garment body's **current** budget across its colour x size cells in
proportion to recent net units sold, using largest-remainder rounding so the proposals sum to the
budget exactly. It recalibrates the colour mix as well as the size mix, because both were derived
from a curve: a pass that only reshuffled sizes would leave the colour split on its original guess
forever. There is no lead-time term, no safety stock, no seasonality and no growth assumption. It is
one input to an operator decision, not a reorder quantity.

Net units means refunded and removed units are subtracted, cancelled and test orders are excluded,
and a line item whose variant is gone or untagged is reported in an `unattributed` bucket rather than
dropped. Both connections are paginated, orders and each order's line items, because a truncated read
looks exactly like an order that sold less.

Two holds keep the model from ratcheting a blank out of existence. A body with almost no observed
sales holds every one of its minimums, and a cell whose on-hand sat at or below its own
minimum (or has no settled reading at all) is held and excluded from the redistribution: it could not
have sold what it might have, so its zero is not evidence of zero demand.

**Limitations, stated because none of them are visible in the output:**

- `read_orders` reaches about 60 days, which is why the default window is 60 days. A longer window
  needs `read_all_orders`; `demand` **refuses** a window its granted scopes cannot serve rather than
  quietly shortening it, and it always prints the earliest order date actually returned. Both scopes
  are granted on this app today, so a longer `--days` is available, but the refusal stays in place
  because a grant can be narrowed later and a silently shortened window is not a visible failure.
- Sales are attributed through the **current** variant-to-blank mapping, so re-tagging a variant
  rewrites its own history.
- **The non-empty path is still unexercised.** `demand` has been run against the live store: it
  authenticated, paginated, and reported zero orders in the window, because the storefront is still
  password-gated. So the query, the scope gate and the insufficient-data holds are confirmed live,
  but no run has yet aggregated a real line item. The arithmetic is unit-tested and the queries are
  validated against the Admin schema; treat the first run with real orders as the check that has not
  happened.

### Sensitive data in thresholds.json

The committed values are unit counts the operator chose, and the keys are garment vocabulary, so the
file is safe in a public repo. What must never go into it, or into a PR body that touches it: supplier
or wholesaler names, vendor SKUs, case-pack sizes, unit or wholesale costs, contract minimums, lead
times, supplier URLs, dollar amounts of any kind, and anything order-derived that identifies a
customer or a single order. Demand data enters the file only as an aggregate. The file joins the
pre-push sensitivity scan.

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
- **`plan` refuses any non-uniform group, whatever its state.** `awaiting-seed` explains *why* a
  group is non-uniform; it never makes it plannable. Keying this on `drift` alone was a hole: a
  group stranded mid-fan-out is normally `awaiting-seed`, so it passed the check and then failed
  deeper in as a per-line parse error for a store-state problem.
- **Seeding receipts age out, and `audit` archives them.** A seed settles in 80 to 90 seconds, so a
  `--stage tag` receipt older than 24 hours stops suppressing a drift report. Without the bound, one
  abandoned tag stage masked every later Flow fault on those groups as expected behaviour. `audit`
  moves the expired ones into `<workdir>/archive/` and reports a one-line summary (count, date
  range, destination) instead of listing them: 78 filenames printed one per line buried the report
  that named them. Archived receipts are inert, because the reader globs the working directory root
  and does not recurse, and the move is one-way, so reverting the code does not put them back. Fresh
  seeding receipts are never archived: they are the only thing distinguishing awaiting-seed from
  drift. A file that cannot be moved is reported and skipped, never fatal, and a name already in the
  archive keeps the archived copy (a receipt is immutable, so the same name is the same content).
- **The approval-gate renderer refuses an incomplete artifact.** `show --plan` errors on a missing
  or renamed key instead of rendering a blank cell, so a schema change cannot silently produce an
  emptier gate that still looks like a review.

## Tests

```bash
npm run blank-inventory:test    # unit only, no network, no store
npm run blank-inventory:guard   # no real blank id may be committed
```

Both run in CI on every PR. The unit suite covers the decision boundaries that are easy to get
silently wrong: write-target selection, the all-match skip, drift refusal, partial-run receipts,
idempotency key stability *and* distinctness, the mode cross-check (including cases that must NOT
false-stop), convergence polling against a racing cascade, the untag interlock, the near-match
suggestion that must never be substituted, seeding-receipt expiry (including the unparseable
timestamp, which expires rather than being believed forever), and the refusal to render a plan
artifact missing a gate-critical key.

The receipt archive step has a suite of its own against a real temporary working directory
(`test/archive-receipts.test.mjs`), because mkdir, rename, a source file that vanished, a name
collision, and the promise that an archived receipt is never read again are filesystem behaviours no
injected seam can reach. Which receipts may be archived is a pure function, tested separately.

The reorder review's own suite covers the thresholds schema (including the duplicate-key check that
`JSON.parse` cannot make), the reconciliation and refusal contract, the pivot's refusal to average an
unsettled group, every glyph state, the shortfall boundaries, the per-body totals (what they exclude,
that short and surplus are never netted, and that the grand total stays out of the bodies array), the
demand rollup's treatment of refunds and cancellations, the budget arithmetic (which always sums to
the budget, with a deterministic tie vector), and canonical serialisation. It also reads the committed `thresholds.json`
through the tool's own parser, and asserts that neither new command is a write command.

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
