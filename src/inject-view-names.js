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

const babelParser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const DEFAULTS = {
  prefix: '$author$project$', // Elm hard-codes this for application (non-package) code
  attr: 'elm-view-name',
  wrap: false,
};

// elm/html element constructors: `$elm$html$Html$<lowercaseTag>` (div, span, main_, ...).
// `map` (arg 1 is a child) and `node` (arity 3 — as A2 it's a partial application
// whose arg 1 is the TAG string, NOT attrs) match the shape but are NOT 2-arity
// elements, so they must be blocklisted here. `node` is still tagged via the A3
// branch when fully applied.
const A2_ELEMENT_RE = /^\$elm\$html\$Html\$[a-z][A-Za-z0-9_]*$/;
const A2_BLOCKLIST = new Set(['$elm$html$Html$map', '$elm$html$Html$node']);
// arity-3 element constructors (custom + keyed nodes): attrs is the 3rd arg.
const A3_ELEMENTS = new Set(['$elm$html$Html$node', '$elm$html$Html$Keyed$node']);
// stdlib-opaque Html values we can safely `--wrap` (definitely Html, no attr slot).
const OPAQUE_HTML = new Set([
  '$elm$html$Html$text',
  '$elm$html$Html$map',
  '$elm$html$Html$Lazy$lazy',
  '$elm$html$Html$Lazy$lazy2',
  '$elm$html$Html$Lazy$lazy3',
  '$elm$html$Html$Lazy$lazy4',
  '$elm$html$Html$Lazy$lazy5',
]);

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
  if (!t.isCallExpression(node)) return false;
  if (t.isIdentifier(node.callee) && OPAQUE_HTML.has(node.callee.name)) return true; // text(x)
  if (t.isIdentifier(node.callee) && /^A\d+$/.test(node.callee.name)) {
    const first = node.arguments[0];
    if (t.isIdentifier(first) && OPAQUE_HTML.has(first.name)) return true;
  }
  return false;
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
        } else {
          stats.skipped++;
        }
      }
    },
  });

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

  return { code: out, stats };
}

module.exports = { transform, demangle, classifyElement };
