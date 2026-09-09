// The operator gate for the one live write in this directory.
//
// Same shape as scripts/policies/push.mjs `assertInteractive`, and same reasons, because the risk
// class is the same: add-option-value writes to a product that is already ACTIVE and published, so
// the variants it mints are purchasable the moment they exist. A redeploy does not undo them, and
// rolling them back means deleting variants, which loses ids and history.
//
// Pure on purpose. The gate takes the environment and the TTY as arguments rather than reading them
// so its refusals are unit-testable, and so there is exactly one place to read to know what it
// permits.

export class GateError extends Error {
  constructor(subject, detail) {
    super(`${subject} ${detail}`);
    this.name = 'GateError';
    this.subject = subject;
  }
}

export const COMMAND = 'add-option-value';

/**
 * Decide whether this process may perform the write.
 *
 * THE DRY RUN IS NOT GATED ON A TERMINAL and that is deliberate: the documented sequence is "dry
 * run, show it to the operator, ask, then write", and a dry run that refuses without a TTY makes
 * the first step of that sequence unreachable from the session that has to perform it.
 *
 * `CI` IS GATED ON EVERYTHING, dry run included. No workflow wires this command; a CI environment
 * running it at all means something is calling it that was never meant to, and the useful answer to
 * that is a stop, not a preview.
 *
 * @param {object} o
 * @param {NodeJS.ProcessEnv} o.env
 * @param {boolean} o.isTTY
 * @param {boolean} [o.operatorApproved]
 * @param {boolean} [o.mutating]
 * @returns {{via: 'dry-run' | 'tty' | 'operator-approval'}} how the gate was satisfied, for the log
 */
export function assertGates({ env, isTTY, operatorApproved = false, mutating = true }) {
  if (env.CI) {
    throw new GateError(
      COMMAND,
      'refuses to run with CI set, dry run included; no workflow may add an option value to a live ' +
        'product, and no flag overrides this. Do not unset, empty, shadow or wrap CI to get past it.',
    );
  }
  if (!mutating) return { via: 'dry-run' };
  if (isTTY) return { via: 'tty' };
  if (operatorApproved) return { via: 'operator-approval' };
  throw new GateError(
    COMMAND,
    'refuses to write without a TTY on stdin. This is an operator-only command. If an operator ' +
      'asked for this write in this session, pass --operator-approved to say so explicitly, quoting ' +
      'their words and the ask they answered in the same response. Do NOT wrap the command in a pty ' +
      '(script, unbuffer, expect, setsid) to fake a TTY: that defeats the check silently, and the ' +
      'flag is the honest way to do the same thing.',
  );
}

/**
 * Compare what the operator approved against what this run computed.
 *
 * The flag attests only that a human asked. WHAT gets written is decided here, by the two numbers
 * copied off the dry run they saw, so a live run that has drifted since (a sibling product added to
 * the namespace, a variant matrix changed by hand) stops instead of writing something nobody
 * reviewed.
 *
 * @param {object} o
 * @param {string[]} o.handles - what this run resolved
 * @param {number} o.newVariants - what this run computed
 * @param {string|null} o.expectHandles - the --expect-handles value, comma separated
 * @param {string|null} o.expectNewVariants - the --expect-new-variants value
 */
export function assertExpectations({ handles, newVariants, expectHandles, expectNewVariants }) {
  if (expectHandles !== null && expectHandles !== undefined) {
    const expected = String(expectHandles).split(',').map((h) => h.trim()).filter(Boolean);
    const same = expected.length === handles.length && expected.every((h, i) => h === handles[i]);
    if (!same) {
      throw new GateError(
        '--expect-handles',
        `does not match this run: approved [${expected.join(', ')}], computed [${handles.join(', ')}]. ` +
          'Nothing was written. Re-run the dry run and take a NEW operator approval for what it shows; ' +
          'the previous approval covered a different write.',
      );
    }
  }
  if (expectNewVariants !== null && expectNewVariants !== undefined) {
    const expected = Number(expectNewVariants);
    if (!Number.isInteger(expected) || expected !== newVariants) {
      throw new GateError(
        '--expect-new-variants',
        `does not match this run: approved ${expectNewVariants}, computed ${newVariants}. Nothing was ` +
          'written. Re-run the dry run and take a NEW operator approval for what it shows.',
      );
    }
  }
}
