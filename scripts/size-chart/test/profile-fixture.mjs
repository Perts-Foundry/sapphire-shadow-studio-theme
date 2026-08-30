// Read a committed profile the way the CLIs do: parsed, then materialised against the catalogue
// manifest so `sizes` and `handles` are present.
//
// Synchronous, because most suites here build their fixture at module scope. It reads the COMMITTED
// manifest deliberately: these tests already read the committed profile, so pairing it with the
// committed catalogue keeps them the matches-production statements they always were. Tests that
// assert the DERIVATION rather than today's data build their own manifest and call
// `materialiseProfile` directly (see profile-io.test.mjs).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCommittedCatalogue } from '../../lib/catalogue-manifest.mjs';
import { materialiseProfile } from '../lib/profile-io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(HERE, '..', 'profiles');

/** The committed catalogue manifest, parsed once (memoised by the shared loader). */
export function committedManifest() {
  return readCommittedCatalogue();
}

/**
 * @param {string} file - a profile filename, e.g. 'crewneck-fleece.json'
 * @returns {object} the resolved profile
 */
export function resolvedProfile(file) {
  const name = file.endsWith('.json') ? file : `${file}.json`;
  const raw = JSON.parse(readFileSync(path.join(PROFILES_DIR, name), 'utf8'));
  return materialiseProfile(raw, committedManifest());
}
