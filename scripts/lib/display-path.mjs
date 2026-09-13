// The display form of a filesystem path for anything a person may paste somewhere public.
//
// WHY IT IS A LEAF. `$HOME` collapsed to `~` is a rule from CLAUDE.md ("Sensitive Content"): an
// absolute path under a home directory carries the operator's username, which this public repo bars
// from the tree, from PRs and from issues, and the paths this collapses are printed in exactly the
// messages an operator pastes into one. It started in scripts/policies/lib/backups.mjs, which is a
// module about where backups go; the observation state needs the same rule, and so does anything
// else that prints a machine-local path. It lives here so importing it costs nothing and there is
// one implementation rather than one per subsystem.
//
// This file imports nothing but node builtins, and must stay that way: backups.mjs promises in its
// own header that it touches no filesystem, and it re-exports this binding.

import os from 'node:os';
import path from 'node:path';

/**
 * `$HOME` collapsed to `~`, or the path unchanged when it lies outside the home directory.
 *
 * The comparison is a PATH match, not a prefix match: `/home/tester-other/x` is not inside
 * `/home/tester`, and collapsing it would rewrite an unrelated path. An empty or unknown home
 * collapses nothing, rather than collapsing everything.
 *
 * @param {string} absolute
 * @param {string} [home]
 * @returns {string}
 */
export function displayPath(absolute, home = os.homedir()) {
  const abs = String(absolute);
  if (home && (abs === home || abs.startsWith(`${home}${path.sep}`))) {
    return `~${abs.slice(home.length)}`;
  }
  return abs;
}
