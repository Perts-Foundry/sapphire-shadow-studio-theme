// Dumps the editor's Preview document (the "Email preview" iframe inside the Preview dialog) to
// the console in the dump.mjs contract: SSSLEN, SSSHASH, SSSCHUNK<n> over the frame's serialised
// HTML. Passed verbatim as the initScript of the navigate_page call that opens the editor, so it
// is installed in every frame the page creates; it acts only inside a frame that is not the top
// window and has no editor of its own, and only once that frame has a body with content. Feed the
// saved console output to `verify-render.mjs --dump <file> --id <id> --version <n>`. Read-only.
// The FNV function is a copy of the one in scripts/notifications/dump.mjs; the probe test proves
// they agree.
(function () {
  var LEN_PREFIX = 'SSSLEN';
  var HASH_PREFIX = 'SSSHASH';
  var CHUNK_PREFIX = 'SSSCHUNK';
  var CHUNK_SIZE = 8000;
  function fnv1a(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }
  if (window.top === window) return;
  var done = false;
  function dump() {
    if (done) return;
    if (document.querySelector('.cm-content, .CodeMirror, textarea')) return;
    if (!document.body || document.body.innerHTML.trim().length === 0) return;
    if (!document.querySelector('table')) return;
    done = true;
    clearInterval(timer);
    var text = document.documentElement.outerHTML.replace(/\r\n?/g, '\n');
    console.log(LEN_PREFIX + ' ' + text.length);
    console.log(HASH_PREFIX + ' ' + fnv1a(text));
    for (var i = 0, k = 0; i < text.length; i += CHUNK_SIZE, k++) console.log(CHUNK_PREFIX + k + ' ' + text.slice(i, i + CHUNK_SIZE));
  }
  var timer = setInterval(dump, 500);
})();
