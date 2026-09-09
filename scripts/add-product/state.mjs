#!/usr/bin/env node
// The per-product run record: init, set, confirm-na, show, close.
//
// This command writes NOTHING outside the state directory and reads nothing from the network. It is
// a notebook, and the file it keeps is a record of checks that already passed. Nothing in it
// authorises anything: an `evidence` string that says an operator approved a live write is a string
// someone typed, and the only approval that counts is a message from the operator in the session's
// own transcript.
//
// Decisions live in lib/state.mjs (pure) and bytes move in lib/store.mjs. This file is argument
// handling and printing, which is why it is short.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { AddProductError, parseArgs, resolveHandles } from './lib/args.mjs';
import {
  DATA_BANNER,
  ENTRY_TYPES,
  STATUS_NA_PRESUMED,
  StateError,
  assertStepId,
  closeState,
  confirmNa,
  createState,
  priorAgreement,
  renderState,
  setStep,
  statusOf,
} from './lib/state.mjs';
import { archiveState, listHandles, readState, stateExists, writeState } from './lib/store.mjs';
import { resolveStateDir } from './lib/workdir.mjs';

export const USAGE = `Usage: state.mjs <command> [options]

  init --handle a[,b,c] --entry <entry> [--title T] [--gid G] [--body B] [--template-suffix S]
      Create the run file(s) and pre-fill the entry type's not-applicable steps as na_presumed.
      Entries: ${ENTRY_TYPES.join(' | ')}
      Refuses to overwrite an existing file; use show to read it.
      Per-product facts (--title, --gid, --body, --template-suffix) take a single --handle.

  set <step> --handle a[,b,c] [--all-handles] (--evidence "text" | --evidence-file path)...
      Record a step done. Evidence holds the completion check's concrete result (an id, a path, a
      count), not prose. More than one handle needs --all-handles and one evidence per handle,
      matched positionally; --shared-evidence takes a single string for all of them.
      Refuses when the named handles are not in the same state for that step.

  confirm-na <step> --handle a[,b,c] [--all-handles] [--evidence "text"]
      Promote na_presumed to na_confirmed once the owning phase has actually checked it.

  show [--handle a[,b,c]]
      Render the run(s). With no --handle, every run in the state directory.

  close --handle a[,b,c] [--all-handles] --archive
      Stamp closed_at and move the file under <state-dir>/archive/.

State directory: $ADD_PRODUCT_DIR, else $XDG_STATE_HOME/add-product, else ~/.local/state/add-product.
Exit codes: 0 ok, 2 usage error or refusal.`;

const SPEC = {
  booleans: ['--help', '--all-handles', '--shared-evidence', '--archive'],
  values: ['--handle', '--entry', '--title', '--gid', '--body', '--template-suffix'],
  repeatables: ['--evidence', '--evidence-file'],
};

/**
 * Collect the evidence strings for a write.
 *
 * Per-handle by default, matched positionally, because the evidence IS the completion check's
 * result and two products do not produce the same one. `--shared-evidence` exists for the case
 * where they genuinely do (one PR, one CI run), and it has to be asked for.
 */
function evidenceFor(flags, handles, { required }) {
  const inline = flags.evidence ?? [];
  const files = flags.evidenceFile ?? [];
  if (inline.length && files.length) {
    throw new AddProductError('--evidence', 'and --evidence-file cannot be mixed in one write');
  }
  const raw = inline.length
    ? inline
    : files.map((p) => {
        const file = path.resolve(p);
        try {
          return fs.readFileSync(file, 'utf8');
        } catch (err) {
          throw new AddProductError('--evidence-file', `${p} could not be read (${err.code ?? err.message})`);
        }
      });
  if (raw.length === 0) {
    if (!required) return handles.map(() => null);
    throw new AddProductError('--evidence', 'is required; record the completion check result, not prose');
  }
  if (flags.sharedEvidence) {
    if (raw.length !== 1) throw new AddProductError('--shared-evidence', `takes exactly one evidence string, got ${raw.length}`);
    return handles.map(() => raw[0]);
  }
  if (raw.length !== handles.length) {
    throw new AddProductError(
      '--evidence',
      `was given ${raw.length} time(s) for ${handles.length} handle(s). Evidence is per handle and matched in ` +
        'order; pass one per handle, or --shared-evidence with a single string.',
    );
  }
  return raw;
}

function requireAllHandles(handles, flags) {
  if (handles.length > 1 && !flags.allHandles) {
    throw new AddProductError('--all-handles', `is required to write ${handles.length} handles in one command`);
  }
}

/**
 * @param {object} o
 * @param {string[]} o.argv - argv after the node binary and script path
 * @param {NodeJS.ProcessEnv} [o.env]
 * @param {() => string} [o.now]
 * @param {(s: string) => void} [o.log]
 * @param {(s: string) => void} [o.errLog]
 * @returns {number} exit code
 */
export function runState({ argv, env = process.env, now = () => new Date().toISOString(), log = console.log, errLog = console.error }) {
  let positionals;
  let flags;
  try {
    ({ positionals, flags } = parseArgs(argv, SPEC));
  } catch (err) {
    errLog(`error: ${err.message}`);
    errLog(USAGE);
    return 2;
  }
  if (flags.help || positionals.length === 0) {
    log(USAGE);
    return flags.help ? 0 : 2;
  }

  const dir = resolveStateDir(env);
  const command = positionals[0];

  try {
    switch (command) {
      case 'init':
        return cmdInit({ positionals, flags, dir, now, log });
      case 'set':
        return cmdSet({ positionals, flags, dir, now, log, errLog });
      case 'confirm-na':
        return cmdConfirmNa({ positionals, flags, dir, now, log, errLog });
      case 'show':
        return cmdShow({ flags, dir, log, errLog });
      case 'close':
        return cmdClose({ flags, dir, now, log, errLog });
      default:
        throw new AddProductError(command, 'is not a command; one of init, set, confirm-na, show, close');
    }
  } catch (err) {
    if (err instanceof AddProductError || err instanceof StateError) {
      errLog(`error: ${err.message}`);
      errLog('nothing was written');
      return 2;
    }
    throw err;
  }
}

function cmdInit({ positionals, flags, dir, now, log }) {
  if (positionals.length > 1) throw new AddProductError(positionals[1], 'is not an argument init takes');
  const handles = resolveHandles({ handle: flags.handle });
  if (!flags.entry) throw new AddProductError('--entry', `is required; one of ${ENTRY_TYPES.join(', ')}`);
  const perProduct = [
    ['--title', flags.title],
    ['--gid', flags.gid],
    ['--body', flags.body],
    ['--template-suffix', flags.templateSuffix],
  ].filter(([, v]) => v !== null);
  if (handles.length > 1 && perProduct.length) {
    throw new AddProductError(
      perProduct[0][0],
      'names one product; init several handles without it, then record each product facts with its own init or set',
    );
  }
  const stamp = now();

  // Check EVERY handle before writing ANY of them. Interleaving the check with the write means
  // `init --handle a,b` where b already exists writes a, then throws, leaving the run half
  // initialised: a state file for one product of a set that is meant to move together, and a
  // command that reported failure. The multi-handle `set` path refuses outright when the named
  // handles disagree, and init has to hold the same line or the disagreement it refuses is one
  // init created.
  const existing = handles.filter((handle) => stateExists(dir, handle));
  if (existing.length) {
    throw new AddProductError(
      existing.join(', '),
      `already ${existing.length > 1 ? 'have state files' : 'has a state file'}; read ${existing.length > 1 ? 'them' : 'it'} ` +
        `with show rather than re-initialising, and nothing was written for the others either (${dir})`,
    );
  }

  const written = [];
  for (const handle of handles) {
    const state = createState({
      handle,
      entry: flags.entry,
      now: stamp,
      title: flags.title,
      gid: flags.gid,
      templateSuffix: flags.templateSuffix,
      body: flags.body,
    });
    written.push(writeState(dir, state));
  }
  log(`# ${DATA_BANNER}`);
  for (const file of written) log(`created ${file}`);
  const presumed = Object.keys(createState({ handle: handles[0], entry: flags.entry, now: stamp }).steps);
  log(presumed.length ? `pre-filled as ${STATUS_NA_PRESUMED}: ${presumed.join(', ')}` : 'no steps pre-filled for this entry type');
  return 0;
}

function cmdSet({ positionals, flags, dir, now, log, errLog }) {
  const step = positionals[1];
  if (!step) throw new AddProductError('set', 'needs a step id: set <step> --handle h --evidence "..."');
  if (positionals.length > 2) throw new AddProductError(positionals[2], 'is not an argument set takes');
  assertStepId(step);
  const handles = resolveHandles({ handle: flags.handle });
  requireAllHandles(handles, flags);
  const evidence = evidenceFor(flags, handles, { required: true });

  // Read every handle BEFORE writing any: a multi-handle write must be all-or-nothing about its
  // precondition, or a refusal leaves half the run advanced.
  const entries = handles.map((handle) => ({ handle, ...readState(dir, handle) }));
  for (const e of entries) reportDropped(e, errLog);
  const { agree, byStatus } = priorAgreement(entries, step);
  if (!agree) {
    const detail = Object.entries(byStatus).map(([status, hs]) => `${status}: ${hs.join(', ')}`).join('; ');
    throw new AddProductError(
      step,
      `is not in the same state across these handles (${detail}). They have diverged; check the ones that are ` +
        'behind before recording one fact across all of them.',
    );
  }

  const stamp = now();
  entries.forEach((e, i) => {
    writeState(dir, setStep(e.state, step, { evidence: evidence[i], now: stamp }));
  });
  log(`# ${DATA_BANNER}`);
  for (const e of entries) log(`${e.handle}: ${step} = done`);
  return 0;
}

function cmdConfirmNa({ positionals, flags, dir, now, log, errLog }) {
  const step = positionals[1];
  if (!step) throw new AddProductError('confirm-na', 'needs a step id: confirm-na <step> --handle h');
  if (positionals.length > 2) throw new AddProductError(positionals[2], 'is not an argument confirm-na takes');
  assertStepId(step);
  const handles = resolveHandles({ handle: flags.handle });
  requireAllHandles(handles, flags);
  const evidence = evidenceFor(flags, handles, { required: false });

  const entries = handles.map((handle) => ({ handle, ...readState(dir, handle) }));
  for (const e of entries) reportDropped(e, errLog);
  const stamp = now();
  const updated = entries.map((e, i) => confirmNa(e.state, step, { evidence: evidence[i], now: stamp }));
  for (const state of updated) writeState(dir, state);
  log(`# ${DATA_BANNER}`);
  for (const state of updated) log(`${state.handle}: ${step} = ${statusOf(state, step)}`);
  return 0;
}

function cmdShow({ flags, dir, log, errLog }) {
  const handles = flags.handle === null ? listHandles(dir) : resolveHandles({ handle: flags.handle });
  if (handles.length === 0) {
    log(`no runs in ${dir}`);
    return 0;
  }
  const rendered = [];
  for (const handle of handles) {
    const entry = readState(dir, handle);
    reportDropped({ handle, ...entry }, errLog);
    rendered.push(renderState(entry.state));
  }
  log(rendered.join('\n\n'));
  return 0;
}

function cmdClose({ flags, dir, now, log, errLog }) {
  const handles = resolveHandles({ handle: flags.handle });
  requireAllHandles(handles, flags);
  if (!flags.archive) {
    throw new AddProductError('close', 'takes --archive; closing a run moves its file under <state-dir>/archive/');
  }
  const stamp = now();
  const entries = handles.map((handle) => ({ handle, ...readState(dir, handle) }));
  for (const e of entries) reportDropped(e, errLog);
  log(`# ${DATA_BANNER}`);
  for (const e of entries) {
    writeState(dir, closeState(e.state, { now: stamp }));
    log(`${e.handle}: closed, archived to ${archiveState(dir, e.handle, stamp)}`);
  }
  return 0;
}

/** Unknown keys are reported and dropped, never merged forward. The report goes to stderr. */
function reportDropped({ handle, dropped }, errLog) {
  if (!dropped.length) return;
  errLog(`warning: ${handle}.json holds key(s) this tool does not know and did not read: ${dropped.join(', ')}`);
}

// Run as a script, but stay importable by the unit tests. import.meta.url is percent-encoded, so
// the comparison goes through pathToFileURL rather than a string built from a path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runState({ argv: process.argv.slice(2) });
}
