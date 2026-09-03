#!/usr/bin/env node
// Copies a file's text to the system clipboard for the paste step of the notification-templates
// skill, so the bytes that reach the Admin editor are the repo file's bytes and not a re-typed
// copy. Detects the platform tool; fails with a clear message when none is available. Then reads
// the clipboard straight back and refuses to report success unless it holds the file, so a copy
// that did not land fails here instead of in the browser several tool calls later.
//
//   node scripts/notifications/clipboard.mjs <file> [--no-verify]
//
// Tools, in order: pbcopy (macOS), wl-copy (Wayland, when WAYLAND_DISPLAY is set), xclip (X11),
// clip.exe (WSL: /proc/version names Microsoft; the text is sent as UTF-16LE WITHOUT a byte-order
// mark: clip.exe takes UTF-16LE as is, and a BOM is pasted into the editor as a U+FEFF character,
// which the byte check caught on the first run as "one character too long").
//
// The printed `<length> <fnv>` pair is the same one `dump.mjs --hash` prints and the same one the
// browser's SSSPOLL line reports, so the three are compared directly rather than by eye.
//
// What the read-back is, and is not. It proves the clipboard held the file at the moment it was
// read; it cannot prove the paste that follows delivers it, which is why the skill's pre-Save byte
// gate stays exactly as strict as it was. Only the WSL reader has been measured here
// (clip.exe out, `powershell.exe Get-Clipboard -Raw` back, 35 round trips of a 23 KB and a 166 KB
// template: every one byte-exact once CRLF is normalised). One separate read did come back empty
// on a cold interop call, which is why a mismatching read is taken twice before it is believed.
// The pbpaste, wl-paste and xclip readers are written from those tools' documented behaviour and
// have NOT been exercised; on a platform where one of them misreports, `--no-verify` skips the
// check rather than blocking the run, and the browser byte gate still stands behind it.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fnv1a } from './dump.mjs';

// -Raw keeps the clipboard as one string (without it PowerShell emits an array of lines and the
// pipeline appends a newline); the output encoding keeps non-ASCII intact; the $null guard is for
// an empty clipboard, which Get-Clipboard answers with $null.
const PS_READ = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $t = Get-Clipboard -Raw; if ($null -ne $t) { [Console]::Out.Write($t) }';

// The reader that reads back what each copy tool wrote. Keyed by copy tool, because the pairing is
// the point: pbcopy/pbpaste, wl-copy/wl-paste and xclip's own -o all address the same selection.
export const READERS = {
  pbcopy: { cmd: 'pbpaste', args: [] },
  'wl-copy': { cmd: 'wl-paste', args: ['-n'] },
  xclip: { cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] },
  'clip.exe': { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', PS_READ] },
};

export function onPath(name, env = process.env) {
  return (env.PATH || '').split(delimiter).some((d) => d && existsSync(join(d, name)));
}

export function isWsl(readVersion = () => (existsSync('/proc/version') ? readFileSync('/proc/version', 'utf8') : '')) {
  return /microsoft/i.test(readVersion());
}

// Picks the tool: { cmd, args, encoding } or null. `has` and `wsl` are injectable for the tests.
export function pickTool({ platform = process.platform, env = process.env, has = (n) => onPath(n, env), wsl = () => isWsl() } = {}) {
  if (platform === 'darwin' && has('pbcopy')) return { cmd: 'pbcopy', args: [], encoding: 'utf8' };
  if (env.WAYLAND_DISPLAY && has('wl-copy')) return { cmd: 'wl-copy', args: [], encoding: 'utf8' };
  if (has('xclip')) return { cmd: 'xclip', args: ['-selection', 'clipboard'], encoding: 'utf8' };
  if (wsl() && has('clip.exe')) return { cmd: 'clip.exe', args: [], encoding: 'utf16le' };
  if (platform === 'win32' && has('clip.exe')) return { cmd: 'clip.exe', args: [], encoding: 'utf16le' };
  return null;
}

export function encodeFor(text, encoding) {
  if (encoding === 'utf8') return Buffer.from(text, 'utf8');
  if (encoding === 'utf16le') return Buffer.from(text, 'utf16le');
  throw new Error(`unknown encoding ${encoding}`);
}

export function copy(text, tool, run = spawnSync) {
  const r = run(tool.cmd, tool.args, { input: encodeFor(text, tool.encoding) });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${tool.cmd} exited ${r.status}: ${String(r.stderr || '').trim()}`);
}

// One read of the clipboard, LF-normalised. Windows hands text back with CRLF whatever went in, so
// that normalisation is required, and it is the only massaging done: nothing here trims, pads or
// strips a byte-order mark, because each of those would hide the defect this exists to catch.
export function readClipboard(tool, { run = spawnSync, has = (n) => onPath(n) } = {}) {
  const reader = READERS[tool.cmd];
  if (!reader) return { available: false, why: `no read-back reader is defined for ${tool.cmd}` };
  if (!has(reader.cmd)) return { available: false, why: `${reader.cmd} is not on PATH` };
  const r = run(reader.cmd, reader.args, { maxBuffer: 1 << 28 });
  if (r.error) return { available: true, ok: false, why: `${reader.cmd}: ${r.error.message}` };
  if (r.status !== 0) return { available: true, ok: false, why: `${reader.cmd} exited ${r.status}: ${String(r.stderr || '').trim()}` };
  const text = (r.stdout === undefined || r.stdout === null ? '' : r.stdout.toString('utf8')).replace(/\r\n?/g, '\n');
  return { available: true, ok: true, reader: reader.cmd, text };
}

export const measure = (text) => ({ length: text.length, hash: fnv1a(text) });

// Reads the clipboard back and says whether it holds `text`. `attempts` reads are allowed because a
// single empty read has been seen on WSL; only a repeat is believed. Returns one of:
//   { status: 'verified', actual, reads }
//   { status: 'unavailable', why }   the reader is missing: the copy stands unverified, not failed
//   { status: 'error', why, reads }  the reader ran and failed
//   { status: 'mismatch', actual, reads }
export function verifyCopy(text, tool, { run = spawnSync, has = (n) => onPath(n), attempts = 2 } = {}) {
  const expected = measure(text);
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    last = readClipboard(tool, { run, has });
    if (!last.available) return { status: 'unavailable', why: last.why, expected };
    if (last.ok && last.text === text) return { status: 'verified', expected, actual: expected, reads: i };
  }
  if (!last.ok) return { status: 'error', why: last.why, expected, reads: attempts };
  return { status: 'mismatch', expected, actual: measure(last.text), reads: attempts };
}

function main(argv) {
  const args = argv.slice(2);
  const verify = !args.includes('--no-verify');
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length !== 1 || args.some((a) => a.startsWith('--') && a !== '--no-verify')) {
    console.error('usage: clipboard.mjs <file> [--no-verify]');
    return 2;
  }
  const text = readFileSync(files[0], 'utf8');
  if (text.includes('\r')) {
    console.error('refused: the file contains a carriage return; the generator never writes one');
    return 1;
  }
  const tool = pickTool();
  if (!tool) {
    console.error('no clipboard tool found: install pbcopy (macOS), wl-copy or xclip (Linux), or run under WSL/Windows with clip.exe on PATH');
    return 1;
  }
  copy(text, tool);
  const { length, hash } = measure(text);
  const copied = `copied ${length} chars to the clipboard via ${tool.cmd} (${length} ${hash})`;
  if (!verify) {
    console.log(`${copied}; read-back skipped (--no-verify)`);
    return 0;
  }
  const result = verifyCopy(text, tool);
  if (result.status === 'verified') {
    console.log(`${copied}; read-back verified${result.reads > 1 ? ` on read ${result.reads}` : ''}`);
    return 0;
  }
  if (result.status === 'unavailable') {
    console.log(`${copied}; read-back not verified: ${result.why}`);
    return 0;
  }
  console.error(copied);
  if (result.status === 'error') {
    console.error(`read-back failed after ${result.reads} attempt(s): ${result.why}`);
  } else {
    console.error(`read-back mismatch after ${result.reads} attempt(s): the clipboard holds ${result.actual.length} ${result.actual.hash}, the file is ${length} ${hash}. Do not paste; run this command again.`);
  }
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
