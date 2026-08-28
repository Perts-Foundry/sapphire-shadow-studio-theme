// Structural checks over RAW JSON TEXT, before it is ever parsed.
//
// WHY THIS IS A LEAF. `findDuplicateKeys` began inside scripts/blank-inventory/lib/reorder.mjs, a
// 1300-line module about reorder policy. The catalogue manifest needs it, and so does anything else
// that refuses a last-wins merge artifact, so it lives here where importing it costs nothing. This
// file imports nothing at all, and must stay that way.
//
// reorder.mjs re-exports `findDuplicateKeys`, permanently and deliberately, so its own callers are
// unaffected.

/**
 * Duplicate object keys anywhere in a JSON document, found in the RAW TEXT.
 *
 * JSON.parse is last-wins and silent, so a bad merge that leaves two `"crewneck|black|m"` entries
 * parses cleanly and quietly takes the wrong minimum. The structure is all this needs, so it walks
 * tokens rather than parsing values.
 *
 * @param {string} text
 * @returns {Array<{path: string, key: string}>}
 */
export function findDuplicateKeys(text) {
  /** @type {Array<{t: string, v?: string}>} */
  const toks = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < text.length) {
        if (text[j] === '\\') {
          s += text[j] + (text[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (text[j] === '"') break;
        s += text[j];
        j++;
      }
      toks.push({ t: 'string', v: s });
      i = j;
    } else if ('{}[]:,'.includes(c)) {
      toks.push({ t: c });
    }
    // Numbers, literals and whitespace carry no structure this check needs.
  }

  const dups = [];
  /** @type {Array<{type: string, keys: Set<string>, path: string[], currentKey: string|null}>} */
  const stack = [];
  let lastStr = null;
  for (const tk of toks) {
    if (tk.t === 'string') {
      lastStr = tk.v;
      continue;
    }
    const top = stack[stack.length - 1];
    if (tk.t === ':') {
      if (top && top.type === 'object' && lastStr !== null) {
        if (top.keys.has(lastStr)) dups.push({ path: [...top.path, lastStr].join('.'), key: lastStr });
        top.keys.add(lastStr);
        top.currentKey = lastStr;
      }
      continue;
    }
    if (tk.t === '{' || tk.t === '[') {
      const path = !top ? [] : top.type === 'object' ? [...top.path, top.currentKey ?? '?'] : [...top.path, '[]'];
      stack.push({ type: tk.t === '{' ? 'object' : 'array', keys: new Set(), path, currentKey: null });
      continue;
    }
    if (tk.t === '}' || tk.t === ']') {
      stack.pop();
      continue;
    }
    if (tk.t === ',') {
      if (top) top.currentKey = null;
      lastStr = null;
    }
  }
  return dups;
}
