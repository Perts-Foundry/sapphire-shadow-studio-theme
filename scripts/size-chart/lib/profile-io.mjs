// Shared profile loader for both CLIs (render-size-chart.mjs, apply-size-chart.mjs). Resolves a
// `--profile` argument (a blank_id under profiles/, or a path to a .json), parses it, and validates
// it before returning. Kept in one place so the two entrypoints cannot drift.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from './profile-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROFILES_DIR = path.join(HERE, '..', 'profiles');

export async function loadProfile(ref) {
  const p = ref.endsWith('.json') ? path.resolve(ref) : path.join(PROFILES_DIR, `${ref}.json`);
  let json;
  try {
    json = JSON.parse(await readFile(p, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read profile '${ref}' (${p}): ${e.message}`);
  }
  validateProfile(json);
  return json;
}
