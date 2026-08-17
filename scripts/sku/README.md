# scripts/sku/

Derive, audit and apply variant SKUs. The scheme, the code inventory and the "adding a code" runbook
live in [`docs/sku-scheme.md`](../../docs/sku-scheme.md); this file is the tool.

**This writes to the live store.** There is no staging store. The `sku` Claude skill
(`.claude/skills/sku/SKILL.md`) drives these commands and holds the operator approval STOPs; this
directory is the deterministic half.

```bash
node --env-file=.env scripts/sku/sku.mjs audit
node --env-file=.env scripts/sku/sku.mjs plan
node --env-file=.env scripts/sku/sku.mjs show   --plan <artifact.json>
node --env-file=.env scripts/sku/sku.mjs apply  --plan <artifact.json> --dry-run
node --env-file=.env scripts/sku/sku.mjs apply  --plan <artifact.json>
node --env-file=.env scripts/sku/sku.mjs verify
```

| Command | Writes? | What it does |
|---|---|---|
| `audit [--json]` | no | Classifies every variant: correct, null (actionable or exempt), drift, not derivable. Reports unmapped values, duplicate expected SKUs and collisions. Exits 1 while work remains. |
| `plan [--include-mismatches]` | no (writes an artifact outside the repo) | Turns an audit into an immutable, hashed plan artifact. Nulls only unless the flag is passed. |
| `show --plan <f>` | no | Renders an artifact for the approval gate. |
| `apply --plan <f> [--dry-run]` | **yes** | Executes that artifact and nothing else. |
| `verify [--json]` | no | Re-audit, framed as the exit check. |

`npm run sku:test` (unit suite) and `npm run sku:tables` (offline table lint) both run in CI. Neither
touches the network; the validate job holds no Shopify token at all, which is the real reason no live
path can run there.

## Invariants

- **A SKU is derived, never typed.** `tables.json` is the source of truth, and extending the scheme
  is a git edit and a PR. There is no command that invents a code.
- **The artifact is the contract.** `apply` consumes only a plan artifact and re-derives nothing. It
  refuses an artifact that has been edited (content hash) and one built from different code tables
  (embedded tables hash), because a table edit changes what a previously approved plan would write.
- **Nulls only by default.** Repairing drift overwrites a value that may already be on a packing slip
  or frozen onto an order line, so it takes `--include-mismatches`.
- **The planner refuses rather than reports.** Any unmapped value, duplicate expected SKU, or
  collision with a live SKU aborts the whole plan. A half-populated SKU field is worse than an empty
  one, because a SKU filter then silently returns an incomplete set.
- **Baseline guard on every row.** Immediately before writing a product's rows, its live SKUs are
  re-read; a row whose value moved since the plan is skipped, not overwritten. The re-read is per
  product inside the loop, so a change landing mid-run is seen.
- **Continue on error, per row.** One rejected variant does not abandon the rest, and the receipt is
  persisted after every batch.
- **Scope check on the write path only.** `apply` asserts `write_products`; the read-only commands do
  not, so read-only credentials can still audit. A passing scope check is capability, never
  authorization.

## Artifact lifecycle

Artifacts and receipts live **outside the repository**, in `~/.local/state/sku-tool/`
(`SKU_WORK_DIR` overrides). SKUs are public, so this is not a data-sensitivity call: it keeps one
convention for tool state in a public repo rather than a second "safe to commit" class.

```
plan  ->  plan-<planId>.json     the contract, hashed, includes the tables hash
apply ->  receipt-<planId>.json  per-row outcome and each row's PRIOR SKU
```

**An artifact is single-use.** The receipt file's existence is the spend record, and `apply` refuses
a plan that already has one. Re-running a partially applied plan would skip the rows that landed
(their baseline has moved) while retrying the rest against a store that has since changed. Recovery
from a partial run is a fresh `audit` then `plan`, which re-reads reality.

**There is no `revert` command, by design.** Every receipt row records the prior SKU, so recovery is
applying those baselines back through the same gates that wrote them. An automatic rollback would be
a second write path with a fraction of the review. See `docs/sku-scheme.md`.

## Modules

| File | Purpose |
|---|---|
| `sku.mjs` | CLI: command map, rendering, the one write command |
| `tables.json` | The committed code tables. Append-only |
| `lib/tables.mjs` | Load, validate and hash the tables |
| `lib/derive.mjs` | Pure derivation: options in, SKU or a typed miss out |
| `lib/catalogue.mjs` | Paginated reads, with a truncation guard |
| `lib/audit.mjs` | Pure classification and cross-checks |
| `lib/planner.mjs` | Plan rows, and every refusal |
| `lib/artifact.mjs` | Hashed artifacts and incremental receipts |
| `lib/apply.mjs` | Executes an artifact: baseline guard, batching, per-row outcomes |
| `lib/mutations.mjs` | The one mutation, and per-row `userErrors` unpacking |
| `lib/workdir.mjs` | Outside-repo working directory |
| `check-tables.mjs` | Offline table lint (`npm run sku:tables`) |

The Admin API client is `scripts/blank-inventory/lib/admin.mjs`, imported directly: there is
deliberately only one token flow in this repo. `assertScopes` takes this tool's own required-scope
list so it asks for `write_products` alone.

## Credentials

`MYSHOPIFY_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, from a gitignored `.env` at the
repo root, passed with `node --env-file=.env`. See [`../README.md`](../README.md) for the rules that
go with it.
