// Mobile layout probe for a reassembled preview opened from a file:// URL under a phone viewport
// (emulate 411x900x2, mobile, touch). Reproduces the phone-client behaviour that stepped the cards
// against each other (tables sized to content) by injecting `table { width: auto !important;
// max-width: 100% !important }`, then logs:
//   SSSMOBILE ok|fail <detail>      every table.container shares one width and one left edge, and
//                                   the document does not scroll sideways
//   SSSSQUEEZE ok|warn <detail>     with every container forced to 200px, any descendant that stays
//                                   wider than 300px (an unshrinkable row) is named as a warning
// Read-only apart from the injected style. Passed verbatim as the initScript of the navigate_page
// call that opens the preview file.
(function () {
  function run() {
    var style = document.createElement('style');
    style.textContent = 'table { width: auto !important; max-width: 100% !important; }';
    document.head.appendChild(style);
    var containers = Array.prototype.slice.call(document.querySelectorAll('table.container'));
    if (containers.length === 0) {
      console.log('SSSMOBILE fail no table.container found');
      return;
    }
    var rects = containers.map(function (t) { return t.getBoundingClientRect(); });
    var widths = rects.map(function (r) { return Math.round(r.width); });
    var lefts = rects.map(function (r) { return Math.round(r.left); });
    var sameWidth = widths.every(function (w) { return Math.abs(w - widths[0]) <= 1; });
    var sameLeft = lefts.every(function (l) { return Math.abs(l - lefts[0]) <= 1; });
    var noScroll = document.documentElement.scrollWidth <= window.innerWidth;
    var ok = sameWidth && sameLeft && noScroll;
    console.log('SSSMOBILE ' + (ok ? 'ok' : 'fail') + ' widths=' + widths.join(',') + ' lefts=' + lefts.join(',') + ' scrollWidth=' + document.documentElement.scrollWidth + ' innerWidth=' + window.innerWidth);
    var squeeze = document.createElement('style');
    squeeze.textContent = 'table.container { width: 200px !important; max-width: 200px !important; }';
    document.head.appendChild(squeeze);
    var wide = [];
    containers.forEach(function (t) {
      Array.prototype.forEach.call(t.querySelectorAll('*'), function (el) {
        var w = el.getBoundingClientRect().width;
        if (w > 300) wide.push('<' + el.tagName.toLowerCase() + (el.className ? ' class="' + el.className + '"' : '') + '> ' + Math.round(w) + 'px');
      });
    });
    document.head.removeChild(squeeze);
    console.log('SSSSQUEEZE ' + (wide.length === 0 ? 'ok' : 'warn ' + wide.slice(0, 10).join('; ')));
  }
  if (document.readyState === 'complete') setTimeout(run, 0);
  else window.addEventListener('load', function () { setTimeout(run, 0); });
})();
