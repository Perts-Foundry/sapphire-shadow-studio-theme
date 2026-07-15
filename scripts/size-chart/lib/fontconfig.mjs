// Runtime fontconfig setup so sharp's librsvg resolves the bundled Inter font by family name.
//
// librsvg (what sharp/libvips uses to rasterise SVG) does NOT honour @font-face embedded fonts;
// it resolves text through fontconfig. So we bundle the Inter variable TTF and point fontconfig at
// it via a generated config. The returned path must be assigned to process.env.FONTCONFIG_FILE
// BEFORE sharp is first imported/used, because libvips initialises fontconfig on first text layout.

import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FONTS_DIR = path.join(HERE, '..', 'fonts');
export const INTER_TTF = path.join(FONTS_DIR, 'Inter.ttf');

// Generate a fontconfig file exposing the bundled Inter dir plus common system dirs (fallback for
// any glyphs Inter lacks), with a private writable cache dir. Returns the config path.
export function setupFontconfig() {
  if (!existsSync(INTER_TTF)) {
    throw new Error(`Bundled font missing: ${INTER_TTF}. Re-add scripts/size-chart/fonts/Inter.ttf.`);
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'size-chart-fc-'));
  const cacheDir = path.join(tmp, 'cache');
  const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${FONTS_DIR}</dir>
  <dir>/usr/share/fonts</dir>
  <dir>/usr/local/share/fonts</dir>
  <dir prefix="xdg">fonts</dir>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>
`;
  const confPath = path.join(tmp, 'fonts.conf');
  writeFileSync(confPath, conf);
  return confPath;
}
