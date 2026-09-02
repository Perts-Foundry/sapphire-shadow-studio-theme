#!/usr/bin/env node
// Copies a file's text to the system clipboard for the paste step of the notification-templates
// skill, so the bytes that reach the Admin editor are the repo file's bytes and not a re-typed
// copy. Detects the platform tool; fails with a clear message when none is available.
//
//   node scripts/notifications/clipboard.mjs <file>
//
// Tools, in order: pbcopy (macOS), wl-copy (Wayland, when WAYLAND_DISPLAY is set), xclip (X11),
// clip.exe (WSL: /proc/version names Microsoft; the text is sent as UTF-16LE WITHOUT a byte-order
// mark: clip.exe takes UTF-16LE as is, and a BOM is pasted into the editor as a U+FEFF character,
// which the byte check caught on the first run as "one character too long").

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function copy(text, tool) {
  const r = spawnSync(tool.cmd, tool.args, { input: encodeFor(text, tool.encoding) });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${tool.cmd} exited ${r.status}: ${String(r.stderr || '').trim()}`);
}

function main(argv) {
  const file = argv[2];
  if (!file || argv.length !== 3) {
    console.error('usage: clipboard.mjs <file>');
    return 2;
  }
  const text = readFileSync(file, 'utf8');
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
  console.log(`copied ${text.length} chars to the clipboard via ${tool.cmd}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
