// The one place a test gets a gid. Every gid-shaped literal in this suite comes from here, and
// `gid-corpus.test.mjs` fails if a test file defines its own.
//
// Why a module and not a constant per test file: the incident this exists for was not two copies
// of a regex drifting apart. It was BOTH copies being consistently wrong against Admin while every
// fixture encoded the same wrong assumption, so a numeric gid was the only shape any test ever
// exercised and a numeric-only `GID_RE` was green throughout. Swapping one invented literal for
// one invented word-shaped literal would replace a monoculture with a monoculture, so the positive
// cases are the REAL ids out of `manifest.json`: already committed, already the source of truth
// every other tool derives from, and not something that can go stale against the store.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, REPO_ROOT } from '../brand.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));

// Every id in the committed manifest, sorted, and the gid Admin returns for each.
export const MANIFEST_IDS = Object.keys(JSON.parse(readFileSync(paths(REPO_ROOT).manifest, 'utf8')).templates).sort();
export const gidFor = (id) => `gid://shopify/EmailTemplate/${id}`;
export const MANIFEST_GIDS = MANIFEST_IDS.map(gidFor);

// A legal numeric id segment. Still legal under the handle shape, and the only shape
// `browser-probes.test.mjs` and `before-doc.test.mjs` covered before this module existed, so it
// stays covered rather than being swapped out.
export const NUMERIC_GID = gidFor('1234567890');
// Legal edge shapes: one character, and a leading underscore.
export const EDGE_GIDS = [gidFor('a'), gidFor('_'), gidFor('_buy_online'), gidFor('a1')];

// The three classes, table-driven, so a gid check runs over all of them and never over one
// "primary" example.
export const GID_CLASSES = [
  { name: 'manifest ids (what Admin returns)', gids: MANIFEST_GIDS },
  { name: 'a legal numeric id segment', gids: [NUMERIC_GID] },
  { name: 'legal edge shapes', gids: EDGE_GIDS },
];
export const ALL_LEGAL_GIDS = GID_CLASSES.flatMap((c) => c.gids);

// One gid for a suite that needs a single well-formed example: the first manifest id, so it is a
// real one. `FIXTURE_GID` names an id that exists in this repo's manifest and nowhere else matters.
export const FIXTURE_GID = MANIFEST_GIDS[0];
export const OTHER_FIXTURE_GID = MANIFEST_GIDS[1];

// A regex widened to fix a false refusal is exactly when over-widening happens, so the negative
// corpus is part of the fixture module rather than being written out per test.
export const ILLEGAL_GIDS = [
  ['wrong resource', 'gid://shopify/Product/abc'],
  ['wrong resource, numeric', 'gid://shopify/Product/1'],
  ['near-miss resource name', 'gid://shopify/EmailTemplates/buy_online'],
  ['empty id segment', 'gid://shopify/EmailTemplate/'],
  ['no id segment at all', 'gid://shopify/EmailTemplate'],
  ['trailing space', 'gid://shopify/EmailTemplate/buy_online '],
  ['leading space', ' gid://shopify/EmailTemplate/buy_online'],
  ['trailing newline', 'gid://shopify/EmailTemplate/buy_online\n'],
  ['embedded newline', 'gid://shopify/EmailTemplate/buy\nonline'],
  ['embedded slash', 'gid://shopify/EmailTemplate/buy/online'],
  ['path traversal', 'gid://shopify/EmailTemplate/../buy_online'],
  ['dot segment', 'gid://shopify/EmailTemplate/buy.online'],
  ['query string', 'gid://shopify/EmailTemplate/buy_online?x=1'],
  ['fragment', 'gid://shopify/EmailTemplate/buy_online#x'],
  ['uppercase id', 'gid://shopify/EmailTemplate/Buy_Online'],
  ['uppercase resource', 'GID://SHOPIFY/EMAILTEMPLATE/buy_online'],
  ['hyphen in the id', 'gid://shopify/EmailTemplate/buy-online'],
  // A Cyrillic "о" for the ASCII one: it renders identically in a terminal and in a diff.
  ['non-ASCII homoglyph', 'gid://shopify/EmailTemplate/buy_оnline'],
  ['full URL', 'https://admin.shopify.com/gid://shopify/EmailTemplate/buy_online'],
  ['bare handle', 'buy_online'],
  ['single slash', 'gid:/shopify/EmailTemplate/buy_online'],
  ['empty string', ''],
];
