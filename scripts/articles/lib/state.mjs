// The machine-local record of what Admin was last seen holding, for blog articles.
//
// THE MECHANISM LIVES IN scripts/lib/observation-state.mjs and is shared with shop policies. This
// file is the ARTICLES CONFIGURATION of it, plus what is genuinely article-specific: what one
// observation holds, that observations are keyed by ARTICLE GID, and the intent records a push
// writes before it mutates.
//
//   $XDG_STATE_HOME/sapphire-articles-state/observed.json   (default)
//   $ARTICLES_STATE_DIR/observed.json                       (override)
//
// A SIBLING of the backup directory (`sapphire-articles`), never a child of it, following the
// policies naming shape (`shop-policies` and `shop-policies-state`): deleting old backups must never
// take the freshness baseline with it.
//
// KEYED BY GID, NOT HANDLE. A handle is a directory name, and renaming a directory is an ordinary
// edit. If observations were keyed by handle, a rename would present as "no observation for this
// article", which is the state a first push starts from, and the freshness gate would be reset by a
// `git mv`. The GID is Shopify's identity for the article and does not move when its handle does, so
// the push resolves the live article (through `previousHandles` when renamed) and reads its
// observation by GID.
//
// INTENTS live beside the observations, under `intents`, keyed by handle (a create has no GID yet).
// A push writes one before it sends the mutation and clears it once the outcome is known. One that
// survives means a run ended between "sent" and "know what happened", and the next push refuses until
// `articles:pull -- --seed` records what Admin holds and clears it.
//
// `check` NEVER reads this file. `pull --seed` writes it and never requires it. `push` requires it
// whenever a live article exists.

import {
  DIR_MODE as SHARED_DIR_MODE,
  FILE_MODE as SHARED_FILE_MODE,
  STATE_FILE_BASENAME as SHARED_STATE_FILE_BASENAME,
  createObservationState,
} from '../../lib/observation-state.mjs';
import { ArticleError } from './context.mjs';

export const STATE_SCHEMA_VERSION = 1;
export const STATE_DIR_BASENAME = 'sapphire-articles-state';
export const STATE_ENV_VAR = 'ARTICLES_STATE_DIR';
export const STATE_FILE_BASENAME = SHARED_STATE_FILE_BASENAME;
export const DIR_MODE = SHARED_DIR_MODE;
export const FILE_MODE = SHARED_FILE_MODE;

/** The command every state refusal names. One string, so tests assert it verbatim. */
export const SEED_COMMAND = 'npm run articles:pull -- --seed';

/** The read that shows both sides before anything is seeded. */
export const CHECK_COMMAND = 'npm run articles:pull -- --check';

const store = createObservationState({
  dirBasename: STATE_DIR_BASENAME,
  envVar: STATE_ENV_VAR,
  entriesKey: 'articles',
  seedCommand: SEED_COMMAND,
  schemaVersion: STATE_SCHEMA_VERSION,
  ErrorClass: ArticleError,
});

export function defaultStateDir(env) {
  return store.defaultDir(env);
}

export function resolveStateDir(env) {
  return store.resolveDir(env);
}

export function stateFilePath(dir) {
  return store.filePath(dir);
}

export function assertStateDirOutsideRepo(dir, root) {
  return store.assertOutsideRepo(dir, root);
}

export function emptyState() {
  return { ...store.emptyState(), intents: {} };
}

/**
 * Read the state file, or null when there is none. Unusable is a refusal, absent is a fact.
 *
 * An `intents` value that is present and not an object is a refusal too: a push must never read a
 * corrupt intent table as "no intents".
 */
export function readState({ dir, root }) {
  const state = store.read({ dir, root });
  if (state === null) return null;
  if (state.intents === undefined) return { ...state, intents: {} };
  if (!state.intents || typeof state.intents !== 'object' || Array.isArray(state.intents)) {
    throw new ArticleError(store.describe(dir).display, `has an "intents" value that is not an object; delete it and run ${SEED_COMMAND}`);
  }
  return state;
}

export function writeState({ dir, root, state }) {
  return store.write({ dir, root, state });
}

export function describeState(dir) {
  return store.describe(dir);
}

/** One observation by article GID, or undefined. */
export function observationFor(state, gid) {
  return store.entry(state, gid);
}

/** The `[gid, observation]` whose recorded handle is `handle`, or null. */
export function observationByHandle(state, handle) {
  for (const [gid, entry] of Object.entries(state?.articles ?? {})) {
    if (entry?.handle === handle) return [gid, entry];
  }
  return null;
}

/**
 * What one observation holds. Every field is taken from a LIVE read.
 *
 * `liveSha256` is the freshness baseline: the projection hash of everything the push writes, exactly
 * as Admin returned it. `matchedRepoSha256` is the repo projection hash this live article was last
 * confirmed equivalent to, or null when it was not; status reads it to say "clean" or "drifted"
 * without a network call.
 */
export function makeObservation({ node, liveSha256, bodySha256, matchedRepoSha256, now, unverified = false }) {
  const out = {
    handle: node.handle,
    blogId: node.blog?.id ?? null,
    liveSha256,
    bodySha256,
    isPublished: node.isPublished === true,
    matchedRepoSha256: matchedRepoSha256 ?? null,
    observedAt: now,
  };
  if (unverified) out.unverified = true;
  return out;
}

/** A new state with one observation set. Pure: the input is not modified. */
export function withObservation(state, gid, observation) {
  const base = state ?? emptyState();
  return { ...base, articles: { ...base.articles, [gid]: observation }, intents: { ...(base.intents ?? {}) } };
}

export function intentFor(state, handle) {
  return state?.intents?.[handle];
}

export function withIntent(state, handle, intent) {
  const base = state ?? emptyState();
  return { ...base, articles: { ...base.articles }, intents: { ...(base.intents ?? {}), [handle]: intent } };
}

export function withoutIntent(state, handle) {
  const base = state ?? emptyState();
  const intents = { ...(base.intents ?? {}) };
  delete intents[handle];
  return { ...base, articles: { ...base.articles }, intents };
}
