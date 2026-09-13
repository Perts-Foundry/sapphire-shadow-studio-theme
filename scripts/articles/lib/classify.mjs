// Where one article stands, and the one thing to do next. Pure: no fs, no fetch, no process.env.
//
// Shared by `articles:status` (offline, and with `--live`) and `articles:pull -- --check`, so the
// two commands cannot name the same situation differently.
//
// ONE DESTINATION PER STATE. A state that maps to "it depends" is a state nobody can act on.

import { fieldDifferences, liveProjection, projectionSha } from './projection.mjs';
import { CHECK_COMMAND, SEED_COMMAND, intentFor, observationByHandle, observationFor, recordedImageSource } from './state.mjs';

export const STATES = Object.freeze({
  IN_SYNC: 'in sync',
  NEVER_PUSHED: 'never pushed: a create is outstanding',
  REPO_AHEAD: 'repo ahead: a push is outstanding',
  ADMIN_MOVED: 'Admin moved since this machine last observed it',
  NO_BASELINE: 'unknown: live, but this machine holds no observation for it',
  STATE_ABSENT: 'unknown: no observation state on this machine',
  PENDING_INTENT: 'an interrupted push has not been reconciled',
  LIVE_ONLY: 'live, with no repo directory',
});

/**
 * Offline: the repo against the last observation, no network.
 *
 * Without a live read "Admin moved" is unknowable, so it is never reported here; the output says so.
 * PRECEDENCE: no state file, then an unreconciled intent, then no observation for this handle (never
 * pushed from this machine), then whether the last observation matched this exact repo projection.
 *
 * @param {object} o
 * @param {string} o.handle
 * @param {string} o.repoSha   the repo projection hash
 * @param {object|null} o.state
 */
export function classifyOffline({ handle, repoSha, state }) {
  if (state === null) return STATES.STATE_ABSENT;
  if (intentFor(state, handle)) return STATES.PENDING_INTENT;
  const hit = observationByHandle(state, handle);
  if (hit === null) return STATES.NEVER_PUSHED;
  return hit[1].matchedRepoSha256 === repoSha ? STATES.IN_SYNC : STATES.REPO_AHEAD;
}

/**
 * Live: the repo against a fresh read AND the last observation.
 *
 * PRECEDENCE: an unreconciled intent; a live article no repo directory claims; a repo article with
 * nothing live; a live article with no observation (no state file, or none for this GID); a live
 * article that differs from its observation (Admin moved, which outranks everything after it because
 * pushing over it would clobber that edit); then whether the repo and live agree on every written
 * field. Visibility is reported separately by the caller and is not a field difference here.
 *
 * @param {object} o
 * @param {{article: object, projection: object}|null} o.repo
 * @param {object|null} o.node   the live article this repo directory resolves to, or null
 * @param {object|null} o.state
 */
export function classifyLive({ repo, node, state }) {
  const handle = repo?.article?.handle ?? node?.handle;
  if (state !== null && intentFor(state, handle)) return STATES.PENDING_INTENT;
  if (repo === null) return STATES.LIVE_ONLY;
  if (node === null) return STATES.NEVER_PUSHED;
  const observation = state === null ? undefined : observationFor(state, node.id);
  if (!observation) return state === null ? STATES.STATE_ABSENT : STATES.NO_BASELINE;
  const live = liveProjection(node);
  if (projectionSha(live) !== observation.liveSha256) return STATES.ADMIN_MOVED;
  const imageSource = recordedImageSource(observation, live.imageUrl);
  return fieldDifferences(repo.projection, live, { ignore: ['isPublished'], imageSource }).length === 0 ? STATES.IN_SYNC : STATES.REPO_AHEAD;
}

/**
 * The one next step for a state.
 *
 * The push is described, never spelled: every file under scripts/ is scanned by the no-invocation
 * guard, and a printed command line is exactly what gets pasted into a script.
 */
export function nextStep(state, handle) {
  switch (state) {
    case STATES.IN_SYNC:
      return 'nothing to do';
    case STATES.NEVER_PUSHED:
    case STATES.REPO_AHEAD:
      return `the article push for ${handle}, dry run first (scripts/articles/README.md)`;
    case STATES.ADMIN_MOVED:
      return `${CHECK_COMMAND}   (read both sides; the push refuses until the baseline is current)`;
    case STATES.NO_BASELINE:
    case STATES.STATE_ABSENT:
    case STATES.PENDING_INTENT:
      return `${CHECK_COMMAND}, then ${SEED_COMMAND}`;
    case STATES.LIVE_ONLY:
      return 'nothing automatic: it exists only in Admin; decide there, or add a repo directory for it';
    default:
      return 'stop and look: this state has no next step';
  }
}
