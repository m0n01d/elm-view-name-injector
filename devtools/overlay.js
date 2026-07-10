// elm-view-name overlay — a tiny in-page "DevTools" that reads the
// `elm-view-name` attributes and shows a live component tree with
// hover-highlight, click-to-select, an inspect mode, and search.
//
// Collapsed, it mimics the native Elm debugger badge (Elm logo + count) so it
// feels like part of the app. Expanded, it's a draggable/resizable panel.
//
// Pure viewer: it only reads the DOM attribute the injector adds. Mounts inside
// a shadow root on <html> so even Browser.application (which owns <body>) can't
// remove it, and so page CSS can't leak into the panel.
(function () {
  if (window.__elmViewNames) return;
  window.__elmViewNames = true;

  var ATTR = 'elm-view-name';
  var ACCENT = '#7cc5ff';      // highlight
  var ELM_BLUE = '#4b9fd5';    // native-ish Elm badge blue
  var HD_BG = '#131e2a';

  // Official Elm logo (7 tangram pieces). Rendered white with a seam-colored
  // stroke so the gaps show the background — matching the native badge look.
  var LOGO_SHAPES =
    '<polygon points="161.649,152.782 231.514,152.782 91.783,12.955"/>' +
    '<polygon points="8.867,0 79.241,70.375 232.213,70.375 161.838,0"/>' +
    '<rect x="192.99" y="107.392" width="107.676" height="108.167" transform="matrix(0.7071 0.7071 -0.7071 0.7071 186.4727 -127.2386)"/>' +
    '<polygon points="323.298,143.724 323.298,0 179.573,0"/>' +
    '<polygon points="152.781,161.649 0,8.868 0,314.432"/>' +
    '<polygon points="255.522,246.655 323.298,314.432 323.298,178.879"/>' +
    '<polygon points="161.649,170.517 8.869,323.298 314.43,323.298"/>';
  function logo(size, seam) {
    return (
      '<svg width="' + size + '" height="' + size + '" viewBox="0 0 323.141 322.95" ' +
      'fill="#fff" stroke="' + seam + '" stroke-width="20" stroke-linejoin="round">' +
      LOGO_SHAPES + '</svg>'
    );
  }

  // ---- shadow host -------------------------------------------------------
  var host = document.createElement('div');
  host.id = '__elm-view-names-host';
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  (document.documentElement || document.body).appendChild(host);
  var root = host.attachShadow({ mode: 'open' });

  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}' +
    '.hl{position:fixed;pointer-events:none;border:1px solid ' + ACCENT + ';background:rgba(124,197,255,.15);border-radius:2px;transition:all .05s}' +
    '.hl .tag{position:absolute;top:-18px;left:0;background:' + ACCENT + ';color:#04223a;font-size:11px;font-weight:600;padding:1px 5px;border-radius:3px;white-space:nowrap}' +
    '.dt{position:fixed;pointer-events:auto}' +
    // collapsed badge
    '.badge{display:none;align-items:center;gap:8px;background:' + ELM_BLUE + ';border:none;border-radius:7px;padding:7px 11px 7px 9px;box-shadow:0 3px 14px rgba(0,0,0,.4);cursor:move}' +
    '.dt.collapsed .badge{display:inline-flex}.dt.collapsed .panel{display:none}' +
    '.badge .bct{color:#fff;font-weight:700;font-size:15px}' +
    '.badge:hover{filter:brightness(1.06)}' +
    // expanded panel
    '.panel{display:flex;flex-direction:column;width:360px;height:min(60vh,520px);min-width:230px;min-height:150px;background:#0f1720;color:#d7e0ea;border:1px solid #263241;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.45);font-size:12px;overflow:hidden;resize:both}' +
    '.hd{display:flex;align-items:center;gap:7px;padding:7px 10px;background:' + HD_BG + ';border-bottom:1px solid #263241;cursor:move;user-select:none}' +
    '.hd .ttl{font-weight:700;flex:1}.hd .ct{opacity:.6;font-weight:400}' +
    '.btn{background:#1c2836;color:#d7e0ea;border:1px solid #2d3c4d;border-radius:5px;padding:3px 7px;cursor:pointer;font-size:12px;line-height:1}' +
    '.btn:hover{background:#26374a}.btn.on{background:' + ACCENT + ';color:#04223a;border-color:' + ACCENT + '}' +
    '.search{margin:8px 10px 4px;padding:5px 8px;background:#0a1118;border:1px solid #2d3c4d;border-radius:5px;color:#d7e0ea;outline:none}' +
    '.search:focus{border-color:' + ACCENT + '}' +
    '.tree{overflow:auto;padding:4px 0 8px;flex:1}' +
    '.row{display:flex;align-items:center;gap:6px;padding:2px 10px 2px 0;cursor:pointer;white-space:nowrap}' +
    '.row:hover{background:#1a2632}.row.sel{background:#22354a}' +
    '.row .name{white-space:nowrap}.row .mod{opacity:.55}.row .fn{color:#e8eef5}.row.sel .fn{color:' + ACCENT + '}' +
    '.empty{padding:16px 12px;opacity:.6;line-height:1.5}' +
    '</style>' +
    '<div class="dt collapsed">' +
    '  <button class="badge" title="Elm Views — click to open">' + logo(24, ELM_BLUE) + '<span class="bct">0</span></button>' +
    '  <div class="panel">' +
    '    <div class="hd">' + logo(15, HD_BG) +
    '      <span class="ttl">Elm Views</span><span class="ct"></span>' +
    '      <button class="btn insp" title="Inspect: click an element on the page">🎯</button>' +
    '      <button class="btn ref" title="Rebuild tree">↻</button>' +
    '      <button class="btn tog" title="Collapse">▾</button>' +
    '    </div>' +
    '    <input class="search" placeholder="filter by name…" />' +
    '    <div class="tree"></div>' +
    '  </div>' +
    '</div>';

  var $ = function (s) { return root.querySelector(s); };
  var dt = $('.dt'), panel = $('.panel'), treeEl = $('.tree'),
      ctEl = $('.ct'), bctEl = $('.bct'), searchEl = $('.search'),
      inspBtn = $('.insp'), hd = $('.hd'), badge = $('.badge');

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

    if (!els.length) {
      bctEl.textContent = '0';
      ctEl.textContent = '';
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
      row.style.paddingLeft = (10 + depthOf(el) * 12) + 'px';
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
    bctEl.textContent = String(names.size);
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
  function nearestTagged(el) {
    while (el && el.getAttribute && el.getAttribute(ATTR) == null) el = el.parentElement;
    return el && el.getAttribute ? el : null;
  }
  function onMove(e) { var el = nearestTagged(e.target); if (el) highlight(el); }
  function onClick(e) {
    var el = nearestTagged(e.target);
    if (el) { e.preventDefault(); e.stopPropagation(); select(el); }
    setInspect(false);
  }
  function setInspect(on) {
    inspecting = on;
    inspBtn.classList.toggle('on', on);
    if (document.body) document.body.style.cursor = on ? 'crosshair' : '';
    if (on) {
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
    } else {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      clearHighlight();
    }
  }

  // ---- collapse / position ----------------------------------------------
  function setCollapsed(on) {
    dt.classList.toggle('collapsed', on);
    clampIntoView();
  }
  function clampIntoView() {
    var r = dt.getBoundingClientRect();
    var left = Math.min(parseFloat(dt.style.left) || r.left, window.innerWidth - r.width - 8);
    var top = Math.min(parseFloat(dt.style.top) || r.top, window.innerHeight - r.height - 8);
    dt.style.left = Math.max(8, left) + 'px';
    dt.style.top = Math.max(8, top) + 'px';
  }

  // ---- wiring ------------------------------------------------------------
  inspBtn.addEventListener('click', function () { setInspect(!inspecting); });
  $('.ref').addEventListener('click', build);
  $('.tog').addEventListener('click', function () { setCollapsed(true); });
  searchEl.addEventListener('input', build);

  // drag by header (expanded) or badge (collapsed); a click w/o moving toggles.
  var drag = null;
  function onDown(e) {
    if (e.target.closest('.btn') || e.target.closest('.search') || e.target.closest('.tree')) return;
    var r = dt.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
    e.preventDefault();
  }
  hd.addEventListener('mousedown', onDown);
  badge.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
    var w = dt.offsetWidth, h = dt.offsetHeight;
    dt.style.left = Math.min(Math.max(0, e.clientX - drag.dx), Math.max(0, window.innerWidth - w)) + 'px';
    dt.style.top = Math.min(Math.max(0, e.clientY - drag.dy), Math.max(0, window.innerHeight - h)) + 'px';
    if (selected) highlight(selected);
  });
  window.addEventListener('mouseup', function () {
    if (!drag) return;
    var wasClick = !drag.moved;
    drag = null;
    if (wasClick) setCollapsed(!dt.classList.contains('collapsed'));
  });

  window.addEventListener('scroll', function () { if (selected) highlight(selected); }, true);
  window.addEventListener('resize', function () { if (selected) highlight(selected); clampIntoView(); });

  // Elm re-renders → rebuild (debounced). Ignore our own shadow host.
  var t = null;
  new MutationObserver(function () {
    clearTimeout(t);
    t = setTimeout(build, 250);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [ATTR] });

  build();
  // park the collapsed badge in the bottom-right, like the native debugger
  requestAnimationFrame(function () {
    var r = dt.getBoundingClientRect();
    dt.style.left = Math.max(8, window.innerWidth - r.width - 16) + 'px';
    dt.style.top = Math.max(8, window.innerHeight - r.height - 16) + 'px';
  });
  setTimeout(build, 300);
})();
