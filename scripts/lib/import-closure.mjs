// TEST SUPPORT. The read-only guard that proves a module cannot reach a mutation, transitively.
//
// WHY THE DIRECT-IMPORT CHECK WAS NOT ENOUGH. Three modules carry a header saying they must never
// import lib/mutations.mjs, and each was pinned by asserting its own one-line import list. That
// catches the direct edge and nothing else: a module could import a freshly-added neighbour that
// imports admin.mjs, the pinned list would be updated to name the neighbour, the assertion would go
// green, and the prohibition would be gone. `importClosure` walks the whole relative-import graph
// instead, so the guarded set is every module actually loaded.
//
// THE GUARD IS ONLY AS GOOD AS ITS CONTROLS. `assertImportClosure` fails LOUDLY rather than treating
// anything it cannot follow as a leaf:
//   - an unresolvable relative specifier throws (a rename would otherwise silently prune a subtree);
//   - a bare specifier, a dynamic import call and an `export ... from` all throw, because the walker
//     cannot follow them and a silent pass there is exactly the degradation this exists to prevent.
// Node builtins (`node:*`) are the one allowed non-relative form, and are leaves by definition.
//
// The depth-2 positive control lives in the suites that use this, not here: a control that ships in
// the same file as the thing it controls can be deleted together with it.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Every static `import ... from '<spec>'` specifier in a source file, multi-line forms included. */
const IMPORT_RE = /^import[\s\S]*?from\s*['"]([^'"]+)['"];?\s*$/gm;

/** `export ... from '<spec>'`, which re-exports and therefore loads, but which the walker refuses. */
const EXPORT_FROM_RE = /^export[\s\S]*?from\s*['"]([^'"]+)['"];?\s*$/gm;

/** A dynamic import call, which is outside a static walk. */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(/;

/**
 * Comments stripped, so a JSDoc `{import('./admin.mjs').AdminClient}` type annotation (which loads
 * nothing at runtime) is not reported as a dynamic import. Strings are left alone: a specifier
 * assembled in one would be a real dynamic import worth failing on.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every module specifier a source file imports.
 *
 * `[\s\S]*?` and not `.*`: a single-line-only matcher is invisible to a MULTI-LINE import, which is
 * the shape these very test files use, so an `import {\n  setQuantity,\n} from './mutations.mjs';`
 * would leave the import list looking clean and the guard would report success for exactly the
 * violation it exists to catch. Both quote styles, and the semicolon optional.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function importsOf(source) {
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1]);
}

/**
 * Every `export ... from` specifier in a source file.
 * @param {string} source
 * @returns {string[]}
 */
export function exportFromsOf(source) {
  return [...source.matchAll(EXPORT_FROM_RE)].map((m) => m[1]);
}

/**
 * Walk the transitive relative-import closure of one entry file.
 *
 * @param {string} entry - absolute path to the entry module
 * @returns {Promise<{files: string[], bare: Array<{from: string, spec: string}>}>}
 *   `files` is every module in the closure INCLUDING the entry, as absolute paths, sorted.
 *   `bare` records every non-relative, non-builtin specifier seen, with the file that named it.
 * @throws when a relative specifier cannot be read, when a dynamic import appears, or when an
 *   `export ... from` appears: all three are places a silent pass would degrade the guard.
 */
export async function importClosure(entry) {
  const seen = new Set();
  /** @type {Array<{from: string, spec: string}>} */
  const bare = [];
  const queue = [path.resolve(entry)];

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);

    let source;
    try {
      source = await readFile(file, 'utf8');
    } catch (err) {
      throw new Error(
        `import closure: cannot read ${file} (${err.code ?? err.message}). An unresolvable ` +
          `specifier is never treated as a leaf here: pruning a subtree silently is how this guard ` +
          `degrades back into the direct-import check it replaced.`
      );
    }

    if (DYNAMIC_IMPORT_RE.test(withoutComments(source))) {
      throw new Error(
        `import closure: ${file} uses a dynamic import call, which a static walk cannot follow. Any ` +
          `occurrence inside a guarded closure is itself a failure rather than a silent pass.`
      );
    }
    const reexports = exportFromsOf(source);
    if (reexports.length) {
      throw new Error(
        `import closure: ${file} uses "export ... from" (${reexports.join(', ')}), which loads a ` +
          `module the walker does not follow. Re-export by importing the name and exporting the ` +
          `binding instead, so the edge is visible to this guard.`
      );
    }

    for (const spec of importsOf(source)) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) {
        bare.push({ from: file, spec });
        continue;
      }
      queue.push(path.resolve(path.dirname(file), spec));
    }
  }

  return { files: [...seen].sort(), bare };
}

/**
 * Assert that nothing in an entry module's transitive closure is a forbidden module, and that the
 * closure contains no specifier form the walker cannot follow.
 *
 * @param {object} params
 * @param {string} params.entry - absolute path to the entry module
 * @param {string[]} params.forbidden - absolute paths that must not appear in the closure
 * @returns {Promise<string[]>} the closure, for a caller that wants to assert more
 */
export async function assertImportClosure({ entry, forbidden }) {
  const { files, bare } = await importClosure(entry);
  if (bare.length) {
    throw new Error(
      `import closure of ${entry} reaches non-relative specifier(s) the walker cannot follow: ` +
        `${bare.map((b) => `${b.spec} (from ${b.from})`).join(', ')}. Node builtins are the only ` +
        `allowed non-relative form in a guarded closure.`
    );
  }
  const hits = forbidden.map((f) => path.resolve(f)).filter((f) => files.includes(f));
  if (hits.length) {
    throw new Error(
      `import closure of ${entry} reaches forbidden module(s): ${hits.join(', ')}. The closure was ` +
        `${files.length} file(s): ${files.join(', ')}.`
    );
  }
  return files;
}
