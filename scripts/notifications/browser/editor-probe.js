// Probe for the Admin notification editor, passed verbatim as the initScript of a navigate_page
// call by the notification-templates skill. It wraps the page's fetch and XMLHttpRequest before
// any page script runs, then polls the editor widget, and logs:
//   SSSSTORED <length> <fnv> <gid>    the STORED document, taken from the EmailTemplate GraphQL
//                                     response the editor page fetches on load. Authoritative and
//                                     race-free: it is what Admin holds, not what is on screen.
//                                     <gid> is data.emailTemplate.id, or `-` when the response
//                                     omits it; it says WHICH template the reading belongs to,
//                                     which the request URL does not (its variables are opaque).
//   SSSSTOREDSTAMP <id> <version>     the stamp parsed from the STORED document's first line,
//                     | none          the race-free counterpart of SSSSTAMP. The classification
//                                     turns on the stamp, so it must not come from the widget.
//   SSSSTORED unavailable             a matching response carried no usable body. Logged at most
//                                     once, and it does not stop a later good response from
//                                     logging a real reading; nothing at all is logged when no
//                                     matching response was seen.
//   SSSPOLL <length> <fnv> <source>   String.length and 32-bit FNV-1a of the editor text
//                                     (UTF-16 code units, LF-normalised), and which widget it read
//   SSSSTAMP <id> <version> | none    the stamp parsed from the editor's FIRST LINE only
//   SSSREVERT true|false|unknown      whether a "Revert" button is disabled; `unknown` when the
//                                     editor shows none (observed: a clean editor shows neither
//                                     Save nor Revert), so the stock signal that counts is the
//                                     document's bytes equalling stock/<id>.liquid
//   SSSSETTLED <length> <fnv>         when the editor document has been unchanged for
//                                     SETTLE_POLLS polls. A positive "done" signal, so a reader
//                                     never has to guess a settle interval. It re-arms: a later
//                                     change logs a further SSSSETTLED once that settles.
// The editor has a load race: Admin renders the STOCK body first and swaps the saved override in
// a moment later, and SSSPOLL logs only on change, so an early read reports stock and looks stable.
// The SSSSTORED family does not have that problem; SSSPOLL is the signal for a paste, which is a
// local edit with no network round trip.
// This writes nothing to the DOM, but it is not inert: it replaces window.fetch and patches
// XMLHttpRequest.prototype.open/send for the life of the page, once (a second install is a no-op).
// The FNV function and the stamp regex are copies of the ones in scripts/notifications/dump.mjs
// and brand.mjs; test/browser-probes.test.mjs proves they agree.
(function () {
  var STAMP_RE_SOURCE = '(?<![A-Za-z0-9_-])sss-notification ([a-z0-9_]+) v([1-9][0-9]*)(?![0-9A-Za-z_-])';
  // The editor's own query. Anchored so no longer operation name can be mistaken for it:
  // EmailTemplateGeneratePreview carries a RENDERED document and EmailTemplateUpdate a write, and
  // a digit, underscore or hyphen suffix would be a different operation too. A filter like this
  // one fails silently when it is widened, so it excludes every character an operation name can
  // continue with.
  var STORED_URL_RE = /operationName=EmailTemplate(?![A-Za-z0-9_-])/;
  var POLL_MS = 500;
  var SETTLE_POLLS = 3;
  function fnv1a(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }
  function lf(text) {
    return text.replace(/\r\n?/g, '\n');
  }
  function readEditor() {
    var cm6 = document.querySelector('.cm-content');
    if (cm6 && cm6.cmView && cm6.cmView.view) return { source: 'cm6', text: cm6.cmView.view.state.doc.toString() };
    var cm5 = document.querySelector('.CodeMirror');
    if (cm5 && cm5.CodeMirror) return { source: 'cm5', text: cm5.CodeMirror.getValue() };
    var areas = document.querySelectorAll('textarea');
    var best = null;
    for (var i = 0; i < areas.length; i++) if (!best || areas[i].value.length > best.value.length) best = areas[i];
    if (best) return { source: 'textarea', text: best.value };
    return null;
  }
  function revertDisabled() {
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var label = (buttons[i].textContent || '') + ' ' + (buttons[i].getAttribute('aria-label') || '');
      if (/revert/i.test(label)) return buttons[i].disabled ? 'true' : 'false';
    }
    return 'unknown';
  }
  // The stored document, logged once, from the first matching response that carries a usable body.
  // The success latch is set only on success: a first response that is unparseable or empty (an
  // aborted prefetch, say) must not burn the signal and force the run back onto the racy widget
  // read, which is the whole thing this exists to avoid.
  var storedLogged = false;
  var unavailableLogged = false;
  function logStored(bodyText) {
    if (storedLogged) return;
    var body = null;
    var gid = null;
    try {
      var parsed = JSON.parse(bodyText);
      if (parsed && parsed.data && parsed.data.emailTemplate) {
        body = parsed.data.emailTemplate.bodyHtml;
        if (typeof parsed.data.emailTemplate.id === 'string' && parsed.data.emailTemplate.id) gid = parsed.data.emailTemplate.id;
      }
    } catch (e) {
      body = null;
    }
    if (typeof body !== 'string' || body.length === 0) {
      if (!unavailableLogged) {
        unavailableLogged = true;
        console.log('SSSSTORED unavailable');
      }
      return;
    }
    storedLogged = true;
    var text = lf(body);
    console.log('SSSSTORED ' + text.length + ' ' + fnv1a(text) + ' ' + (gid === null ? '-' : gid));
    var m = new RegExp(STAMP_RE_SOURCE).exec(text.split('\n')[0]);
    console.log('SSSSTOREDSTAMP ' + (m ? m[1] + ' ' + m[2] : 'none'));
  }
  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }
  function install(w) {
    if (!w) return;
    if (w.sssProbeInstalled) return;
    w.sssProbeInstalled = true;
    if (typeof w.fetch === 'function') {
      var origFetch = w.fetch;
      w.fetch = function (input) {
        var url = urlOf(input);
        var p = origFetch.apply(this, arguments);
        if (!STORED_URL_RE.test(url) || !p || typeof p.then !== 'function') return p;
        return p.then(function (res) {
          try {
            res.clone().text().then(logStored, function () {});
          } catch (e) {
            // a body that cannot be re-read is not worth failing the page for
          }
          return res;
        });
      };
    }
    var X = w.XMLHttpRequest;
    if (typeof X === 'function' && X.prototype && typeof X.prototype.open === 'function') {
      var origOpen = X.prototype.open;
      var origSend = X.prototype.send;
      X.prototype.open = function (method, url) {
        this.sssUrl = url;
        return origOpen.apply(this, arguments);
      };
      X.prototype.send = function () {
        var xhr = this;
        try {
          xhr.addEventListener('load', function () {
            if (STORED_URL_RE.test(String(xhr.sssUrl || ''))) logStored(String(xhr.responseText || ''));
          });
        } catch (e) {
          // no listener support: the fetch path is the one that matters
        }
        return origSend.apply(this, arguments);
      };
    }
  }
  install(typeof window !== 'undefined' ? window : null);
  var last = null;
  var stable = 0;
  var settled = false;
  function poll() {
    var r = readEditor();
    if (!r) return;
    var text = lf(r.text);
    var rd = revertDisabled();
    var key = r.source + ':' + text.length + ':' + fnv1a(text) + ':' + rd;
    if (key === last) {
      if (settled) return;
      stable++;
      if (stable >= SETTLE_POLLS) {
        settled = true;
        console.log('SSSSETTLED ' + text.length + ' ' + fnv1a(text));
      }
      return;
    }
    last = key;
    stable = 0;
    settled = false;
    console.log('SSSPOLL ' + text.length + ' ' + fnv1a(text) + ' ' + r.source);
    var firstLine = text.split('\n')[0];
    var m = new RegExp(STAMP_RE_SOURCE).exec(firstLine);
    console.log('SSSSTAMP ' + (m ? m[1] + ' ' + m[2] : 'none'));
    console.log('SSSREVERT ' + rd);
  }
  setInterval(poll, POLL_MS);
})();
