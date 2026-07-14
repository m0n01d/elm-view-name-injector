'use strict';

/**
 * inject-view-names
 * -----------------
 * Post-compile transformer for Elm 0.19.1 output.
 *
 * For every top-level Elm value/function whose *rendered root* is a recognizable
 * Html element constructor, splice
 *
 *     Html.Attributes.attribute "elm-view-name" "Module.decl"
 *
 * onto that element's existing attribute list — no wrapper node, no DOM change.
 * Composition ("view calls view") needs no special handling: each declaration
 * tags only its own root element, so nested view calls self-tag at runtime and
 * the elm-view-name DOM tree emerges for free.
 *
 * Detection is purely structural against Elm's (stable, undocumented) codegen:
 *   - app symbols are `$author$project$<Module>$<decl>`  (prefix is literal)
 *   - elements are `A2($elm$html$Html$<tag>, attrs, kids)`   -> attrs = arg[1]
 *              or  `A3($elm$html$Html$node|Keyed$node, tag, attrs, kids)` -> arg[2]
 *   - attrs + event handlers live in the SAME list, so we just cons onto it.
 *
 * Injection is done by *offset splicing* the original source (parse once for
 * node ranges, replace attr-list sub-ranges by string) rather than reprinting
 * the whole AST — the latter is ~50x slower on multi-MB Elm bundles.
 */

const fs = require('fs');
const path = require('path');
const babelParser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const DEFAULTS = {
  prefix: '$author$project$', // Elm hard-codes this for application (non-package) code
  attr: 'elm-view-name',
  wrap: false,
  overlay: false, // append the in-page DevTools overlay runtime (experimental)
  capture: false, // record view fn call-args for inspection (experimental; needs _Debug_toString)
  lazy: false, // instrument Html.Lazy.lazy* to count hits/misses (experimental)
};

// A2($elm$html$Html$Lazy$lazy, …) / lazy2 … lazy8 (and the VirtualDom aliases)
const LAZY_RE = /^\$elm\$(?:html\$Html\$Lazy|virtual_dom\$VirtualDom)\$lazy([2-8])?$/;

// The kernel lazy makers. Every Html.Lazy / VirtualDom lazy alias is assigned
// from these, and the kernel is emitted before any package alias or app code —
// so wrapping the kernel in place makes every downstream binding (including
// init-time point-free partials) inherit the counting wrapper. lazy = fn + 1 ref
// = arity 2 … lazy8 = fn + 8 refs = arity 9.
const KERNEL_LAZY_RE = /^_VirtualDom_lazy([2-8])?$/;

let _overlaySrc = null;
function overlaySource() {
  if (_overlaySrc === null) {
    _overlaySrc = fs.readFileSync(path.join(__dirname, '..', 'devtools', 'overlay.js'), 'utf8');
  }
  return _overlaySrc;
}

// elm/html element constructors: `$elm$html$Html$<lowercaseTag>` (div, span, main_, ...).
// `map` (arg 1 is a child) and `node` (arity 3 — as A2 it's a partial application
// whose arg 1 is the TAG string, NOT attrs) match the shape but are NOT 2-arity
// elements, so they must be blocklisted here. `node` is still tagged via the A3
// branch when fully applied.
const A2_ELEMENT_RE = /^\$elm\$html\$Html\$[a-z][A-Za-z0-9_]*$/;
const A2_BLOCKLIST = new Set(['$elm$html$Html$map', '$elm$html$Html$node']);
// arity-3 element constructors (custom + keyed nodes): attrs is the 3rd arg.
const A3_ELEMENTS = new Set(['$elm$html$Html$node', '$elm$html$Html$Keyed$node']);
// Opaque Html producers we can `--wrap`, mapped to the argument count of a FULL
// application. `text` is arity 1 (direct call); the rest go through AN(fn, …args).
// A call with FEWER args is a PARTIAL application that returns a *function*, not
// Html — wrapping that turns a function into a div and breaks its callers (e.g.
// `Icon.element = A2(lazy4, …)`), so we require an exact arity match.
const OPAQUE_ARITY = {
  '$elm$html$Html$map': 2,
  '$elm$html$Html$Lazy$lazy': 2,
  '$elm$html$Html$Lazy$lazy2': 3,
  '$elm$html$Html$Lazy$lazy3': 4,
  '$elm$html$Html$Lazy$lazy4': 5,
  '$elm$html$Html$Lazy$lazy5': 6,
};

/** `$author$project$Ui$Button$primary` -> `Ui.Button.primary` */
function demangle(name, prefix) {
  if (!name.startsWith(prefix)) return null;
  const parts = name.slice(prefix.length).split('$').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]; // decl with no module segment (rare)
  return parts.slice(0, -1).join('.') + '.' + parts[parts.length - 1];
}

/** A primitive literal can never be an attribute list — guards against splicing
 *  into the wrong slot (e.g. a partially-applied fn whose arg is a tag string). */
function isLiteralArg(node) {
  return (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node) ||
    t.isTemplateLiteral(node)
  );
}

/** Is this expression node an Html element ctor call? Returns { attrsIndex } or null. */
function classifyElement(node) {
  if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return null;
  const args = node.arguments;
  let attrsIndex = null;
  if (node.callee.name === 'A2' && args.length >= 3 && t.isIdentifier(args[0])) {
    const fn = args[0].name;
    if (A2_ELEMENT_RE.test(fn) && !A2_BLOCKLIST.has(fn)) attrsIndex = 1;
  } else if (node.callee.name === 'A3' && args.length >= 4 && t.isIdentifier(args[0])) {
    if (A3_ELEMENTS.has(args[0].name)) attrsIndex = 2;
  }
  if (attrsIndex === null) return null;
  // Defensive: the attrs slot must not be a primitive literal.
  if (isLiteralArg(args[attrsIndex])) return null;
  return { attrsIndex };
}

/** stdlib-opaque Html value (text/map/lazy) usable with --wrap? */
function isOpaqueHtml(node) {
  if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return false;
  if (node.callee.name === '$elm$html$Html$text') return true; // arity 1, direct call
  const m = /^A(\d+)$/.exec(node.callee.name);
  if (!m) return false;
  const first = node.arguments[0];
  // only a FULL application (N args === fn arity) yields Html; partials are functions
  return t.isIdentifier(first) && OPAQUE_ARITY[first.name] === Number(m[1]);
}

/** True if the attrs arg already begins with our injected attribute (idempotency). */
function alreadyTagged(attrsNode, attrName) {
  if (!t.isCallExpression(attrsNode) || !t.isIdentifier(attrsNode.callee)) return false;
  if (attrsNode.callee.name !== '_List_Cons') return false;
  const head = attrsNode.arguments[0];
  return (
    t.isCallExpression(head) &&
    t.isIdentifier(head.callee) &&
    head.callee.name === 'A2' &&
    t.isIdentifier(head.arguments[0]) &&
    head.arguments[0].name === ATTR_HELPER &&
    t.isStringLiteral(head.arguments[1]) &&
    head.arguments[1].value === attrName
  );
}

/** Collect the leaf Html-producing expression paths for a declaration's init. */
function collectPositions(initPath) {
  const node = initPath.node;
  if (
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee) &&
    /^F\d+$/.test(node.callee.name) &&
    node.arguments.length >= 1 &&
    (t.isFunctionExpression(node.arguments[0]) || t.isArrowFunctionExpression(node.arguments[0]))
  ) {
    return expandConditionals(collectReturns(initPath.get('arguments.0')));
  }
  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
    return expandConditionals(collectReturns(initPath));
  }
  return expandConditionals([initPath]); // bare value
}

/** Every `return <expr>` in a function body, NOT descending into nested closures. */
function collectReturns(fnPath) {
  const body = fnPath.get('body');
  if (!body.isBlockStatement()) return [body]; // arrow with expression body
  const rets = [];
  fnPath.traverse({
    Function(p) {
      p.skip();
    },
    ReturnStatement(p) {
      const arg = p.get('argument');
      if (arg.node) rets.push(arg);
    },
  });
  return rets;
}

/** Expand `cond ? a : b` into [a, b], recursively. */
function expandConditionals(paths) {
  const out = [];
  for (const p of paths) {
    if (p.isConditionalExpression()) {
      out.push(...expandConditionals([p.get('consequent'), p.get('alternate')]));
    } else {
      out.push(p);
    }
  }
  return out;
}

// Kernel helper `_VirtualDom_attribute` (what `Html.Attributes.attribute` compiles
// to). A kernel F2 always present in any Html app, so — unlike
// `$elm$html$Html$Attributes$attribute` — it is NEVER tree-shaken away, even if
// the app's own source never calls `Html.Attributes.attribute`.
const ATTR_HELPER = '_VirtualDom_attribute';

function jsStr(s) {
  return JSON.stringify(String(s));
}
function attrExpr(qname, attrName) {
  return `A2(${ATTR_HELPER}, ${jsStr(attrName)}, ${jsStr(qname)})`;
}

// A declaration's init is "function-valued" (has args worth capturing) if it's a
// bare function (arity 1) or an F<n>(…) wrapper (arity ≥ 2). Bare Html values
// (arity-0 views) are CallExpressions to A2/A3, which don't match.
function isFunctionValued(node) {
  return (
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node) ||
    (t.isCallExpression(node) && t.isIdentifier(node.callee) && /^F\d+$/.test(node.callee.name))
  );
}

// Runtime injected once (inside the IIFE, where _Debug_toString is in scope):
// exposes captured args + the stringifier on window, and defines __elmViewCap,
// which wraps a view fn value to record its call args (last call wins).
function captureRuntime() {
  return (
    ';(function(){if(typeof window==="undefined")return;' +
    'window.__elmViewArgs=window.__elmViewArgs||{};' +
    'try{window.__elmViewToString=_Debug_toString}catch(e){}})();' +
    'function __elmViewCap(name,orig){' +
    'if(orig&&typeof orig.a==="number"&&typeof orig.f==="function"){' +
    'var raw=orig.f;orig.f=function(){window.__elmViewArgs[name]=[].slice.call(arguments);' +
    'return raw.apply(null,arguments)};return orig}' +
    'if(typeof orig==="function"){return function(a){window.__elmViewArgs[name]=[a];return orig(a)}}' +
    'return orig}\n'
  );
}

// Runtime for Html.Lazy instrumentation.
//
// Real-world Elm applies lazy point-free (`Lazy.lazy renderRow` mapped over a
// list) or partially (`A2(lazy4, fn, x)`), which compile to a direct/partial
// call on the lazy identifier — NOT the fully-applied `A2(lazy, fn, arg)` form.
// So instead of rewriting call sites, we wrap the kernel `_VirtualDom_lazy*`
// makers in place (see the edits generated in transform). Every application
// shape — full, partial, point-free, init-time — flows through the wrapper.
//
// This block defines the wrapper factory. __mkLazy(orig, n) returns an F-object
// of arity n that delegates to the original lazy (memo refs untouched), counts
// each encounter, and overrides the created thunk's `m` (forced only on a miss)
// to count misses. Attribution: the transform tags each memo fn at its call site
// with `__ln("Module.fn", fn)` (sets fn.__elmName); the wrapper reads it for the
// key. __mkLazy/__ln are function declarations (hoisted), so the kernel wraps can
// call them even though this block is emitted later, at the first app decl.
function lazyRuntime() {
  return (
    '\nvar __elmLazyStats=(typeof window!=="undefined")?(window.__elmLazyStats=window.__elmLazyStats||{}):{};' +
    'function __ln(name,fn){if(fn!=null&&fn.__elmName===undefined){try{fn.__elmName=name}catch(e){}}return fn}' +
    'if(typeof window!=="undefined")window.__ln=__ln;' +
    'function __mkLazy(orig,n){if(orig==null)return orig;' +
    'var mk=n===2?F2:n===3?F3:n===4?F4:n===5?F5:n===6?F6:n===7?F7:n===8?F8:F9;' +
    'var ap=n===2?A2:n===3?A3:n===4?A4:n===5?A5:n===6?A6:n===7?A7:n===8?A8:A9;' +
    'return mk(function(){var args=[].slice.call(arguments);' +
    'var node=ap.apply(null,[orig].concat(args));' +
    'var fn=args[0],key=(fn&&fn.__elmName)||"(anonymous lazy)";' +
    'var rec=(__elmLazyStats[key]=__elmLazyStats[key]||{enc:0,miss:0});rec.enc++;' +
    'if(node&&node.$===5&&typeof node.m==="function"){var m=node.m;node.m=function(){rec.miss++;return m.apply(this,arguments)}}' +
    'return node})}\n'
  );
}

function transform(code, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const stats = { spliced: 0, wrapped: 0, skipped: 0, tagged: [] };
  const edits = []; // { start, end, text }
  let sawLazy = false; // any Html.Lazy application present (drives runtime injection)
  const kernelWraps = []; // { pos, name, arity } — kernel _VirtualDom_lazy* to wrap in place

  const ast = babelParser.parse(code, { sourceType: 'script' });

  traverse(ast, {
    VariableDeclarator(path) {
      const id = path.node.id;
      if (!t.isIdentifier(id)) return;

      // Kernel lazy makers (names don't start with the app prefix): record them
      // so we can wrap each in place, right after its definition — before any
      // package alias or app consumer runs.
      if (opts.lazy && path.node.init) {
        const km = KERNEL_LAZY_RE.exec(id.name);
        if (km) {
          const arity = km[1] ? Number(km[1]) + 1 : 2;
          const stmt = path.parentPath ? path.parentPath.node : null;
          const pos = stmt && t.isVariableDeclaration(stmt) ? stmt.end : path.node.end;
          kernelWraps.push({ pos, name: id.name, arity });
          sawLazy = true;
        }
      }

      if (!id.name.startsWith(opts.prefix)) return;
      if (!path.node.init) return;
      const qname = demangle(id.name, opts.prefix);
      if (!qname) return;

      let taggedThis = false;
      for (const exprPath of collectPositions(path.get('init'))) {
        const node = exprPath.node;
        const el = classifyElement(node);
        if (el) {
          const attrsNode = node.arguments[el.attrsIndex];
          if (alreadyTagged(attrsNode, opts.attr)) continue;
          const orig = code.slice(attrsNode.start, attrsNode.end);
          edits.push({
            start: attrsNode.start,
            end: attrsNode.end,
            text: `_List_Cons(${attrExpr(qname, opts.attr)}, ${orig})`,
          });
          stats.spliced++;
          stats.tagged.push(qname);
          taggedThis = true;
        } else if (opts.wrap && isOpaqueHtml(node)) {
          const orig = code.slice(node.start, node.end);
          const contents = `A2(${ATTR_HELPER}, "style", "display:contents")`;
          const attrs = `_List_Cons(${attrExpr(qname, opts.attr)}, _List_Cons(${contents}, _List_Nil))`;
          edits.push({
            start: node.start,
            end: node.end,
            text: `A2($elm$html$Html$div, ${attrs}, _List_fromArray([${orig}]))`,
          });
          stats.wrapped++;
          stats.tagged.push(qname + ' (wrapped)');
          taggedThis = true;
        } else {
          stats.skipped++;
        }
      }

      // capture args: wrap the (function-valued) declaration so each call records
      // its arguments. Zero-width insertions around init, so they compose with
      // the attr splice(s) inside it.
      if (opts.capture && taggedThis && isFunctionValued(path.node.init)) {
        const init = path.node.init;
        edits.push({ start: init.start, end: init.start, text: `__elmViewCap(${jsStr(qname)}, ` });
        edits.push({ start: init.end, end: init.end, text: ')' });
        stats.captured = (stats.captured || 0) + 1;
      }
    },

    // Html.Lazy instrumentation: tag the memoized fn at every application so the
    // runtime wrapper (see lazyRuntime) can attribute hits/misses to it. We wrap
    // ONLY the memo-fn argument with __ln("key", fn) — arity/behavior unchanged,
    // so this is safe for partial and point-free applications alike. The actual
    // counting happens in the global lazy wrapper, not here.
    CallExpression(path) {
      if (!opts.lazy) return;
      const n = path.node;
      let memo;
      if (t.isIdentifier(n.callee) && LAZY_RE.test(n.callee.name)) {
        // direct/partial call: lazyId(memo, …)
        memo = n.arguments[0];
      } else if (
        t.isIdentifier(n.callee) &&
        /^A[2-9]$/.test(n.callee.name) &&
        n.arguments[0] &&
        t.isIdentifier(n.arguments[0]) &&
        LAZY_RE.test(n.arguments[0].name)
      ) {
        // A-call: A_(lazyId, memo, …)
        memo = n.arguments[1];
      } else return;
      if (!memo) return;
      sawLazy = true;
      // idempotency: don't re-wrap an already-tagged memo
      if (t.isCallExpression(memo) && t.isIdentifier(memo.callee) && memo.callee.name === '__ln') return;
      // key: the memo fn if it's a named app decl, else the enclosing declaration
      let key;
      if (t.isIdentifier(memo) && memo.name.startsWith(opts.prefix)) {
        key = demangle(memo.name, opts.prefix);
      } else {
        const dp = path.findParent(
          (p) => p.isVariableDeclarator() && t.isIdentifier(p.node.id) && p.node.id.name.startsWith(opts.prefix)
        );
        key = dp ? demangle(dp.node.id.name, opts.prefix) + '/lazy' : null;
      }
      if (!key) return; // library lazy with no app context — runtime still counts it under a fallback key
      edits.push({ start: memo.start, end: memo.start, text: `__ln(${jsStr(key)}, ` });
      edits.push({ start: memo.end, end: memo.end, text: ')' });
      stats.lazy = (stats.lazy || 0) + 1;
    },
  });

  // inject runtime(s) once, before the first app declaration (kernel helpers +
  // _Debug_toString are in scope there; __mkLazy/__ln are function-hoisted so the
  // kernel wraps below can call them despite running earlier in the file)
  let runtime = '';
  if (opts.capture && stats.spliced + stats.wrapped > 0) runtime += captureRuntime();
  if (opts.lazy && sawLazy) runtime += lazyRuntime();
  if (runtime) {
    const at = code.indexOf('var ' + opts.prefix);
    if (at !== -1) edits.push({ start: at, end: at, text: runtime });
  }

  // wrap each kernel lazy maker in place, right after its definition — so every
  // downstream alias/consumer (including init-time point-free partials) inherits
  // the counting wrapper regardless of Elm's dependency-ordered emission
  if (opts.lazy && sawLazy) {
    for (const kw of kernelWraps) {
      edits.push({ start: kw.pos, end: kw.pos, text: `;${kw.name}=__mkLazy(${kw.name},${kw.arity});` });
    }
  }

  // Apply edits back-to-front so earlier offsets stay valid. Edits target
  // disjoint sub-ranges (attr lists / opaque leaves), so ordering by start is
  // sufficient; skip any accidental overlap defensively.
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  let lastStart = Infinity;
  for (const e of edits) {
    if (e.end > lastStart) continue; // overlap guard
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    lastStart = e.start;
  }

  if (opts.overlay) {
    var manifestJs = '';
    if (opts.manifest && typeof opts.manifest === 'object') {
      // embed only the entries for views actually tagged in THIS bundle, so a
      // whole-project manifest doesn't bloat every target's output
      var subset = {};
      for (var i = 0; i < stats.tagged.length; i++) {
        var qn = stats.tagged[i];
        if (opts.manifest[qn]) subset[qn] = opts.manifest[qn];
      }
      manifestJs = '\n;try{window.__elmViewManifest=' + JSON.stringify(subset) + '}catch(e){}';
    }
    out += '\n;/* elm-view-name overlay */' + manifestJs + '\n' + overlaySource() + '\n';
  }

  return { code: out, stats };
}

module.exports = { transform, demangle, classifyElement };
