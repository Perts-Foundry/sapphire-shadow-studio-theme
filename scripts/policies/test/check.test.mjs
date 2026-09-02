// scripts/policies/check.mjs: one test per mismatch class, plus the offline-by-contract proof.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { check, plan, OK_MARKER } from '../check.mjs';
import { fileNameForType, fileTextFor, formatManifest } from '../lib/policies.mjs';
import { BODIES, cleanup, makeRoot, policiesDir, readManifestRaw, writeRaw } from './helpers.mjs';

/** The digest a careless hand edit would recompute. Written out here so a test that patches the
 *  manifest is patching it the way a person would, not by calling the code under test. */
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function withRoot(fn, options) {
  const root = makeRoot(options);
  try {
    return fn(root);
  } finally {
    cleanup(root);
  }
}

function editManifest(root, mutate) {
  const file = join(policiesDir(root), 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  mutate(manifest);
  writeFileSync(file, formatManifest(manifest), 'utf8');
}

test('a freshly built root is clean', () => {
  withRoot((root) => {
    const { problems, mismatches } = check(root);
    assert.deepEqual(problems, []);
    assert.deepEqual(mismatches, []);
  });
});

test('the marker is a constant the CI step greps for as a whole line', () => {
  assert.equal(OK_MARKER, 'policies:check ok');
});

// ---------------------------------------------------------------------------------------------
// Mismatch classes, one test each
// ---------------------------------------------------------------------------------------------

test('a body edited without updating the manifest is a sha and length mismatch', () => {
  withRoot((root) => {
    writeRaw(root, fileNameForType('REFUND_POLICY'), fileTextFor(`${BODIES.REFUND_POLICY}\n<p>new</p>`));
    const { mismatches } = check(root);
    assert.ok(mismatches.some((m) => m.includes('refund_policy') && m.includes('sha256')));
    assert.ok(mismatches.some((m) => m.includes('refund_policy') && m.includes('length')));
  });
});

test('a reworded heading is reported as an anchor break, naming the shared-link consequence', () => {
  withRoot((root) => {
    const body = BODIES.REFUND_POLICY.replace('<h2>Returns</h2>', '<h2>Returns and Exchanges</h2>');
    writeRaw(root, fileNameForType('REFUND_POLICY'), fileTextFor(body));
    editManifest(root, (m) => {
      const e = m.policies.refund_policy;
      // Update only the hash and length, the way a careless hand edit would.
      e.sha256 = sha(body);
      e.length = body.length;
    });
    const { mismatches } = check(root);
    const anchor = mismatches.find((m) => m.includes('heading 1'));
    assert.ok(anchor, 'expected a heading mismatch');
    assert.ok(anchor.includes('anchor'));
  });
});

test('a missing policy file is a problem, not a silent skip', () => {
  withRoot((root) => {
    rmSync(join(policiesDir(root), fileNameForType('SHIPPING_POLICY')));
    const { problems } = check(root);
    assert.ok(problems.some((p) => p.includes('shipping_policy.html is missing')));
  });
});

test('a file that is not in canonical form is a problem', () => {
  withRoot((root) => {
    writeRaw(root, fileNameForType('REFUND_POLICY'), `${BODIES.REFUND_POLICY}\r\n`);
    const { problems } = check(root);
    assert.ok(problems.some((p) => p.includes('not in canonical form')));
  });
});

test('a missing final newline is a problem', () => {
  withRoot((root) => {
    writeRaw(root, fileNameForType('REFUND_POLICY'), BODIES.REFUND_POLICY);
    const { problems } = check(root);
    assert.ok(problems.some((p) => p.includes('not in canonical form')));
  });
});

test('an em dash in a WRITABLE policy is a refusal', () => {
  withRoot((root) => {
    const body = `${BODIES.REFUND_POLICY}\n<p>a\u2014b</p>`;
    writeRaw(root, fileNameForType('REFUND_POLICY'), fileTextFor(body));
    const { problems } = check(root);
    assert.ok(problems.some((p) => p.includes('em dash')));
  });
});

test('an em dash in the auto-managed privacy policy is a NOTE, never a refusal', () => {
  // Shopify rewrites that body on its own schedule. CI must warn rather than go permanently red on
  // something nobody here can fix.
  withRoot((root) => {
    const body = `${BODIES.PRIVACY_POLICY}\n<p>a\u2014b</p>`;
    writeRaw(root, fileNameForType('PRIVACY_POLICY'), fileTextFor(body));
    editManifest(root, (m) => {
      const e = m.policies.privacy_policy;
      e.sha256 = sha(body);
      e.length = body.length;
    });
    const { problems, notes } = check(root);
    assert.equal(problems.filter((p) => p.includes('em dash')).length, 0);
    assert.ok(notes.some((n) => n.includes('em dash')));
  });
});

test('two h2 headings that slugify alike are a refusal, naming the silent "-2" suffix', () => {
  withRoot((root) => {
    const body = '<h2>Rush Orders</h2>\n<p>a</p>\n<h2>Rush  Orders!</h2>\n<p>b</p>';
    writeRaw(root, fileNameForType('REFUND_POLICY'), fileTextFor(body));
    const { problems } = check(root);
    const dupe = problems.find((p) => p.includes('slugify to the same id'));
    assert.ok(dupe);
    assert.ok(dupe.includes('-2'));
  });
});

test('an unexpected file under marketing/policies/ is a problem', () => {
  withRoot((root) => {
    writeRaw(root, 'notes.html', '<p>x</p>\n');
    const { problems } = check(root);
    assert.ok(problems.some((p) => p.includes('notes.html') && p.includes('unexpected file')));
  });
});

test('README.md and manifest.json are excluded, so a second doc file does not turn CI red', () => {
  // Without the exclusion, adding any documentation here would be a failure.
  withRoot((root) => {
    writeRaw(root, 'README.md', '# policies\n\nmore prose\n');
    const { problems, mismatches } = check(root);
    assert.deepEqual(problems, []);
    assert.deepEqual(mismatches, []);
  });
});

test('a manifest entry for an untracked policy is a problem, and a missing one too', () => {
  withRoot((root) => {
    editManifest(root, (m) => {
      m.policies.terms_of_sale = { ...m.policies.refund_policy };
      delete m.policies.refund_policy;
    });
    const { problems } = check(root);
    assert.ok(problems.some((p) => p.includes('terms_of_sale') && p.includes('no tracked ShopPolicyType')));
    assert.ok(problems.some((p) => p.includes('refund_policy') && p.includes('no manifest entry')));
  });
});

test('a blank title is a mismatch', () => {
  withRoot((root) => {
    editManifest(root, (m) => {
      m.policies.refund_policy.title = '   ';
    });
    assert.ok(check(root).mismatches.some((m) => m.includes('title must be a non-empty string')));
  });
});

test('the non-writable entry must carry a reason, and a writable one must not', () => {
  withRoot((root) => {
    editManifest(root, (m) => {
      delete m.policies.privacy_policy.reason;
      m.policies.refund_policy.reason = 'why not';
    });
    const { mismatches } = check(root);
    assert.ok(mismatches.some((m) => m.includes('privacy_policy') && m.includes('no "reason"')));
    assert.ok(mismatches.some((m) => m.includes('refund_policy') && m.includes('belongs only on an entry')));
  });
});

test('a malformed remote token or pulledAt is a mismatch', () => {
  withRoot((root) => {
    editManifest(root, (m) => {
      m.policies.refund_policy.remote = { sha256: 'nope', length: -1, observedAt: 'yesterday' };
      m.policies.shipping_policy.pulledAt = 'recently';
      delete m.policies.contact_information.remote;
    });
    const { mismatches } = check(root);
    assert.ok(mismatches.some((m) => m.includes('remote.sha256 is not a sha256 digest')));
    assert.ok(mismatches.some((m) => m.includes('remote.length is not a non-negative integer')));
    assert.ok(mismatches.some((m) => m.includes('remote.observedAt is not an ISO-8601')));
    assert.ok(mismatches.some((m) => m.includes('pulledAt is not an ISO-8601')));
    assert.ok(mismatches.some((m) => m.includes('contact_information') && m.includes('no "remote" token')));
  });
});

test('a repo body ahead of the last observed Admin body is a NOTE saying a push is outstanding', () => {
  // This is the normal state between a wording commit and the push that applies it. It must not
  // read as an error, and it must not read as silence either.
  withRoot((root) => {
    editManifest(root, (m) => {
      m.policies.shipping_policy.remote.sha256 = 'f'.repeat(64);
    });
    const { problems, mismatches, notes } = check(root);
    assert.deepEqual(problems, []);
    assert.deepEqual(mismatches, []);
    assert.ok(notes.some((n) => n.includes('a push is outstanding') && n.includes('SHIPPING_POLICY')));
  });
});

test('a manifest with no "policies" object throws rather than passing vacuously', () => {
  withRoot((root) => {
    writeFileSync(join(policiesDir(root), 'manifest.json'), '{}\n', 'utf8');
    assert.throws(() => check(root), /missing "policies" object/);
  });
});

// ---------------------------------------------------------------------------------------------
// Offline by contract
// ---------------------------------------------------------------------------------------------

test('check runs clean with every Shopify credential deleted from the environment', () => {
  const saved = {};
  for (const name of ['MYSHOPIFY_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  try {
    withRoot((root) => {
      const { problems, mismatches } = check(root);
      assert.deepEqual(problems, []);
      assert.deepEqual(mismatches, []);
    });
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value;
  }
});

test('check.mjs and lib/policies.mjs import nothing that can reach the network', () => {
  // The guarantee is structural, not a promise in a comment: neither file may import the Admin
  // client, node:http(s), or anything under blank-inventory/ or site-check/.
  const banned = /from '(node:https?|.*blank-inventory.*|.*site-check.*)'/;
  for (const file of ['../check.mjs', '../lib/policies.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(banned.test(source), false, `${file} imports something that can reach the network`);
    assert.equal(/\bfetch\s*\(/.test(source), false, `${file} calls fetch`);
  }
});

test('plan exposes the bodies it read, so pull does not read them twice', () => {
  withRoot((root) => {
    const { bodies } = plan(root);
    assert.equal(bodies.get('REFUND_POLICY'), BODIES.REFUND_POLICY);
  });
});

test('the manifest bytes a fresh root writes are byte-stable across two builds', () => {
  const a = makeRoot();
  const b = makeRoot();
  try {
    assert.equal(readManifestRaw(a), readManifestRaw(b));
  } finally {
    cleanup(a);
    cleanup(b);
  }
});
