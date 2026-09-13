// House prose rules that more than one subsystem enforces.
//
// WHY IT IS A LEAF. The em-dash rule is repo-wide (CLAUDE.md, "Formatting"), and it is enforced in
// more than one place because each subsystem writes text to a different destination: shop policies
// push a body to the live store, articles push a body to a blog post, and both must refuse the
// character before it leaves the repo. These forms started in scripts/policies/lib/policies.mjs,
// which is a module about shop policies; an articles checker importing from there would point the
// dependency arrow from one subsystem into another's internals, and would likely trip the
// import-closure guard that keeps the offline checkers free of anything that can reach the network.
//
// This file imports nothing at all, and must stay that way.
//
// THE CHARACTER IS CONSTRUCTED, NEVER TYPED. ~/.claude/scripts/check-em-dash.sh scans the tree for
// the literal character, so spelling it out here would make the definition of the rule the first
// thing to fail it. A `\u` escape would also work, but it survives fewer round trips through
// tooling that rewrites source, and a silent conversion back to the literal is exactly the failure
// this comment exists to prevent. fromCharCode cannot be converted by accident.

const EM_DASH = String.fromCharCode(0x2014);

/** The em dash, literal or entity-encoded. U+2013 (en dash) deliberately passes. */
export const EM_DASH_FORMS = Object.freeze([EM_DASH, '&mdash;', '&#8212;', '&#x2014;', '&#X2014;']);

/**
 * Does this text carry an em dash in any form this repo recognises?
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function hasEmDash(text) {
  const s = String(text ?? '');
  return EM_DASH_FORMS.some((form) => s.includes(form));
}
