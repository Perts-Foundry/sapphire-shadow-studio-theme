#!/usr/bin/env node
// The restore source for one `sync` id: the document Admin held before the paste, written to a
// file and refused unless it hashes to the numbers the operator approved in the plan table.
//
// It exists because the obvious route does not work. `editor-dump.js` prints the document to the
// console, but `list_console_messages` has no file output and the harness only spills a result to
// disk above roughly 50 KB, so every smaller dump would have to be retyped by hand: about 480 KB
// across a full run. Two sources avoid that entirely, and both are byte-checked here:
//
//   --from-response <file>   the EmailTemplate GraphQL response every editor page load fetches,
//                            saved with get_network_request's responseFilePath. Its
//                            data.emailTemplate.bodyHtml IS the stored template.
//   --from-stock <id>        marketing/notifications/stock/<id>.liquid at --root, for an id whose
//                            observed bytes equal the recorded stock snapshot. A copy of a file
//                            already on disk, gated on the same numbers.
//
//   node scripts/notifications/before-doc.mjs --from-stock <id> --expect-length <n>
//        --expect-fnv <hex> --out <file> [--root <dir>]
//   node scripts/notifications/before-doc.mjs --from-response <file> --expect-length <n>
//        --expect-fnv <hex> --out <file>
//
// Exit 0 writes the file and prints "<length> <fnv> -> <path>". Any mismatch writes nothing and
// exits 1: a restore source that is not what Admin held is worse than no restore source.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fnv1a, verifyText } from './dump.mjs';
import { paths, REPO_ROOT } from './brand.mjs';
import { storedBodyFromResponse } from './verify-render.mjs';

export class BeforeDocError extends Error {}

// Reads the source, normalises line endings, and refuses anything that does not match `expect`.
// `expect` is { length, hash }; both are required, because the whole point is the gate.
export function beforeDoc({ fromStock, fromResponse, expect, root = REPO_ROOT }) {
  if ((fromStock === undefined) === (fromResponse === undefined)) {
    throw new BeforeDocError('exactly one of --from-stock and --from-response is required');
  }
  if (!Number.isInteger(expect.length) || expect.length < 1) throw new BeforeDocError('--expect-length must be a positive integer');
  if (!/^[0-9a-f]{8}$/.test(String(expect.hash))) throw new BeforeDocError('--expect-fnv must be eight lowercase hex digits');

  let text;
  let source;
  if (fromStock !== undefined) {
    source = paths(root).stock(fromStock);
    text = readFileSync(source, 'utf8');
  } else {
    source = fromResponse;
    text = storedBodyFromResponse(readFileSync(source, 'utf8'));
  }
  text = text.replace(/\r\n?/g, '\n');
  verifyText(text);
  const hash = fnv1a(text);
  if (text.length !== expect.length || hash !== expect.hash) {
    throw new BeforeDocError(
      `refused: ${source} is ${text.length} ${hash}, the approved before-numbers are ${expect.length} ${expect.hash}. ` +
        'Admin changed since the read pass, or the wrong source was named. Do not paste.',
    );
  }
  return { text, length: text.length, hash, source };
}

function main(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const out = get('--out');
  const lengthArg = get('--expect-length');
  const opts = {
    fromStock: get('--from-stock'),
    fromResponse: get('--from-response') ? resolve(get('--from-response')) : undefined,
    expect: { length: lengthArg === undefined ? undefined : Number(lengthArg), hash: get('--expect-fnv') },
    root: get('--root') ? resolve(get('--root')) : REPO_ROOT,
  };
  if (!out || lengthArg === undefined || opts.expect.hash === undefined) {
    console.error(
      'usage: before-doc.mjs (--from-stock <id> | --from-response <file>) --expect-length <n> --expect-fnv <hex> --out <file> [--root <dir>]',
    );
    return 2;
  }
  let result;
  try {
    result = beforeDoc(opts);
  } catch (err) {
    console.error(err instanceof BeforeDocError ? err.message : `refused: ${err.message}`);
    return 1;
  }
  writeFileSync(resolve(out), result.text, 'utf8');
  console.log(`${result.length} ${result.hash} -> ${resolve(out)}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
