// Tier A4 checks: existing tools run as-is, one finding per non-zero exit, stdout attached
// as evidence (truncated), never parsed. Owned by the integration step.

export const A4_CHECKS = [
  { id: 'tool-seo-surface', tier: 'A4', surface: 'tooling', severity: 'ERROR', description: 'scripts/seo-review/surface.mjs --no-save exited non-zero.' },
  { id: 'tool-seo-crawl', tier: 'A4', surface: 'tooling', severity: 'ERROR', description: 'scripts/seo-review/crawl.mjs --no-save exited non-zero.' },
  { id: 'tool-smoke-dry-run', tier: 'A4', surface: 'tooling', severity: 'ERROR', description: 'smoke.mjs --dry-run (local, not the post-deploy path) exited non-zero.' },
  { id: 'tool-contrast-lint', tier: 'A4', surface: 'tooling', severity: 'ERROR', description: 'npm run contrast:lint exited non-zero.' },
  { id: 'tool-theme-check', tier: 'A4', surface: 'tooling', severity: 'ERROR', description: 'shopify theme check exited non-zero (run from the primary checkout path).' },
];
