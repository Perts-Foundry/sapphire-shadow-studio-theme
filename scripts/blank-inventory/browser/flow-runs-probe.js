// Probe for the Shopify Flow run-list page, passed verbatim as the initScript of a navigate_page
// call by the blank-inventory skill's browser mode. It wraps the page's fetch and XMLHttpRequest
// before any page script runs and logs three signals, and only three:
//
//   SSSFLOWPAGE <n>                                       a matching response held <n> run nodes
//   SSSFLOWRUN <runId> <status> <true|false> <startedAt>   one line per run node; the boolean is
//                                                         whether that run is retrying
//   SSSFLOWNONE <op,op,...>                                nothing matched; the GraphQL operation
//                                                         names seen instead, so a changed Admin
//                                                         page is reported rather than read as a
//                                                         quiet Flow
//
// Parse the output with scripts/blank-inventory/lib/flow-runs.mjs (`parseFlowRuns`), which is where
// the dedupe, the status classification and the malformed-line handling live and are tested. Do not
// eyeball the lines.
//
// READ-ONLY, AND NARROWLY SO. It reads network responses; it never touches the DOM, never clicks,
// and never navigates. It is a diagnostic for the operator: nothing in scripts/ imports it, no
// command runs it, and a quiet run list is never permission to apply. The batch gate in
// `apply` waits on the STORE, not on this.
//
// IT IS NOT INERT, though. It replaces window.fetch and patches XMLHttpRequest.prototype.open/send
// for the life of the page, once (a second install is a no-op), exactly as
// scripts/notifications/browser/editor-probe.js does.
//
// NEVER COMMIT ITS OUTPUT. Run ids, timestamps and counts from the live store are operational data
// and this repo is public. Only the synthetic inputs in test/flow-runs.test.mjs may go in a file,
// and that includes an "illustrative example" in a README.
//
// WHAT IS OBSERVED AND WHAT IS STILL UNVERIFIED, STATED PLAINLY. Admin's Flow surface is
// unversioned and undocumented, so this file was first written against a plausible shape rather
// than an observed one. On 2026-09-03 the real surface was read from the network log and the
// matchers below were corrected to it: the runs come from an embedded-app iframe on
// `flow.shopifyapps.com/flow-core/graphql`, the query param is `opName=`, and the only operation
// carrying `startedAt` is `getWorkflowRunsV2Connection`
// (`data.workflowRunsV2Connection.edges[].node`, with `id`, `startedAt`, `status`, `retried`).
// The walk stays structural anyway: it looks for objects carrying an id, a status-like field and a
// timestamp-like field anywhere in the response, because an unversioned surface can move again.
//
// STILL UNVERIFIED: whether navigate_page's initScript installs inside that cross-origin iframe at
// all. If it does not, every matcher here is correct and the probe is still silent, and the answer
// is the network-log route in browser.md rather than a wider regex. Do not widen these patterns to
// chase a silence that has not been traced to a URL mismatch. If the first navigation logs
// SSSFLOWNONE, that is still a designed outcome, not a bug: report the operation names it lists and
// stop, per browser.md.
(function () {
  // Anchored the way editor-probe.js anchors its own operation match: an operation name can
  // continue with a letter, digit, underscore or hyphen, so every one of those is excluded rather
  // than letting a longer name be mistaken for this one.
  // Both spellings of the query param, because they are NOT interchangeable across hosts: the
  // admin.shopify.com shell uses `operationName=`, and Flow's own backend
  // (flow.shopifyapps.com/flow-core/graphql, the one that carries the runs) uses `opName=`.
  // Matching only the first is what made this probe silent on 2026-09-03: the URL never matched,
  // and because noteOp shares the pattern, even the SSSFLOWNONE fallback reported no operations.
  //
  // The trailing class is [A-Za-z0-9]* and not [A-Za-z]*, which is load-bearing rather than tidy.
  // The list operation is `getWorkflowRunsV2Connection`, and the digit in `V2` is unreachable with
  // a letters-only class. That operation is the ONLY one carrying startedAt, so a letters-only
  // class matches `getWorkflowRunsSummaries` (no timestamp, so findRuns discards every node) and
  // misses the one that would produce a reading.
  // Spelled as a full alternation, not `op(?:erationN)?ame`, because the short form is `opName`
  // with a capital N: the collapsed version yields `opame` and matches neither host.
  var RUNS_URL_RE = /(?:operationName|opName)=[A-Za-z]*(?:Flow|Workflow)[A-Za-z]*Run[A-Za-z0-9]*(?![A-Za-z0-9_-])/;
  var OP_NAME_RE = /(?:operationName|opName)=([A-Za-z0-9_]+)/;
  var MAX_NODES = 500;

  var seenOps = {};
  var matched = false;
  var noneLogged = false;

  function statusOf(node) {
    var raw = node.status || node.state || node.runStatus;
    return typeof raw === 'string' && raw ? raw.replace(/\s+/g, '_') : null;
  }
  function startedAtOf(node) {
    var raw = node.startedAt || node.createdAt || node.occurredAt || node.triggeredAt;
    return typeof raw === 'string' && raw && isFinite(Date.parse(raw)) ? raw : null;
  }
  function retryingOf(node) {
    // `retried` is what the run list actually returns at run level; the other three were the
    // plausible-shape guesses this file was written against and are kept because they cost nothing.
    if (node.retried === true || node.isRetrying === true || node.retrying === true) return true;
    if (typeof node.retryCount === 'number') return node.retryCount > 0;
    if (typeof node.retries === 'number') return node.retries > 0;
    // A step-level "retrying" is what the run list actually surfaces, so look one level down too.
    // The observed field is `stepRuns` (a plain array, and EMPTY in the list payload, so this loop
    // is a fallback for the summaries payload rather than the source of the reading).
    var steps = node.stepRuns || node.steps;
    if (steps && steps.nodes) steps = steps.nodes;
    if (Object.prototype.toString.call(steps) === '[object Array]') {
      for (var i = 0; i < steps.length; i++) {
        var s = statusOf(steps[i]);
        if (s && /retry/i.test(s)) return true;
        if (steps[i] && typeof steps[i].retryCount === 'number' && steps[i].retryCount > 0) return true;
        if (steps[i] && typeof steps[i].retries === 'number' && steps[i].retries > 0) return true;
      }
    }
    return false;
  }
  function idOf(node) {
    var raw = node.id || node.runId || node.gid;
    return typeof raw === 'string' && raw ? raw.replace(/\s+/g, '') : null;
  }

  /**
   * Every object in the response that looks like a run: an id, a status and a timestamp. Structural
   * rather than path-following, because the path is the part this file cannot verify. Bounded, so a
   * large response cannot spin the page.
   */
  function findRuns(value) {
    var out = [];
    var stack = [value];
    var depth = 0;
    while (stack.length && out.length < MAX_NODES && depth < 100000) {
      depth++;
      var node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Object.prototype.toString.call(node) === '[object Array]') {
        for (var i = 0; i < node.length; i++) stack.push(node[i]);
        continue;
      }
      var id = idOf(node);
      var status = statusOf(node);
      var startedAt = startedAtOf(node);
      if (id && status && startedAt) out.push({ id: id, status: status, startedAt: startedAt, retrying: retryingOf(node) });
      for (var key in node) {
        if (Object.prototype.hasOwnProperty.call(node, key)) stack.push(node[key]);
      }
    }
    return out;
  }

  function logRuns(bodyText) {
    var parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch (e) {
      return;
    }
    var runs = findRuns(parsed && parsed.data ? parsed.data : parsed);
    if (!runs.length) return;
    matched = true;
    console.log('SSSFLOWPAGE ' + runs.length);
    for (var i = 0; i < runs.length; i++) {
      console.log('SSSFLOWRUN ' + runs[i].id + ' ' + runs[i].status + ' ' + (runs[i].retrying ? 'true' : 'false') + ' ' + runs[i].startedAt);
    }
  }

  function noteOp(url) {
    var m = OP_NAME_RE.exec(String(url || ''));
    if (m) seenOps[m[1]] = true;
  }

  // A single deferred report, so a page that fetches nothing recognisable says so ONCE rather than
  // leaving the reader unable to tell "the Flow is quiet" from "the probe matched nothing".
  function reportNone() {
    if (matched || noneLogged) return;
    noneLogged = true;
    var names = [];
    for (var k in seenOps) if (Object.prototype.hasOwnProperty.call(seenOps, k)) names.push(k);
    console.log('SSSFLOWNONE ' + (names.length ? names.sort().join(',') : '-'));
  }

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  function install(w) {
    if (!w) return;
    if (w.sssFlowProbeInstalled) return;
    w.sssFlowProbeInstalled = true;

    if (typeof w.fetch === 'function') {
      var origFetch = w.fetch;
      w.fetch = function (input) {
        var url = urlOf(input);
        noteOp(url);
        var p = origFetch.apply(this, arguments);
        if (!RUNS_URL_RE.test(url) || !p || typeof p.then !== 'function') return p;
        return p.then(function (res) {
          try {
            res.clone().text().then(logRuns, function () {});
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
        this.sssFlowUrl = url;
        noteOp(url);
        return origOpen.apply(this, arguments);
      };
      X.prototype.send = function () {
        var xhr = this;
        try {
          xhr.addEventListener('load', function () {
            if (RUNS_URL_RE.test(String(xhr.sssFlowUrl || ''))) logRuns(String(xhr.responseText || ''));
          });
        } catch (e) {
          // no listener support: the fetch path is the one that matters
        }
        return origSend.apply(this, arguments);
      };
    }
  }

  install(typeof window !== 'undefined' ? window : null);
  // No polling loop and no fixed wait for a reading: the run list is read from responses, and the
  // reader compares what it has against what it expects (browser.md). This one timer exists only so
  // that "nothing matched" is stated rather than left as silence.
  setTimeout(reportNone, 15000);
})();
