#!/usr/bin/env node
// Rewrites the generated region of .claude/skills/site-check/surfaces.md from the registry.
// The contract test pins the region to this output, so run it after editing any registry file.
// This is a maintenance entry point, not a lib module: it is the one file under lib/ that reads
// and writes a file, and nothing else under lib/ imports it.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { updateSurfacesDoc } from './surfaces-doc.mjs';

const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.claude', 'skills', 'site-check', 'surfaces.md');
let md = '';
try { md = readFileSync(path, 'utf8'); } catch { md = '# Surfaces\n'; }
writeFileSync(path, updateSurfacesDoc(md));
process.stdout.write(`updated ${path}\n`);
