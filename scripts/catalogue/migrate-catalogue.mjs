#!/usr/bin/env node
// One-shot, read-only migrator: print a version 2 SKELETON from a version 1 catalogue.json.
//
// WHY IT PRINTS RATHER THAN WRITES. The manifest is hand-edited in a reviewed PR and no command
// edits it; that rule does not get an exception for the command that changes its shape. This writes
// nothing, touches nothing, and takes no flags. Redirect it, or copy it out of the terminal.
//
// WHY IT IS A SKELETON AND NOT A MIGRATION. Two of v2's four new sections cannot be derived from a
// v1 document, because a v1 document does not contain them:
//
//   - `colors[].display` and `sizes[].display` are the ADMIN SPELLINGS. v1 stores only the
//     normalised identity (`grey heather`), and the Admin value could be `Grey Heather`, `Grey
//     heather` or `GREY HEATHER`. This prints a title-cased guess, which is a starting point for an
//     editor to correct against Admin, never an answer. `sizes` is worse: `xs` title-cases to `Xs`
//     and the live value is `XS`, so every size display below is wrong by construction and says so.
//   - `products` is the whole product census: handles, titles, GIDs, template suffixes and the
//     product line. None of that exists in v1 at all. The skeleton prints an empty object and a
//     commented example.
//
// `options` is likewise unknowable and prints the four axis ids with placeholder names. `colors[].slug`
// and the two order contracts ARE derivable and are emitted correctly.
//
// SO THIS IS NOT A ROUND TRIP. Its output does not validate as-is, deliberately: the schema refuses
// every placeholder it emits, so an unfinished migration cannot merge looking done. Fill it in from
// Admin, then run `npm run catalogue:lint`.
//
// DELETED once the migration lands. A migrator with nothing left to migrate is cruft that reads like
// a supported path.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The placeholder an editor must replace. The schema refuses it, which is the point. */
export const PLACEHOLDER = 'TODO-READ-FROM-ADMIN';

/** Title-case a normalised value, as a starting guess at its Admin spelling. */
const titleCase = (value) => value.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Build the v2 skeleton from a parsed v1 document.
 *
 * Pure: no I/O, so the whole shape is asserted in a unit test rather than by eye.
 *
 * @param {object} v1 - a parsed version 1 catalogue document
 * @returns {{skeleton: object, notes: string[]}}
 */
export function migrateToV2(v1) {
  if (!v1 || typeof v1 !== 'object' || Array.isArray(v1)) {
    throw new Error('Input must be a JSON object.');
  }
  if (v1.version !== 1) {
    throw new Error(
      `Input declares version ${JSON.stringify(v1.version)}; this migrator reads version 1 only. ` +
        `There is exactly one migration and it runs once.`
    );
  }
  const bodies = v1.bodies;
  if (!bodies || typeof bodies !== 'object' || Array.isArray(bodies)) {
    throw new Error('Input has no "bodies" object; there is nothing to migrate.');
  }

  // First-seen union across bodies, in declaration order. That order IS the contract v2 asserts, so
  // it is carried forward rather than sorted.
  const union = (axis) => {
    const out = [];
    for (const range of Object.values(bodies)) {
      for (const value of range?.[axis] ?? []) if (!out.includes(value)) out.push(value);
    }
    return out;
  };

  const colors = {};
  for (const id of union('colors')) {
    colors[id] = { display: titleCase(id), slug: id.replace(/ /g, '-') };
  }
  const sizes = {};
  for (const id of union('sizes')) {
    sizes[id] = { display: titleCase(id) };
  }

  const notes = [
    `Every "display" above is a TITLE-CASED GUESS, not a fact. Check each one against the live ` +
      `Admin option value; the schema refuses a display that does not normalise back to its key, ` +
      `so a wrong guess fails the lint rather than shipping.`,
    `Every size display is wrong by construction: "xs" title-cases to "Xs" and the live value is ` +
      `"XS". Fix all of them.`,
    `"options" holds the four Admin option NAMES. They are not derivable from a v1 document; read ` +
      `them off any product in Admin. One of them is legitimately plural ("Denominations"), which ` +
      `is live data and not a typo to fix.`,
    `"products" is the complete census, gift cards included, and is EMPTY above because a v1 ` +
      `document contains none of it. One entry per live product, with its handle as the key. ` +
      `A product that is not a garment carries "line": null and "body": null, together and ` +
      `explicitly. "template" is the theme template suffix: templates/product.<template>.json.`,
    `Product declaration order drives the accessibility audit's product block and photo-naming's ` +
      `line list, so choose it deliberately rather than alphabetically.`,
    `Colour and size key order must equal the first-seen union across "bodies"; it is emitted ` +
      `correctly above and must stay that way.`,
  ];

  return {
    skeleton: {
      version: 2,
      comment: PLACEHOLDER,
      options: {
        color: PLACEHOLDER,
        size: PLACEHOLDER,
        design: PLACEHOLDER,
        denomination: PLACEHOLDER,
      },
      colors,
      sizes,
      bodies,
      products: {},
    },
    notes,
  };
}

/** The example entry printed under the empty products block. Not part of the JSON. */
export const EXAMPLE_PRODUCT = `  "products": {
    "example-handle": {
      "line": "example-line",
      "body": "${'<one of the body ids above>'}",
      "template": "example-handle",
      "title": "Example Product",
      "gid": "gid://shopify/Product/0000000000000"
    },
    "example-gift-card": {
      "line": null,
      "body": null,
      "template": "gift-card",
      "title": "Example Gift Card",
      "gid": "gid://shopify/Product/0000000000000"
    }
  }`;

async function main() {
  const file = path.join(REPO_ROOT, 'catalogue.json');
  const v1 = JSON.parse(await readFile(file, 'utf8'));
  const { skeleton, notes } = migrateToV2(v1);

  console.log(JSON.stringify(skeleton, null, 2));
  console.log('');
  console.log('--- THIS IS A SKELETON, NOT A MIGRATION -------------------------------------');
  for (const note of notes) console.log(`* ${note}`);
  console.log('');
  console.log('An example "products" block, to replace the empty one above:');
  console.log('');
  console.log(EXAMPLE_PRODUCT);
  console.log('');
  console.log(`Nothing was written. ${file} is unchanged; it is hand-edited in a reviewed PR.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nERROR: ${err.message}\n`);
    process.exit(1);
  });
}
