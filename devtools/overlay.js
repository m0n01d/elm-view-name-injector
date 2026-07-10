// elm-view-name overlay — a tiny in-page "DevTools" that reads the
// `elm-view-name` attributes and shows a live component tree with
// hover-highlight, click-to-select, an inspect mode, and search.
//
// Pure viewer: it only reads the DOM attribute the injector adds. Mounts inside
// a shadow root on <html> so even Browser.application (which owns <body>) can't
// remove it, and so page CSS can't leak into the panel.
//
// Loaded automatically when the bundle is injected with `--overlay`.
(function () {
  if (window.__elmViewNames) return;
  window.__elmViewNames = true;

  var ATTR = 'elm-view-name';
  var ACCENT = '#7cc5ff';

  // ---- shadow host -------------------------------------------------------
  var host = document.createElement('div');
  host.id = '__elm-view-names-host';
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  var mount = function () {
    (document.documentElement || document.body).appendChild(host);
  };
  if (document.documentElement) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}' +
    '.hl{position:fixed;pointer-events:none;border:1px solid ' + ACCENT + ';background:rgba(124,197,255,.15);border-radius:2px;transition:all .05s}' +
    '.hl .tag{position:absolute;top:-18px;left:0;background:' + ACCENT + ';color:#04223a;font-size:11px;font-weight:600;padding:1px 5px;border-radius:3px;white-space:nowrap}' +
    '.panel{pointer-events:auto;position:fixed;right:12px;bottom:12px;width:360px;max-height:60vh;display:flex;flex-direction:column;background:#0f1720;color:#d7e0ea;border:1px solid #263241;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.45);font-size:12px;overflow:hidden}' +
    '.hd{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#131e2a;border-bottom:1px solid #263241;cursor:default}' +
    '.hd .ttl{font-weight:700;flex:1}.hd .ct{opacity:.6;font-weight:400}' +
    '.btn{pointer-events:auto;background:#1c2836;color:#d7e0ea;border:1px solid #2d3c4d;border-radius:5px;padding:3px 7px;cursor:pointer;font-size:12px;line-height:1}' +
    '.btn:hover{background:#26374a}.btn.on{background:' + ACCENT + ';color:#04223a;border-color:' + ACCENT + '}' +
    '.search{margin:8px 10px 4px;padding:5px 8px;background:#0a1118;border:1px solid #2d3c4d;border-radius:5px;color:#d7e0ea;outline:none}' +
    '.search:focus{border-color:' + ACCENT + '}' +
    '.tree{overflow:auto;padding:4px 0 8px;flex:1}' +
    '.row{display:flex;align-items:center;gap:6px;padding:2px 10px 2px 0;cursor:pointer;white-space:nowrap}' +
    '.row:hover{background:#1a2632}.row.sel{background:#22354a}' +
    '.row .name{white-space:nowrap}.row .mod{opacity:.55}.row .fn{color:#e8eef5}.row.sel .fn{color:' + ACCENT + '}' +
    '.empty{padding:16px 12px;opacity:.6;line-height:1.5}' +
    '.min .search,.min .tree{display:none}' +
    '</style>' +
    '<div class="panel min">' +
    '  <div class="hd">' +
    '    <span class="ttl">🌳 Elm Views</span><span class="ct"></span>' +
    '    <button class="btn insp" title="Inspect: click an element on the page">🎯</button>' +
    '    <button class="btn ref" title="Rebuild tree">↻</button>' +
    '    <button class="btn tog" title="Show/hide">▸</button>' +
    '  </div>' +
    '  <input class="search" placeholder="filter by name…" />' +
    '  <div class="tree"></div>' +
    '</div>';

  var $ = function (s) { return root.querySelector(s); };
  var panel = $('.panel'), treeEl = $('.tree'), ctEl = $('.ct'),
      searchEl = $('.search'), inspBtn = $('.insp'), togBtn = $('.tog');

  var hlBox = document.createElement('div');
  hlBox.className = 'hl';
  hlBox.innerHTML = '<span class="tag"></span>';
  hlBox.style.display = 'none';
  root.appendChild(hlBox);

  var selected = null, inspecting = false, rowByEl = new Map();

  // ---- highlight ---------------------------------------------------------
  function highlight(el, label) {
    if (!el) { hlBox.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    hlBox.style.display = 'block';
    hlBox.style.left = r.left + 'px';
    hlBox.style.top = r.top + 'px';
    hlBox.style.width = r.width + 'px';
    hlBox.style.height = r.height + 'px';
    hlBox.querySelector('.tag').textContent = label || el.getAttribute(ATTR);
  }
  function clearHighlight() { if (!selected) hlBox.style.display = 'none'; }

  // ---- build + render tree ----------------------------------------------
  function depthOf(el) {
    var d = 0, p = el.parentElement;
    while (p) { if (p.getAttribute && p.getAttribute(ATTR) != null) d++; p = p.parentElement; }
    return d;
  }

  function build() {
    var els = [].slice.call(document.querySelectorAll('[' + ATTR + ']'));
    treeEl.innerHTML = '';
    rowByEl = new Map();
    var names = new Set();
    ctEl.textContent = '(' + els.length + ')';

    if (!els.length) {
      treeEl.innerHTML = '<div class="empty">No <code>elm-view-name</code> elements found.<br>Build with the injector (ELM_VIEW_NAMES=1) and reload.</div>';
      return;
    }

    var q = searchEl.value.trim().toLowerCase();
    els.forEach(function (el) {
      var name = el.getAttribute(ATTR);
      names.add(name);
      if (q && name.toLowerCase().indexOf(q) === -1) return;

      var row = document.createElement('div');
      row.className = 'row';
      var depth = depthOf(el);
      row.style.paddingLeft = (10 + depth * 12) + 'px';
      var dot = name.lastIndexOf('.');
      row.innerHTML =
        '<span class="name"><span class="mod">' + (dot > -1 ? name.slice(0, dot + 1) : '') + '</span>' +
        '<span class="fn">' + (dot > -1 ? name.slice(dot + 1) : name) + '</span></span>';
      row.title = name;
      row.addEventListener('mouseenter', function () { if (!inspecting) highlight(el); });
      row.addEventListener('mouseleave', clearHighlight);
      row.addEventListener('click', function () { select(el); });
      treeEl.appendChild(row);
      rowByEl.set(el, row);
    });
    ctEl.textContent = '(' + els.length + ' • ' + names.size + ' unique)';
  }

  function select(el) {
    selected = el;
    root.querySelectorAll('.row.sel').forEach(function (r) { r.classList.remove('sel'); });
    var row = rowByEl.get(el);
    if (row) { row.classList.add('sel'); row.scrollIntoView({ block: 'nearest' }); }
    highlight(el);
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    console.log('[elm-view] ' + el.getAttribute(ATTR), el);
  }

  // ---- inspect mode ------------------------------------------------------
  function onMove(e) {
    var el = e.target;
    while (el && el.getAttribute && el.getAttribute(ATTR) == null) el = el.parentElement;
    if (el && el.getAttribute) highlight(el);
  }
  function onClick(e) {
    var el = e.target;
    while (el && el.getAttribute && el.getAttribute(ATTR) == null) el = el.parentElement;
    if (el && el.getAttribute) { e.preventDefault(); e.stopPropagation(); select(el); }
    setInspect(false);
  }
  function setInspect(on) {
    inspecting = on;
    inspBtn.classList.toggle('on', on);
    document.body && (document.body.style.cursor = on ? 'crosshair' : '');
    if (on) {
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
    } else {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      clearHighlight();
    }
  }

  // ---- wiring ------------------------------------------------------------
  inspBtn.addEventListener('click', function () { setInspect(!inspecting); });
  $('.ref').addEventListener('click', build);
  searchEl.addEventListener('input', build);
  togBtn.addEventListener('click', function () {
    var min = panel.classList.toggle('min');
    togBtn.textContent = min ? '▸' : '▾';
  });
  $('.hd').addEventListener('click', function (e) {
    if (e.target.classList.contains('btn')) return;
    var min = panel.classList.toggle('min');
    togBtn.textContent = min ? '▸' : '▾';
  });

  // keep the selected highlight glued to the element on scroll/resize
  window.addEventListener('scroll', function () { if (selected) highlight(selected); }, true);
  window.addEventListener('resize', function () { if (selected) highlight(selected); });

  // Elm re-renders → rebuild (debounced). Ignore our own shadow host.
  var t = null;
  new MutationObserver(function () {
    clearTimeout(t);
    t = setTimeout(build, 250);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [ATTR] });

  // initial build once the app has had a tick to render
  setTimeout(build, 300);
})();
