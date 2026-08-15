// Shared retry helper for `deploy.yml`'s `actions/github-script` steps.
//
// WHY A FILE: three steps in the `deploy` job (Post deploy report, Squash
// merge, Report failure) each need the same helper, and `github-script` steps
// do not share scope, so the preamble was copied verbatim three times. A YAML
// anchor is not an option; GitHub Actions does not support them.
//
// HOW IT IS LOADED: each step does
//
//   const { isTransient, makeWithRetry } = require(
//     require('node:path').resolve(process.env.GITHUB_WORKSPACE, '.github/scripts/with-retry.js')
//   );
//   const withRetry = makeWithRetry(core);
//
// The absolute path is required: a relative `require` would resolve against
// `actions/github-script`'s own directory, not the workspace.
//
// TRUST NOTE: this loads PR-branch content into the same process that holds
// the job's `contents:write` / `pull-requests:write` token, exactly as the
// existing `report-format.mjs` dynamic import in the same step already does.
// That exposure is accepted under this repo's threat model (see CLAUDE.md's
// "Deploy gate trust delta"); it is not widened by this file.

const RETRYABLE = new Set([500, 502, 503, 504]);
const NON_RETRYABLE = new Set([400, 401, 403, 404, 405, 409, 422]);

/**
 * True when an Octokit error looks worth retrying.
 * @param {{status?: number, message?: string}} err
 * @returns {boolean}
 */
const isTransient = (err) => {
  if (NON_RETRYABLE.has(err.status)) return false;
  if (RETRYABLE.has(err.status)) return true;
  const m = err.message || '';
  return /Unexpected end of JSON|ECONNRESET|ETIMEDOUT|socket hang up|network|fetch failed/.test(m);
};

/**
 * Build a `withRetry` bound to a `github-script` `core` for warning output.
 * Retries with exponential backoff, only on transient errors.
 * @param {{warning: (msg: string) => void}} core
 * @returns {(fn: () => Promise<any>, opts?: {attempts?: number, delayMs?: number, label?: string}) => Promise<any>}
 */
const makeWithRetry = (core) => async (fn, { attempts = 3, delayMs = 2000, label = 'API call' } = {}) => {
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (err) {
      if (i < attempts && isTransient(err)) {
        const wait = delayMs * Math.pow(2, i - 1);
        core.warning(`${label} attempt ${i}/${attempts} failed: ${err.message}. Retrying in ${wait}ms.`);
        await new Promise(r => setTimeout(r, wait));
      } else { throw err; }
    }
  }
};

module.exports = { RETRYABLE, NON_RETRYABLE, isTransient, makeWithRetry };
