// Renders the generated region of .claude/skills/site-check/surfaces.md from the registry and
// parses it back, so a parity test can assert the file and the registry agree both ways.

import { CHECKS, SURFACES, TIERS } from './registry.mjs';

export const BEGIN = '<!-- registry:begin (generated from scripts/site-check/lib/registry.mjs; do not hand-edit) -->';
export const END = '<!-- registry:end -->';

const TIER_ORDER = TIERS.map((t) => t.id);

export function renderSurfacesRegion() {
  const lines = [BEGIN, '', '| Surface | Tier | Check ids |', '|---|---|---|'];
  for (const s of SURFACES) {
    for (const tier of TIER_ORDER) {
      const ids = CHECKS.filter((c) => c.surface === s.id && c.tier === tier).map((c) => `\`${c.id}\``);
      if (ids.length) lines.push(`| ${s.id} | ${tier} | ${ids.join(', ')} |`);
    }
  }
  lines.push('', END);
  return lines.join('\n');
}

/** Every check id inside the generated region of a surfaces.md text. */
export function parseSurfacesRegion(md) {
  const start = md.indexOf(BEGIN);
  const end = md.indexOf(END);
  if (start < 0 || end < 0 || end < start) throw new Error('surfaces.md is missing the registry region markers');
  const region = md.slice(start, end);
  const ids = [];
  for (const m of region.matchAll(/`([a-z0-9-]+)`/g)) ids.push(m[1]);
  return { region: md.slice(start, end + END.length), ids };
}

/** Replace (or append) the generated region in an existing surfaces.md text. */
export function updateSurfacesDoc(md) {
  const rendered = renderSurfacesRegion();
  const start = md.indexOf(BEGIN);
  const end = md.indexOf(END);
  if (start < 0 || end < 0) return `${md.trimEnd()}\n\n${rendered}\n`;
  return md.slice(0, start) + rendered + md.slice(end + END.length);
}
