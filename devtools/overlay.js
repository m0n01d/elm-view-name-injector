// elm-view-name overlay — a tiny in-page "DevTools" that reads the
// `elm-view-name` attributes and shows a live, collapsible component tree with
// hover-highlight, a persistent click-to-lock highlight, an inspect mode, and
// search.
//
// Collapsed, it mimics the native Elm debugger badge (Elm logo + count). It
// parks TOP-right so it doesn't collide with Elm's own debugger button
// (bottom-right). Expanded, it's a draggable/resizable panel.
//
// Pure viewer: only reads the DOM attribute the injector adds. Mounts inside a
// shadow root on <html> so even Browser.application (which owns <body>) can't
// remove it, and page CSS can't leak in.
(function () {
  if (window.__elmViewNames) return;
  window.__elmViewNames = true;

  var ATTR = 'elm-view-name';
  var ACCENT = '#7cc5ff';    // hover highlight
  var LOCK = '#ffb454';      // locked (clicked) highlight
  var ELM_BLUE = '#4b9fd5';
  var HD_BG = '#131e2a';

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

  var host = document.createElement('div');
  host.id = '__elm-view-names-host';
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  (document.documentElement || document.body).appendChild(host);
  var root = host.attachShadow({ mode: 'open' });

  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}' +
    '.hl{position:fixed;pointer-events:none;z-index:1;border:1px solid ' + ACCENT + ';background:rgba(124,197,255,.15);border-radius:2px;transition:all .05s}' +
    '.hl .tag{position:absolute;top:-18px;left:0;background:' + ACCENT + ';color:#04223a;font-size:11px;font-weight:600;padding:1px 5px;border-radius:3px;white-space:nowrap}' +
    '.hl.lock{border:2px solid ' + LOCK + ';background:rgba(255,180,84,.14)}' +
    '.hl.lock .tag{background:' + LOCK + ';color:#3a2400}' +
    '.dt{position:fixed;pointer-events:auto;z-index:2}' +
    '.badge{display:none;align-items:center;gap:8px;background:' + ELM_BLUE + ';border:none;border-radius:7px;padding:7px 11px 7px 9px;box-shadow:0 3px 14px rgba(0,0,0,.4);cursor:move}' +
    '.dt.collapsed .badge{display:inline-flex}.dt.collapsed .panel{display:none}' +
    '.badge .bct{color:#fff;font-weight:700;font-size:15px}.badge:hover{filter:brightness(1.06)}' +
    '.panel{display:flex;flex-direction:column;width:360px;height:min(60vh,520px);min-width:230px;min-height:150px;background:#0f1720;color:#d7e0ea;border:1px solid #263241;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.45);font-size:12px;overflow:hidden;resize:both}' +
    '.hd{display:flex;align-items:center;gap:7px;padding:7px 10px;background:' + HD_BG + ';border-bottom:1px solid #263241;cursor:move;user-select:none}' +
    '.hd .ttl{font-weight:700;flex:1}.hd .ct{opacity:.6;font-weight:400;margin-right:2px}' +
    '.btn{background:#1c2836;color:#d7e0ea;border:1px solid #2d3c4d;border-radius:5px;padding:3px 7px;cursor:pointer;font-size:12px;line-height:1}' +
    '.btn:hover{background:#26374a}.btn.on{background:' + ACCENT + ';color:#04223a;border-color:' + ACCENT + '}' +
    '.search{margin:8px 10px 4px;padding:5px 8px;background:#0a1118;border:1px solid #2d3c4d;border-radius:5px;color:#d7e0ea;outline:none}' +
    '.search:focus{border-color:' + ACCENT + '}' +
    '.tree{overflow:auto;padding:4px 0 8px;flex:1}' +
    '.row{display:flex;align-items:center;gap:4px;padding:2px 10px 2px 0;cursor:pointer;white-space:nowrap}' +
    '.row:hover{background:#1a2632}.row.sel{background:#3a2f1a}' +
    '.tw{display:inline-block;width:12px;flex:none;text-align:center;opacity:.65;font-size:10px}' +
    '.tw.h{cursor:pointer}.tw.h:hover{opacity:1}.tw.sp{opacity:0}' +
    '.row .name{white-space:nowrap}.row .mod{opacity:.55}.row .fn{color:#e8eef5}' +
    '.row.sel .fn{color:' + LOCK + '}' +
    '.cnt{opacity:.35;font-size:11px;margin-left:5px}' +
    '.empty{padding:16px 12px;opacity:.6;line-height:1.5}' +
    '.foot{display:none;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid #263241;background:#0c141d}' +
    '.foot.on{display:flex}' +
    '.foot .loc{flex:1;opacity:.7;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}' +
    '.foot .ide{background:#1c2836;color:#d7e0ea;border:1px solid #2d3c4d;border-radius:5px;padding:2px 4px;font-size:11px;max-width:120px}' +
    '.args{display:none;border-top:1px solid #263241;background:#0c141d;max-height:200px;overflow:auto;padding:6px 10px}' +
    '.args.on{display:block}' +
    '.args .ahd{display:flex;align-items:center;gap:6px;font-weight:700;margin-bottom:4px}' +
    '.args .ahd .nw{margin-left:auto;font-size:10px;color:#04223a;background:' + ACCENT + ';padding:1px 6px;border-radius:3px}' +
    '.args .asig{opacity:.6;margin-bottom:6px;line-height:1.4;word-break:break-word}' +
    '.args .albl{margin:6px 0 2px}.args .an{color:' + ACCENT + '}.args .aty{opacity:.5}' +
    '.args pre{margin:0;padding:6px 8px;background:#0a1118;border:1px solid #223;border-radius:5px;white-space:pre-wrap;word-break:break-word;line-height:1.5;color:#c8d3de;font-size:11px}' +
    '.args .ahint{opacity:.55;font-size:11px}' +
    '.foot .open[disabled]{opacity:.4;cursor:default}' +
    '</style>' +
    '<div class="dt collapsed">' +
    '  <button class="badge" title="Elm Views — click to open">' + logo(24, ELM_BLUE) + '<span class="bct">0</span></button>' +
    '  <div class="panel">' +
    '    <div class="hd">' + logo(15, HD_BG) +
    '      <span class="ttl">Elm Views</span><span class="ct"></span>' +
    '      <button class="btn insp" title="Inspect: click an element on the page">🎯</button>' +
    '      <button class="btn coll" title="Collapse / expand all">⊟</button>' +
    '      <button class="btn ref" title="Rebuild tree">↻</button>' +
    '      <button class="btn tog" title="Collapse">▾</button>' +
    '    </div>' +
    '    <input class="search" placeholder="filter by name…" />' +
    '    <div class="tree"></div>' +
    '    <div class="args"></div>' +
    '    <div class="foot"><span class="loc"></span><select class="ide" title="Open in…"></select><button class="btn open" title="Open in editor (or double-click a row)">&lt;&gt; source</button></div>' +
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

  var footEl = $('.foot'), locEl = $('.loc'), openBtn = $('.open'), ideEl = $('.ide'), argsEl = $('.args');
  var selected = null, inspecting = false, rowByEl = new Map();
  var collapsed = new Set(), collapsibleKeys = [];

  // ---- jump-to-source ----------------------------------------------------
  // manifest: { "Module.decl": { file, line } }. Embedded by the injector, or
  // fetched from a served JSON file as a fallback.
  var manifest = window.__elmViewManifest || null;
  if (!manifest) {
    try {
      fetch(window.__elmViewManifestUrl || '/elm-view-manifest.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (m) { if (m) { manifest = m; if (selected) updateFoot(selected); } })
        .catch(function () {});
    } catch (e) {}
  }
  function entryFor(el) {
    return manifest ? manifest[el.getAttribute(ATTR)] : null;
  }

  // Known editors (URL scheme templates). `window.__elmViewEditor` (string or
  // fn) still wins as an advanced override.
  var EDITORS = [
    { id: 'vscode', label: 'VS Code', tmpl: 'vscode://file/{file}:{line}' },
    { id: 'vscode-insiders', label: 'VS Code Insiders', tmpl: 'vscode-insiders://file/{file}:{line}' },
    { id: 'cursor', label: 'Cursor', tmpl: 'cursor://file/{file}:{line}' },
    { id: 'windsurf', label: 'Windsurf', tmpl: 'windsurf://file/{file}:{line}' },
    { id: 'zed', label: 'Zed', tmpl: 'zed://file/{file}:{line}' },
    { id: 'jetbrains', label: 'JetBrains', tmpl: 'http://localhost:63342/api/file/{file}:{line}' },
    { id: 'textmate', label: 'TextMate', tmpl: 'txmt://open?url=file://{file}&line={line}' },
    { id: 'sublime', label: 'Sublime', tmpl: 'subl://open?url=file://{file}&line={line}' },
  ];
  var LS_KEY = 'elmViewEditor';
  function storedEditor() {
    try { return localStorage.getItem(LS_KEY); } catch (e) { return null; }
  }
  function currentTmpl() {
    if (typeof window.__elmViewEditor === 'function') return window.__elmViewEditor;
    var id = storedEditor();
    var e = EDITORS.filter(function (x) { return x.id === id; })[0];
    if (e) return e.tmpl;
    if (typeof window.__elmViewEditor === 'string') return window.__elmViewEditor;
    return EDITORS[0].tmpl;
  }
  function editorUrl(entry) {
    var tmpl = currentTmpl();
    if (typeof tmpl === 'function') return tmpl(entry.file, entry.line);
    return tmpl.replace('{file}', entry.file).replace('{line}', String(entry.line));
  }
  function openSource(el) {
    var entry = entryFor(el);
    if (!entry) { console.warn('[elm-view] no source for ' + el.getAttribute(ATTR)); return; }
    var a = document.createElement('a');
    a.href = editorUrl(entry);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function shortFile(file) {
    var parts = file.split(/[\\/]/);
    return parts.slice(-3).join('/');
  }
  function updateFoot(el) {
    if (!el) { footEl.classList.remove('on'); return; }
    footEl.classList.add('on');
    var entry = entryFor(el);
    if (entry) {
      locEl.textContent = shortFile(entry.file) + ':' + entry.line;
      locEl.title = entry.file + ':' + entry.line;
      openBtn.disabled = false;
    } else {
      locEl.textContent = manifest ? 'source not in manifest' : 'no manifest loaded';
      locEl.title = '';
      openBtn.disabled = true;
    }
  }

  // ---- args inspection ---------------------------------------------------
  function hint(msg) {
    var d = document.createElement('div');
    d.className = 'ahint';
    d.textContent = msg;
    argsEl.appendChild(d);
  }
  // split a type signature on top-level "->" (ignoring nested (), [], {})
  function splitArrows(sig) {
    var parts = [], depth = 0, cur = '';
    for (var i = 0; i < sig.length; i++) {
      var c = sig[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      if (depth === 0 && c === '-' && sig[i + 1] === '>') { parts.push(cur.trim()); cur = ''; i++; continue; }
      cur += c;
    }
    parts.push(cur.trim());
    return parts;
  }

  function renderArgs(el) {
    argsEl.innerHTML = '';
    argsEl.classList.remove('on');
    if (!el) return;
    var name = el.getAttribute(ATTR);
    var reg = window.__elmViewArgs;
    if (!reg) return; // capture not enabled in this build → no Args section
    argsEl.classList.add('on');
    var hd = document.createElement('div');
    hd.className = 'ahd';
    hd.innerHTML = '<span>Args</span><span class="nw">live</span>';
    argsEl.appendChild(hd);

    // type signature (what the view expects) from the manifest
    var entry = manifest && manifest[name];
    var sig = entry && entry.sig;
    if (sig) {
      var sd = document.createElement('div');
      sd.className = 'asig';
      sd.textContent = name.slice(name.lastIndexOf('.') + 1) + ' : ' + sig;
      argsEl.appendChild(sd);
    }

    var toStr = window.__elmViewToString;
    if (!toStr) return hint('values need a dev/--debug build');
    var args = reg[name];
    if (!args || !args.length) return hint('no args captured (0-arg view, or not rendered yet)');

    var argTypes = sig ? splitArrows(sig).slice(0, -1) : [];
    args.forEach(function (v, i) {
      var lbl = document.createElement('div');
      lbl.className = 'albl';
      var an = document.createElement('span');
      an.className = 'an';
      an.textContent = 'arg ' + i;
      lbl.appendChild(an);
      if (argTypes[i]) {
        var ty = document.createElement('span');
        ty.className = 'aty';
        ty.textContent = ' : ' + argTypes[i];
        lbl.appendChild(ty);
      }
      argsEl.appendChild(lbl);
      var pre = document.createElement('pre');
      var s;
      try { s = toStr(v); } catch (e) { s = '<' + ((e && e.message) || 'error') + '>'; }
      if (s.length > 2000) s = s.slice(0, 2000) + ' …';
      pre.textContent = s;
      argsEl.appendChild(pre);
    });
  }

  // ---- highlight (hover vs locked) --------------------------------------
  function place(el) {
    var r = el.getBoundingClientRect();
    hlBox.style.display = 'block';
    hlBox.style.left = r.left + 'px';
    hlBox.style.top = r.top + 'px';
    hlBox.style.width = r.width + 'px';
    hlBox.style.height = r.height + 'px';
    hlBox.querySelector('.tag').textContent = el.getAttribute(ATTR);
  }
  function hover(el) { hlBox.classList.remove('lock'); place(el); }
  function lock(el) { hlBox.classList.add('lock'); place(el); }
  function clearHover() { if (selected) lock(selected); else hlBox.style.display = 'none'; }

  // ---- build the tree ----------------------------------------------------
  function makeRow(name, depth) {
    var row = document.createElement('div');
    row.className = 'row';
    row.title = name;
    row.style.paddingLeft = (8 + depth * 12) + 'px';
    var dot = name.lastIndexOf('.');
    row._nameHtml =
      '<span class="name"><span class="mod">' + (dot > -1 ? name.slice(0, dot + 1) : '') + '</span>' +
      '<span class="fn">' + (dot > -1 ? name.slice(dot + 1) : name) + '</span></span>';
    return row;
  }
  function wire(row, el) {
    row.addEventListener('mouseenter', function () { if (!inspecting) hover(el); });
    row.addEventListener('mouseleave', clearHover);
    row.addEventListener('click', function () { selected === el ? deselect() : select(el); });
    row.addEventListener('dblclick', function () { openSource(el); });
    rowByEl.set(el, row);
    if (selected === el) row.classList.add('sel');
  }
  function descCount(n) {
    var c = 0;
    n.children.forEach(function (k) { c += 1 + descCount(k); });
    return c;
  }

  function build() {
    if (selected && !document.contains(selected)) { selected = null; hlBox.style.display = 'none'; updateFoot(null); }
    var els = [].slice.call(document.querySelectorAll('[' + ATTR + ']'));
    treeEl.innerHTML = '';
    rowByEl = new Map();
    collapsibleKeys = [];
    var names = new Set();
    els.forEach(function (el) { names.add(el.getAttribute(ATTR)); });
    bctEl.textContent = String(names.size);

    if (!els.length) {
      ctEl.textContent = '';
      treeEl.innerHTML = '<div class="empty">No <code>elm-view-name</code> elements found.<br>Build with the injector and reload.</div>';
      return;
    }
    ctEl.textContent = '(' + els.length + ' • ' + names.size + ')';

    var q = searchEl.value.trim().toLowerCase();
    if (q) {
      // flat list of matches (ignore collapse while filtering)
      els.forEach(function (el) {
        var name = el.getAttribute(ATTR);
        if (name.toLowerCase().indexOf(q) === -1) return;
        var row = makeRow(name, depthAncestors(el));
        row.innerHTML = '<span class="tw sp"></span>' + row._nameHtml;
        treeEl.appendChild(row);
        wire(row, el);
      });
      return;
    }

    // build node tree (document order → ancestors precede descendants)
    var nodeOf = new Map(), roots = [];
    els.forEach(function (el) {
      var node = { el: el, name: el.getAttribute(ATTR), children: [] };
      nodeOf.set(el, node);
      var p = el.parentElement;
      while (p && !(p.getAttribute && p.getAttribute(ATTR) != null)) p = p.parentElement;
      var parent = p ? nodeOf.get(p) : null;
      if (parent) parent.children.push(node); else roots.push(node);
    });
    function key(node, prefix, i) { return prefix + '/' + node.name + ':' + i; }
    function renderList(list, container, depth, prefix) {
      list.forEach(function (node, i) {
        var k = key(node, prefix, i);
        var has = node.children.length > 0;
        if (has) collapsibleKeys.push(k);
        var isColl = collapsed.has(k);
        var row = makeRow(node.name, depth);
        row.innerHTML =
          '<span class="tw ' + (has ? 'h' : 'sp') + '">' + (has ? (isColl ? '▸' : '▾') : '') + '</span>' +
          row._nameHtml +
          (has ? '<span class="cnt">' + descCount(node) + '</span>' : '');
        container.appendChild(row);
        wire(row, node.el);
        if (has) {
          var kids = document.createElement('div');
          kids.className = 'kids';
          if (isColl) kids.style.display = 'none';
          renderList(node.children, kids, depth + 1, k);
          container.appendChild(kids);
          row.querySelector('.tw').addEventListener('click', function (e) {
            e.stopPropagation();
            var now = !collapsed.has(k);
            if (now) collapsed.add(k); else collapsed.delete(k);
            kids.style.display = now ? 'none' : '';
            e.target.textContent = now ? '▸' : '▾';
          });
        }
      });
    }
    renderList(roots, treeEl, 0, '');
    if (selected && isOpen()) lock(selected);
  }

  function depthAncestors(el) {
    var d = 0, p = el.parentElement;
    while (p) { if (p.getAttribute && p.getAttribute(ATTR) != null) d++; p = p.parentElement; }
    return d;
  }

  function deselect() {
    selected = null;
    root.querySelectorAll('.row.sel').forEach(function (r) { r.classList.remove('sel'); });
    hlBox.style.display = 'none';
    updateFoot(null);
    renderArgs(null);
  }

  function select(el) {
    selected = el;
    root.querySelectorAll('.row.sel').forEach(function (r) { r.classList.remove('sel'); });
    var row = rowByEl.get(el);
    if (row) { row.classList.add('sel'); row.scrollIntoView({ block: 'nearest' }); }
    lock(el);
    updateFoot(el);
    renderArgs(el);
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    console.log('[elm-view] ' + el.getAttribute(ATTR), el);
  }

  // ---- inspect mode ------------------------------------------------------
  function nearest(el) {
    while (el && el.getAttribute && el.getAttribute(ATTR) == null) el = el.parentElement;
    return el && el.getAttribute ? el : null;
  }
  function onMove(e) { var el = nearest(e.target); if (el) hover(el); }
  function onClick(e) {
    var el = nearest(e.target);
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
      clearHover();
    }
  }

  // ---- collapse / position ----------------------------------------------
  function isOpen() { return !dt.classList.contains('collapsed'); }
  function setCollapsed(on) {
    dt.classList.toggle('collapsed', on);
    if (on) {
      hlBox.style.display = 'none'; // closed panel → no DOM highlight
      if (inspecting) setInspect(false);
    } else if (selected) {
      lock(selected); // reopened → restore the pinned highlight
    }
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
  // editor picker ("Open in…"), persisted to localStorage
  EDITORS.forEach(function (e) {
    var o = document.createElement('option');
    o.value = e.id;
    o.textContent = e.label;
    ideEl.appendChild(o);
  });
  ideEl.value = storedEditor() || 'vscode';
  if (typeof window.__elmViewEditor === 'function') { ideEl.disabled = true; ideEl.title = 'Overridden by window.__elmViewEditor'; }
  ideEl.addEventListener('change', function () {
    try { localStorage.setItem(LS_KEY, ideEl.value); } catch (e) {}
  });

  inspBtn.addEventListener('click', function () { setInspect(!inspecting); });
  openBtn.addEventListener('click', function () { if (selected) openSource(selected); });
  // Escape cancels inspect mode, else clears the current selection
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (inspecting) setInspect(false);
    else if (selected) deselect();
  });
  $('.ref').addEventListener('click', build);
  $('.tog').addEventListener('click', function () { setCollapsed(true); });
  $('.coll').addEventListener('click', function () {
    if (collapsed.size) collapsed.clear();
    else collapsibleKeys.forEach(function (k) { collapsed.add(k); });
    build();
  });
  searchEl.addEventListener('input', build);

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
    if (selected && isOpen()) lock(selected);
  });
  window.addEventListener('mouseup', function () {
    if (!drag) return;
    var wasClick = !drag.moved;
    drag = null;
    if (wasClick) setCollapsed(!dt.classList.contains('collapsed'));
  });

  window.addEventListener('scroll', function () { if (selected && isOpen()) lock(selected); }, true);
  window.addEventListener('resize', function () { if (selected && isOpen()) lock(selected); clampIntoView(); });

  var t = null;
  new MutationObserver(function () {
    clearTimeout(t);
    t = setTimeout(build, 250);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [ATTR] });

  build();
  // park the collapsed badge TOP-right (native debugger button is bottom-right)
  requestAnimationFrame(function () {
    var r = dt.getBoundingClientRect();
    dt.style.left = Math.max(8, window.innerWidth - r.width - 16) + 'px';
    dt.style.top = '16px';
  });
  setTimeout(build, 300);
})();
