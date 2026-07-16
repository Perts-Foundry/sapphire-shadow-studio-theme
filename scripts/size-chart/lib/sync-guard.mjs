// Pure decision for the two-writer in-flight guard, extracted so it is unit-testable without a git
// harness. apply-size-chart.mjs gathers the git facts (are the refs present, does the file differ
// between origin/main and origin/shopify-sync) and passes them here.
//
// The guard exists because product templates are written by two producers: the Shopify Admin
// customizer (auto-commits to shopify-sync) and this tooling. If shopify-sync carries an edit to a
// template that has not been reconciled to main, applying here could clobber it, so we block.

// Returns { action: 'block' | 'proceed', warn: boolean, reason }.
//   - refs missing            -> proceed, warn (cannot check; e.g. fresh clone / CI without the ref)
//   - file diverged on sync   -> block   (an unreconciled in-flight Admin edit)
//   - file identical on sync  -> proceed (safe)
export function classifyInFlight({ refsPresent, divergedPaths }) {
  if (!refsPresent) return { action: 'proceed', warn: true, reason: 'refs-missing' };
  if (typeof divergedPaths === 'string' && divergedPaths.trim() !== '') {
    return { action: 'block', warn: false, reason: 'diverged' };
  }
  return { action: 'proceed', warn: false, reason: 'clean' };
}
