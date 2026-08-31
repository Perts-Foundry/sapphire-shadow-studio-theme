// Extract the inline `run:` shell bodies from composite-action `action.yml` files so shellcheck can
// lint them.
//
// WHY THIS EXISTS. `actionlint` runs shellcheck over the `run:` bodies it finds, but it only walks
// `.github/workflows/`. Handing it a composite `action.yml` makes it parse the file as a workflow
// and report `"jobs" section is missing` rather than linting anything, so the largest shell script
// in this repo (`.github/actions/shopify-theme-push/action.yml`) shipped with no automated shell
// check at all. This pulls each body out to its own file, padded so line numbers still match the
// source `action.yml`, and CI runs shellcheck over the result.
//
// WHY NO YAML PARSER. `scripts/lib/` is dependency-free and this runs on the row that gates
// auto-deploy; a line-oriented scan over a shape we control is less to go wrong than a new
// dependency. The cost of that choice is that unhandled YAML gets past it silently, so it does not
// get to be silent: every deviation below is an error, never a skip.
//
// THREE FAIL-LOUD GUARDS, because a lint that quietly covers nothing is exactly the failure this
// module exists to end:
//   1. Any `run:` key not in the handled `run: |` block form throws, naming the line. The counting
//      scan is deliberately broader than the extraction scan, so a `|-`, `|2`, `>`, trailing-comment
//      or single-line form can never pass by uncounted.
//   2. Zero extracted bodies throws. A scan that stopped matching after a future reformat would
//      otherwise leave shellcheck linting an empty directory, and the CI row green having checked
//      nothing.
//   3. A surviving `${{ ... }}` throws. It is not valid bash and would spray parse errors across
//      that same row. No `run:` body contains one today (every `${{ }}` in both composite files is
//      in `outputs:` or `env:`), so this is insurance for a future body, not a workaround.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Any line whose first non-space token is a `run:` key, with or without a leading sequence dash.
// Comments (`# ... run: ...`) do not match; the `#` is the first token.
const RUN_KEY = /^(\s*)(?:-\s+)?run\s*:/;

// The one form this module handles: a literal block scalar with no indentation indicator, no
// chomping indicator and nothing trailing.
const RUN_BLOCK = /^(\s*)(?:-\s+)?run:[ \t]*\|[ \t]*$/;

// A YAML sequence item. Used to find the step a `run:` belongs to, so its sibling `shell:` and its
// `id:`/`name:` can be read.
const SEQ_ITEM = /^(\s*)-\s+\S/;

// The `(?:-\s+)?` matters: a step whose FIRST key is `shell:` is written `- shell: bash`, and
// without the dash alternative it reads as having no shell at all, which silently demotes the step
// to "not bash, not linted". Same allowance ID_KEY and NAME_KEY already carried.
const SHELL_KEY = /^\s*(?:-\s+)?shell:[ \t]*["']?([^"'#\s]+)/;
const ID_KEY = /^\s*(?:-\s+)?id:[ \t]*["']?([^"'#\s]+)/;
const NAME_KEY = /^\s*(?:-\s+)?name:[ \t]*["']?([^"'#]+?)["']?[ \t]*$/;

// shellcheck understands the POSIX-ish family; anything else (pwsh, python, node) is a different
// language and gets logged rather than linted.
const BASH_FAMILY = /^(bash|sh)$/;

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function slug(text) {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'step';
}

/**
 * Extract the bash `run:` bodies from one composite-action document.
 *
 * @param {string} text raw `action.yml` contents
 * @param {{source?: string, allowEmpty?: boolean}} [opts]
 *   `source` labels errors and names output files. `allowEmpty` defeats guard 2; it exists for the
 *   unit tests and for nothing else, so the CLI never passes it.
 * @returns {{bodies: Array<{source: string, stepId: string, shell: string, runLine: number,
 *   firstBodyLine: number, script: string, padded: string, fileName: string}>,
 *   skipped: Array<{source: string, stepId: string, shell: string, runLine: number}>}}
 */
export function extractRunBodies(text, opts = {}) {
  const source = opts.source ?? '<input>';
  const allowEmpty = opts.allowEmpty ?? false;
  const lines = text.split('\n');

  const bodies = [];
  const skipped = [];
  const usedNames = new Set();
  let stepCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!RUN_KEY.test(line)) continue;

    // Guard 1. The broad scan found a `run:`; if the strict scan does not also claim it, the form is
    // one this module would mis-extract, so refuse rather than guess.
    const block = RUN_BLOCK.exec(line);
    if (!block) {
      throw new Error(
        `${source}:${i + 1}: unsupported \`run:\` form (only \`run: |\` block scalars are extracted): ${line.trim()}`
      );
    }

    const runIndent = indentOf(line);

    // The body is every following line that is blank or indented deeper than the `run:` key.
    let end = i + 1;
    while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > runIndent)) {
      end++;
    }
    // Trailing blank lines belong to the document's spacing, not to the script.
    let last = end;
    while (last > i + 1 && lines[last - 1].trim() === '') last--;

    const raw = lines.slice(i + 1, last);
    const nonBlank = raw.filter((l) => l.trim() !== '');
    // Guard 2, first half. An empty `run: |` would otherwise produce a body: `Math.min()` of no
    // arguments is Infinity, `slice(Infinity)` is '', and a zero-byte "body" gets counted. That is
    // the exact "green having linted nothing" outcome the body count exists to make visible, only
    // now hiding behind a count of 1.
    if (nonBlank.length === 0) {
      throw new Error(
        `${source}:${i + 1}: \`run: |\` block is empty; it would be counted as an extracted body ` +
          'while giving shellcheck nothing to lint.'
      );
    }
    const dedent = Math.min(...nonBlank.map(indentOf));
    const script = raw.map((l) => (l.trim() === '' ? '' : l.slice(dedent))).join('\n');

    // Guard 3.
    if (script.includes('${{')) {
      throw new Error(
        `${source}:${i + 1}: \`\${{ }}\` survives into the extracted body; it is not valid bash. ` +
          'Pass the value through `env:` and reference it as a shell variable instead.'
      );
    }

    // Walk back to the sequence item this `run:` sits in, then forward through it for the sibling
    // `shell:` and a name to label the output file with. Composite steps always carry an explicit
    // `shell:`; GitHub rejects the action without one.
    let stepStart = i;
    while (stepStart > 0 && !(SEQ_ITEM.test(lines[stepStart]) && indentOf(lines[stepStart]) < runIndent)) {
      stepStart--;
    }
    const stepIndent = indentOf(lines[stepStart]);
    let stepEnd = i + 1;
    while (
      stepEnd < lines.length &&
      !(SEQ_ITEM.test(lines[stepEnd]) && indentOf(lines[stepEnd]) <= stepIndent)
    ) {
      stepEnd++;
    }

    stepCount++;
    let shell = '';
    let stepId = '';
    let stepName = '';
    for (let j = stepStart; j < stepEnd; j++) {
      // Only the step's own keys, not keys nested under `env:` / `with:`.
      if (indentOf(lines[j]) > runIndent) continue;
      const s = SHELL_KEY.exec(lines[j]);
      if (s && !shell) shell = s[1];
      const id = ID_KEY.exec(lines[j]);
      if (id && !stepId) stepId = id[1];
      const nm = NAME_KEY.exec(lines[j]);
      if (nm && !stepName) stepName = nm[1];
    }

    const label = slug(stepId || stepName || `step-${stepCount}`);

    if (!BASH_FAMILY.test(shell)) {
      skipped.push({ source, stepId: label, shell: shell || '(none)', runLine: i + 1 });
      i = end - 1;
      continue;
    }

    // Left-pad with blank lines so shellcheck's reported line numbers are the source `action.yml`'s
    // line numbers. The first body line is source line `i + 2` (1-based), so it needs `i + 1`
    // blank lines ahead of it.
    const padded = '\n'.repeat(i + 1) + script + '\n';

    // Two steps sharing a `name:` with no `id:` slug identically. Writing both to one filename
    // loses a body while the printed count still says two, which is precisely the case where the
    // "did it lint anything" signal lies. Disambiguate by run line (unique by construction) rather
    // than refusing: same-named steps are legal YAML, and dropping coverage is the failure here.
    let fileName = `${slug(source.replace(/\.ya?ml$/, ''))}__${label}.sh`;
    if (usedNames.has(fileName)) {
      fileName = `${slug(source.replace(/\.ya?ml$/, ''))}__${label}-L${i + 1}.sh`;
    }
    usedNames.add(fileName);

    bodies.push({
      source,
      stepId: label,
      shell,
      runLine: i + 1,
      firstBodyLine: i + 2,
      script,
      padded,
      fileName,
    });

    i = end - 1;
  }

  // Guard 2.
  if (bodies.length === 0 && !allowEmpty) {
    throw new Error(
      `${source}: no bash \`run:\` bodies extracted. Either the file has none (remove it from the ` +
        'lint list) or the extraction scan has stopped matching and shellcheck would lint nothing.'
    );
  }

  return { bodies, skipped };
}

/**
 * CLI: `node scripts/lib/composite-shell.mjs <out-dir> <action.yml...>`
 *
 * Writes one `.sh` per extracted body and prints a body count, so a CI log makes the difference
 * between "green" and "green having linted nothing" visible without reading the shellcheck output.
 */
async function main(argv) {
  const [outDir, ...files] = argv;
  if (!outDir || files.length === 0) {
    console.error('usage: composite-shell.mjs <out-dir> <action.yml...>');
    return 2;
  }

  await mkdir(outDir, { recursive: true });
  let total = 0;
  // Every body must reach shellcheck as its own file. Within one action.yml `extractRunBodies`
  // guarantees that; this catches the cross-file case, where two source paths could in principle
  // slug the same, before a silent overwrite makes the count below a lie.
  const written = new Set();

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const { bodies, skipped } = extractRunBodies(text, { source: file });
    for (const body of bodies) {
      if (written.has(body.fileName)) {
        throw new Error(`${file}:${body.runLine}: extracted filename ${body.fileName} collides with an earlier body`);
      }
      written.add(body.fileName);
      await writeFile(path.join(outDir, body.fileName), body.padded, 'utf8');
      console.log(`  ${file}:${body.runLine} (${body.shell}) -> ${body.fileName}`);
      total++;
    }
    for (const s of skipped) {
      console.log(`  ${file}:${s.runLine} shell=${s.shell} is not bash; not linted`);
    }
  }

  console.log(`extracted ${total} run bodies from ${files.length} files`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exitCode = 1;
  }
}
