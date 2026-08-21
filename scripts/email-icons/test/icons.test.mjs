// The path data in lib/icons.mjs is a deliberate copy of three branches of snippets/icon.liquid.
// This suite is what keeps the copy honest: if either side is edited, it fails here rather than
// shipping an email whose icons no longer match the storefront's.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ICON_PATHS, ICON_NAMES, VIEW_BOX, buildIconSvg } from '../lib/icons.mjs';
import { BODY } from '../../size-chart/lib/svg-shared.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const iconLiquid = await readFile(path.join(repoRoot, 'snippets/icon.liquid'), 'utf8');

// Pull one branch's `d` out of the theme snippet's {% case %}, the same way a reader would.
function themePathFor(name) {
  const start = iconLiquid.indexOf(`when '${name}'`);
  assert.notEqual(start, -1, `snippets/icon.liquid has no '${name}' branch`);
  const end = iconLiquid.indexOf('{%- when', start + 10);
  const branch = iconLiquid.slice(start, end === -1 ? undefined : end);
  const match = branch.match(/d="([^"]+)"/);
  assert.ok(match, `the '${name}' branch of snippets/icon.liquid has no path data`);
  return match[1];
}

test('every copied path still matches snippets/icon.liquid exactly', () => {
  for (const name of ICON_NAMES) {
    assert.equal(
      ICON_PATHS[name],
      themePathFor(name),
      `${name} has drifted from snippets/icon.liquid. Copy the theme's path data back into `
        + `scripts/email-icons/lib/icons.mjs and re-run render-email-icons.mjs.`
    );
  }
});

test('the three icons the email footer renders are all present', () => {
  assert.deepEqual(ICON_NAMES, ['instagram', 'facebook', 'tiktok']);
});

test('buildIconSvg bakes the fill in, because email has no cascade to inherit from', () => {
  const svg = buildIconSvg('instagram');
  assert.ok(svg.includes(`fill="${BODY}"`));
  assert.ok(!svg.includes('currentColor'), 'currentColor does not resolve outside the theme');
  assert.ok(svg.includes(`viewBox="${VIEW_BOX}"`));
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), 'must be a standalone document');
  assert.ok(svg.includes(ICON_PATHS.instagram));
});

test('buildIconSvg honours an explicit fill', () => {
  assert.ok(buildIconSvg('facebook', { fill: '#ffffff' }).includes('fill="#ffffff"'));
});

test('the Instagram frame is a cut-out, so the fill rule has to be evenodd', () => {
  for (const name of ICON_NAMES) {
    assert.ok(buildIconSvg(name).includes('fill-rule="evenodd"'));
  }
});

test('an unknown icon name fails loudly rather than emitting an empty glyph', () => {
  assert.throws(() => buildIconSvg('threads'), /Unknown icon "threads"/);
});
