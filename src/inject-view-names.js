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

// Runtime for Html.Lazy instrumentation: __lz(key, n) returns a lazy fn of arity
// n that delegates to the real _VirtualDom_lazy* (memo refs untouched), counting
// each encounter and wrapping the thunk's `m` (forced only on a miss) to count
// misses. typeof guards skip lazy variants a bundle didn't include.
function lazyRuntime() {
  return (
    ';(function(){if(typeof window!=="undefined")window.__elmLazyStats=window.__elmLazyStats||{}})();' +
    'var __lzReal={' +
    '2:typeof _VirtualDom_lazy!=="undefined"?_VirtualDom_lazy:null,' +
    '3:typeof _VirtualDom_lazy2!=="undefined"?_VirtualDom_lazy2:null,' +
    '4:typeof _VirtualDom_lazy3!=="undefined"?_VirtualDom_lazy3:null,' +
    '5:typeof _VirtualDom_lazy4!=="undefined"?_VirtualDom_lazy4:null,' +
    '6:typeof _VirtualDom_lazy5!=="undefined"?_VirtualDom_lazy5:null,' +
    '7:typeof _VirtualDom_lazy6!=="undefined"?_VirtualDom_lazy6:null,' +
    '8:typeof _VirtualDom_lazy7!=="undefined"?_VirtualDom_lazy7:null,' +
    '9:typeof _VirtualDom_lazy8!=="undefined"?_VirtualDom_lazy8:null};' +
    'function __lz(key,n){var real=__lzReal[n];if(!real)return function(){return null};' +
    'var rec=(window.__elmLazyStats[key]=window.__elmLazyStats[key]||{enc:0,miss:0});' +
    'return {a:n,f:function(){var node=real.f.apply(null,arguments);rec.enc++;' +
    'var m=node.m;node.m=function(){rec.miss++;return m()};return node}}}\n'
  );
}

function transform(code, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const stats = { spliced: 0, wrapped: 0, skipped: 0, tagged: [] };
  const edits = []; // { start, end, text }

  const ast = babelParser.parse(code, { sourceType: 'script' });

  traverse(ast, {
    VariableDeclarator(path) {
      const id = path.node.id;
      if (!t.isIdentifier(id) || !id.name.startsWith(opts.prefix)) return;
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

    // Html.Lazy instrumentation: swap the lazy fn for a keyed counter wrapper,
    // leaving the memo args untouched.
    CallExpression(path) {
      if (!opts.lazy) return;
      const n = path.node;
      if (!t.isIdentifier(n.callee) || !/^A[2-9]$/.test(n.callee.name)) return;
      const arity = Number(n.callee.name.slice(1));
      const lazyFn = n.arguments[0];
      if (!t.isIdentifier(lazyFn)) return;
      const mm = LAZY_RE.exec(lazyFn.name);
      if (!mm) return;
      // lazy=A2, lazy2=A3, … lazyK=A(K+1). Skip partial applications (arity < full).
      if (arity !== (mm[1] ? Number(mm[1]) + 1 : 2)) return;
      // key: the memoized fn (arg 1) if named, else the enclosing declaration
      const memo = n.arguments[1];
      let key;
      if (memo && t.isIdentifier(memo) && memo.name.startsWith(opts.prefix)) {
        key = demangle(memo.name, opts.prefix);
      } else {
        // fall back to the enclosing app declaration; skip library/debugger lazies
        const dp = path.findParent(
          (p) => p.isVariableDeclarator() && t.isIdentifier(p.node.id) && p.node.id.name.startsWith(opts.prefix)
        );
        if (!dp) return;
        key = demangle(dp.node.id.name, opts.prefix) + '/lazy';
      }
      edits.push({ start: lazyFn.start, end: lazyFn.end, text: `__lz(${jsStr(key)}, ${arity})` });
      stats.lazy = (stats.lazy || 0) + 1;
    },
  });

  // inject runtime(s) once, before the first app declaration (kernel helpers +
  // _Debug_toString are in scope there)
  let runtime = '';
  if (opts.capture && stats.spliced + stats.wrapped > 0) runtime += captureRuntime();
  if (opts.lazy && (stats.lazy || 0) > 0) runtime += lazyRuntime();
  if (runtime) {
    const at = code.indexOf('var ' + opts.prefix);
    if (at !== -1) edits.push({ start: at, end: at, text: runtime });
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
