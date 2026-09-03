#!/usr/bin/env node
// Checks a rendered notification (the Admin editor's preview document, or the source of a test
// send) against the brand: palette on the right elements, structure, the version stamp, the
// mobile media block. Each check is one PASS/FAIL line; exit 1 on any FAIL. The palette is parsed
// from lib/brand-style.css so the hexes live in one place, and a missing token is a loud error.
//
//   node scripts/notifications/verify-render.mjs <rendered.html> --id <id> --version <n>
//   node scripts/notifications/verify-render.mjs --preview-response <file> --id <id> --version <n>
//   node scripts/notifications/verify-render.mjs --dump <console-dump...> --id <id> --version <n>
//     [--manifest <path>] [--css <path>]
//
// --preview-response takes the saved body of the Admin editor's EmailTemplateGeneratePreview
// GraphQL response (the chrome-devtools MCP's get_network_request writes it to a file); the
// rendered HTML is its data.emailTemplateGeneratePreview.preview.bodyHtml, CRLF-normalised here.
// That is the reliable way to read a preview: the Preview dialog's iframe is an about:srcdoc
// frame where no init script runs.
//
// --version is required and is also checked against the manifest, so a stale invocation cannot
// pass a v3 render as v4. A render with no stamp fails the version check as "unstamped"; the
// skill's audit classifies that as stock, not as a broken brand.
//
// What this proves: the sample-data render only. Liquid branches the preview does not take
// (discounts, gift cards, partial fulfilment, refunds) are not exercised here.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, readManifest, findStamps, isValidVersion, REPO_ROOT } from './brand.mjs';
import { parseDump } from './dump.mjs';
import {
  parseHtml,
  hasClass,
  classesOf,
  closest,
  select,
  innerText,
  backgroundOf,
  colorOf,
  normalizeColor,
  parseStylesheet,
} from './html-walk.mjs';

// Shopify's own Shop-app button colour as the sample render shows it. The brand leaves that cell
// alone (its stylesheet never names --shop-app), so a render where it changed is a regression.
export const SHOP_APP_BUTTON = '#5433eb';
export const MOBILE_QUERY = '(max-width: 600px)';

// Each palette token is one (selector, property) pair in lib/brand-style.css. Renaming a
// selector there makes parsePalette throw, never compare against undefined.
export const PALETTE_TOKENS = {
  navy: ['.header__cell .container', 'background-color'],
  page: ['.body', 'background-color'],
  white: ['.content__cell .container', 'background-color'],
  button: ['.button__cell', 'background'],
  footerText: ['.footer .disclaimer__subtext', 'color'],
  footerLink: ['.footer .disclaimer__subtext a', 'color'],
  bodyText: ['.body p', 'color'],
  heading: ['.body h2', 'color'],
  eyebrow: ['.body h4', 'color'],
  shopName: ['.footer .ssb-shop-name', 'color'],
};

export function parsePalette(css) {
  const { rules, media } = parseStylesheet(css);
  const palette = {};
  for (const [token, [selector, prop]] of Object.entries(PALETTE_TOKENS)) {
    const rule = rules.find((r) => r.selector === selector && r.declarations[prop]);
    if (!rule) throw new Error(`brand-style.css: no rule "${selector} { ${prop} }" for palette token ${token}`);
    const value = rule.declarations[prop].value;
    const colour = normalizeColor(value) || normalizeColor(value.split(/\s+/)[0]);
    if (!colour) throw new Error(`brand-style.css: "${selector} { ${prop}: ${value} }" is not a colour (token ${token})`);
    palette[token] = colour;
  }
  const mobile = media.find((m) => m.query === MOBILE_QUERY);
  if (!mobile || mobile.rules.length === 0) throw new Error(`brand-style.css: no @media ${MOBILE_QUERY} block`);
  palette.mobileRules = mobile.rules;
  return palette;
}

function normValue(value) {
  const v = String(value).replace(/\s+/g, ' ').trim().toLowerCase();
  return normalizeColor(v) || v;
}

const isTable = (e) => e.tag === 'table';
const isContainer = (e) => isTable(e) && hasClass(e, 'container');
const inRow = (cls) => (e) => closest(e, (a) => isTable(a) && hasClass(a, cls)) !== null;
const inFooter = (e) => closest(e, (a) => hasClass(a, 'footer')) !== null;
const describe = (e) => `<${e.tag}${e.attrs.class ? ` class="${e.attrs.class}"` : ''}>`;

function allHave(list, getter, expected, label) {
  const wrong = list.filter((e) => getter(e) !== expected);
  if (wrong.length === 0) return null;
  return `${wrong.length} of ${list.length} ${label} not ${expected}: ${wrong.slice(0, 3).map((e) => `${describe(e)} is ${getter(e) || 'unset'}`).join('; ')}`;
}

// Every check: (ctx) -> null on PASS, a detail string on FAIL.
export const CHECKS = [
  ['version', ({ html, id, version }) => {
    const stamps = findStamps(html);
    if (stamps.length === 0) return 'unstamped';
    if (stamps.length > 1) return `stamped ${stamps.length} times`;
    if (stamps[0].id !== id) return `stamp names ${stamps[0].id}, expected ${id}`;
    if (stamps[0].version !== version) return `stamp says v${stamps[0].version}, expected v${version}`;
    return null;
  }],
  ['manifest-version', ({ id, version, manifest }) => {
    const entry = manifest.templates[id];
    if (!entry) return `${id} is not in the manifest`;
    if (entry.version !== version) return `manifest says v${entry.version}, asked for v${version}`;
    return null;
  }],
  ['header-navy', ({ root, palette }) => {
    const list = select(root, (e) => isContainer(e) && inRow('header')(e));
    if (list.length === 0) return 'no table.container inside a .header row';
    return allHave(list, backgroundOf, palette.navy, 'header containers');
  }],
  ['footer-navy', ({ root, palette }) => {
    const list = select(root, (e) => isContainer(e) && inRow('footer')(e));
    if (list.length === 0) return 'no table.container inside the .footer row';
    return allHave(list, backgroundOf, palette.navy, 'footer containers');
  }],
  ['page-colour', ({ root, palette }) => {
    const body = select(root, (e) => e.tag === 'body');
    if (body.length !== 1) return `${body.length} <body> elements`;
    const bodyTable = select(root, (e) => isTable(e) && hasClass(e, 'body'));
    if (bodyTable.length !== 1) return `${bodyTable.length} table.body elements`;
    const rows = select(root, (e) => isTable(e) && hasClass(e, 'row') && ['header', 'content', 'section', 'footer'].some((c) => hasClass(e, c)));
    if (rows.length === 0) return 'no header/content/section/footer row tables';
    return allHave([...body, ...bodyTable, ...rows], backgroundOf, palette.page, 'page surfaces (body, table.body, row tables)');
  }],
  ['content-white', ({ root, palette }) => {
    const list = select(root, (e) => isContainer(e) && (inRow('content')(e) || inRow('section')(e)));
    if (list.length === 0) return 'no table.container inside a .content or .section row';
    return allHave(list, backgroundOf, palette.white, 'content containers');
  }],
  ['buttons', ({ root, palette }) => {
    const list = select(root, (e) => e.tag === 'td' && hasClass(e, 'button__cell') && !hasClass(e, 'button__cell--shop-app'));
    return allHave(list, backgroundOf, palette.button, 'button cells');
  }],
  ['shop-app-button', ({ root }) => {
    const list = select(root, (e) => e.tag === 'td' && hasClass(e, 'button__cell--shop-app'));
    return allHave(list, backgroundOf, SHOP_APP_BUTTON, 'Shop-app button cells (stock, untouched)');
  }],
  ['footer-disclaimer', ({ root, palette }) => {
    const list = select(root, (e) => hasClass(e, 'disclaimer__subtext') && inFooter(e));
    if (list.length === 0) return 'no .disclaimer__subtext inside .footer';
    const text = allHave(list, colorOf, palette.footerText, 'footer disclaimers');
    if (text) return text;
    const links = list.flatMap((p) => select(p, (e) => e.tag === 'a'));
    return allHave(links, colorOf, palette.footerLink, 'footer disclaimer links');
  }],
  ['body-disclaimer', ({ root, palette }) => {
    const list = select(root, (e) => hasClass(e, 'disclaimer__subtext') && !inFooter(e));
    return allHave(list, colorOf, palette.bodyText, 'body-side disclaimers');
  }],
  ['headings', ({ root, palette }) => {
    const h23 = select(root, (e) => e.tag === 'h2' || e.tag === 'h3');
    const h4 = select(root, (e) => e.tag === 'h4');
    return allHave(h23, colorOf, palette.heading, 'h2/h3 headings') || allHave(h4, colorOf, palette.eyebrow, 'h4 headings');
  }],
  ['body-paragraphs', ({ root, palette }) => {
    // Body-side disclaimer paragraphs belong to the body-disclaimer check.
    const list = select(root, (e) => e.tag === 'p' && !inFooter(e) && !hasClass(e, 'disclaimer__subtext'));
    if (list.length === 0) return 'no body paragraphs';
    const light = list.filter((e) => [palette.footerText, '#ffffff', palette.shopName].includes(colorOf(e)));
    if (light.length > 0) return `${light.length} body paragraph(s) in a footer colour: ${light.slice(0, 3).map(describe).join('; ')}`;
    if (!list.some((e) => colorOf(e) === palette.bodyText)) return `no body paragraph is ${palette.bodyText}`;
    return null;
  }],
  ['social-row', ({ root, palette }) => {
    const social = select(root, (e) => isTable(e) && hasClass(e, 'ssb-social') && inFooter(e));
    if (social.length !== 1) return `${social.length} .ssb-social tables inside .footer`;
    const icons = select(social[0], (e) => e.tag === 'img' && /email-icon-/.test(e.attrs.src || ''));
    if (icons.length !== 3) return `${icons.length} email-icon images, expected 3`;
    const names = select(root, (e) => e.tag === 'p' && hasClass(e, 'ssb-shop-name') && inFooter(e));
    if (names.length !== 1) return `${names.length} .ssb-shop-name paragraphs inside .footer`;
    if (innerText(names[0]).trim() === '') return 'shop name paragraph is empty';
    return allHave(names, colorOf, palette.shopName, 'shop name paragraphs');
  }],
  ['footer-inside-body', ({ root }) => {
    const footer = select(root, (e) => isTable(e) && hasClass(e, 'row') && hasClass(e, 'footer'));
    if (footer.length !== 1) return `${footer.length} table.row.footer elements`;
    if (!closest(footer[0], (a) => isTable(a) && hasClass(a, 'body'))) return 'table.row.footer is not a descendant of table.body (an early-closed table)';
    return null;
  }],
  ['subtotal-lines', ({ root }) => {
    const empty = select(root, (e) => isTable(e) && hasClass(e, 'subtotal-lines') && select(e, (c) => c.tag === 'td' || c.tag === 'th').length === 0);
    return empty.length === 0 ? null : `${empty.length} empty subtotal-lines table(s) (a row with no cell)`;
  }],
  ['no-accent', ({ html }) => (html.includes('email_accent_color') ? 'email_accent_color is referenced' : null)],
  ['no-liquid-error', ({ html }) => (/liquid error/i.test(html) ? 'the render contains "Liquid error"' : null)],
  ['no-translation-missing', ({ html }) => (/translation missing/i.test(html) ? 'the render contains "translation missing"' : null)],
  ['mobile-css', ({ root, palette }) => {
    const styles = select(root, (e) => e.tag === 'style');
    if (styles.length === 0) return 'no <style> element survived the render';
    const blocks = styles.flatMap((s) => parseStylesheet(s.raw).media).filter((m) => m.query === MOBILE_QUERY);
    if (blocks.length === 0) return `no @media ${MOBILE_QUERY} block in the head style`;
    const rendered = blocks.flatMap((b) => b.rules);
    const missing = [];
    for (const rule of palette.mobileRules) {
      const same = rendered.filter((r) => r.selector === rule.selector);
      for (const [prop, decl] of Object.entries(rule.declarations)) {
        const hit = same.some((r) => r.declarations[prop] && normValue(r.declarations[prop].value) === normValue(decl.value) && r.declarations[prop].important === decl.important);
        if (!hit) missing.push(`${rule.selector} { ${prop}: ${decl.value}${decl.important ? ' !important' : ''} }`);
      }
    }
    return missing.length === 0 ? null : `brand media rules missing from the render: ${missing.join('; ')}`;
  }],
  ['header-row', ({ root }) => {
    const list = select(root, (e) => isTable(e) && hasClass(e, 'header') && hasClass(e, 'row'));
    return list.length === 1 ? null : `${list.length} table.header.row elements, expected 1`;
  }],
  ['no-logosize', ({ root }) => {
    const list = select(root, (e) => e.tag === 'img' && classesOf(e).some((c) => c.endsWith('__logosize')));
    return list.length === 0 ? null : `${list.length} stock logo image(s) (__logosize) left in the body`;
  }],
];

export function verifyRender(html, { id, version, manifest, css }) {
  if (typeof id !== 'string' || !/^[a-z0-9_]+$/.test(id)) throw new Error(`bad id: ${JSON.stringify(id)}`);
  if (!isValidVersion(version)) throw new Error(`bad version: ${JSON.stringify(version)}`);
  const palette = parsePalette(css);
  const { root } = parseHtml(html);
  const ctx = { html, root, id, version, manifest, palette };
  const results = CHECKS.map(([name, fn]) => {
    const detail = fn(ctx);
    return { name, ok: detail === null, detail: detail || '' };
  });
  return { results, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

// The rendered HTML inside a saved EmailTemplateGeneratePreview response body.
export function previewHtmlFromResponse(jsonText) {
  const parsed = JSON.parse(jsonText);
  const html = parsed && parsed.data && parsed.data.emailTemplateGeneratePreview && parsed.data.emailTemplateGeneratePreview.preview && parsed.data.emailTemplateGeneratePreview.preview.bodyHtml;
  if (typeof html !== 'string' || html.length === 0) throw new Error('preview response carries no data.emailTemplateGeneratePreview.preview.bodyHtml');
  return html.replace(/\r\n?/g, '\n');
}

// The STORED template inside a saved EmailTemplate response body: what Admin holds for the id,
// as opposed to previewHtmlFromResponse's rendered output. Already LF in every response observed,
// and normalised here anyway so the caller's hash contract holds either way.
export function storedBodyFromResponse(jsonText) {
  const parsed = JSON.parse(jsonText);
  const body = parsed && parsed.data && parsed.data.emailTemplate && parsed.data.emailTemplate.bodyHtml;
  if (typeof body !== 'string' || body.length === 0) throw new Error('response carries no data.emailTemplate.bodyHtml');
  return body.replace(/\r\n?/g, '\n');
}

export function formatResults({ results, passed, failed }) {
  const lines = results.map((r) => (r.ok ? `PASS ${r.name}` : `FAIL ${r.name}: ${r.detail}`));
  lines.push(`verify-render: ${passed} passed, ${failed} failed`);
  return lines.join('\n') + '\n';
}

function main(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const id = get('--id');
  const versionArg = get('--version');
  const version = versionArg === undefined ? undefined : Number(versionArg);
  const rootFlag = get('--root');
  const root = rootFlag ? resolve(rootFlag) : REPO_ROOT;
  const p = paths(root);
  const manifestPath = get('--manifest') || p.manifest;
  const cssPath = get('--css') || p.css;
  const dumpAt = args.indexOf('--dump');
  const previewResponse = get('--preview-response');
  const flagsWithValue = new Set(['--id', '--version', '--root', '--manifest', '--css', '--preview-response']);
  const positional = args.filter((a, i) => !a.startsWith('--') && !flagsWithValue.has(args[i - 1]) && (dumpAt === -1 || i < dumpAt));
  const sources = (positional.length === 1 ? 1 : 0) + (dumpAt !== -1 ? 1 : 0) + (previewResponse ? 1 : 0);
  if (!id || !/^\d+$/.test(String(versionArg)) || sources !== 1) {
    console.error('usage: verify-render.mjs (<rendered.html> | --preview-response <file> | --dump <console-dump...>) --id <id> --version <n> [--manifest <path>] [--css <path>]');
    return 2;
  }
  let html;
  if (previewResponse) {
    html = previewHtmlFromResponse(readFileSync(previewResponse, 'utf8'));
  } else if (dumpAt !== -1) {
    const rest = args.slice(dumpAt + 1);
    const nextFlag = rest.findIndex((a) => a.startsWith('--'));
    const dumps = nextFlag === -1 ? rest : rest.slice(0, nextFlag);
    if (dumps.length === 0) {
      console.error('usage: --dump needs at least one path');
      return 2;
    }
    html = parseDump(dumps.map((d) => readFileSync(d, 'utf8')).join('\n')).text;
  } else {
    html = readFileSync(positional[0], 'utf8');
  }
  const manifest = manifestPath === p.manifest ? readManifest(root) : JSON.parse(readFileSync(manifestPath, 'utf8'));
  const css = readFileSync(cssPath, 'utf8');
  const result = verifyRender(html, { id, version, manifest, css });
  process.stdout.write(formatResults(result));
  return result.failed === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
