import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  PAIRS, ROLE_KINDS, checkCompleteness,
  THRESHOLD_TEXT, THRESHOLD_LARGE_TEXT, THRESHOLD_NON_TEXT, PAGE_BACKGROUND,
} from '../lib/pairs.mjs';
import { schemaRoleIds, loadSchemes } from '../lib/settings.mjs';
import { PATHS } from '../check-contrast.mjs';

test('the pairing map covers every role the live theme declares', () => {
  // THE point of this suite. A Horizon upstream merge that adds a colour role
  // must fail here, loudly, rather than leave the new colour unchecked forever.
  const roles = new Set(schemaRoleIds(PATHS.settingsSchema));
  for (const s of loadSchemes(PATHS.settingsData)) {
    for (const role of Object.keys(s.settings)) roles.add(role);
  }
  const { missing, unknown } = checkCompleteness([...roles]);
  assert.deepEqual(missing, [], 'roles present in the theme but absent from lib/pairs.mjs');
  assert.deepEqual(unknown, [], 'roles in lib/pairs.mjs that the theme no longer has');
});

test('every role is classified exactly once', () => {
  const kinds = Object.values(ROLE_KINDS);
  assert.ok(kinds.length >= 35, `expected the full role set, got ${kinds.length}`);
  for (const [role, kind] of Object.entries(ROLE_KINDS)) {
    assert.ok(['fg', 'bg', 'border', 'exempt'].includes(kind), `${role} has bogus kind ${kind}`);
  }
});

test('checkCompleteness reports both directions', () => {
  const withExtra = checkCompleteness([...Object.keys(ROLE_KINDS), 'brand_new_role']);
  assert.deepEqual(withExtra.missing, ['brand_new_role']);
  assert.deepEqual(withExtra.unknown, []);

  const withoutOne = checkCompleteness(Object.keys(ROLE_KINDS).filter((r) => r !== 'shadow'));
  assert.deepEqual(withoutOne.missing, []);
  assert.deepEqual(withoutOne.unknown, ['shadow']);
});

test('thresholds are the WCAG AA values', () => {
  assert.equal(THRESHOLD_TEXT, 4.5);
  assert.equal(THRESHOLD_LARGE_TEXT, 3);
  assert.equal(THRESHOLD_NON_TEXT, 3);
});

test('pair ids are unique and every pair references real roles', () => {
  const ids = PAIRS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate pair id would collide in accepted-risks.json');
  for (const pair of PAIRS) {
    assert.ok(ROLE_KINDS[pair.fg], `${pair.fg} unclassified`);
    assert.ok(ROLE_KINDS[pair.bg], `${pair.bg} unclassified`);
    assert.equal(ROLE_KINDS[pair.bg], 'bg', `${pair.bg} used as a background but not classified as one`);
    assert.ok(pair.threshold >= 3);
  }
});

test('shadow is the only exempt role', () => {
  const exempt = Object.entries(ROLE_KINDS).filter(([, k]) => k === 'exempt').map(([r]) => r);
  assert.deepEqual(exempt, ['shadow']);
});

test('component hover text is paired with that component hover background', () => {
  // Pairing resting text against a hover fill would invent a combination no
  // user ever sees, and would flag or excuse the wrong thing.
  //
  // `primary_hover` is deliberately exempt: it is the LINK hover colour, and a
  // hovered link sits on the ordinary page background. The page has no hover
  // state, so `primary_hover on background` is the real combination, not a
  // cross-state pairing.
  const componentHover = PAIRS.filter(
    (p) => p.fg.includes('hover') && p.kind !== 'non-text' && p.bg !== PAGE_BACKGROUND
  );
  // Buttons (primary, secondary), variants and selected variants: four.
  assert.equal(componentHover.length, 4, 'expected one hover pair per hoverable component');
  for (const pair of componentHover) {
    assert.ok(pair.bg.includes('hover'), `${pair.id} pairs hover text with a resting background`);
  }
  assert.ok(
    PAIRS.some((p) => p.id === 'primary_hover on background'),
    'the link hover colour must still be checked against the page'
  );
});

test('inputs have no hover text role, so resting input text is checked against the hover fill', () => {
  assert.ok(PAIRS.some((p) => p.fg === 'input_text_color' && p.bg === 'input_hover_background'));
  assert.ok(PAIRS.some((p) => p.fg === 'input_text_color' && p.bg === 'input_background'));
});

test('PAGE_BACKGROUND is a real background role', () => {
  assert.equal(ROLE_KINDS[PAGE_BACKGROUND], 'bg');
  assert.equal(PAGE_BACKGROUND, 'background');
});
