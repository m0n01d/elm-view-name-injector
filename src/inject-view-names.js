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
 * No Elm type information is used or needed. Values whose root is not an element
 * (text/map/lazy/delegation/records/lists) are simply left untagged (safe).
 * `--wrap` optionally tags the stdlib-opaque Html forms (text/map/lazy) by
 * wrapping them in a `display:contents` div; see README for the tradeoff.
 */

const recast = require('recast');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const babelParser = require('@babel/parser');

const DEFAULTS = {
  prefix: '$author$project$', // Elm hard-codes this for application (non-package) code
  attr: 'elm-view-name',
  wrap: false,
};

// elm/html element constructors: `$elm$html$Html$<lowercaseTag>` (div, span, main_, ...)
// `map` matches the shape but is NOT an element -> blocklist it.
const A2_ELEMENT_RE = /^\$elm\$html\$Html\$[a-z][A-Za-z0-9_]*$/;
const A2_BLOCKLIST = new Set(['$elm$html$Html$map']);
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

/** Is this expression node an Html element ctor call? Returns { attrsIndex } or null. */
function classifyElement(node) {
  if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return null;
  const args = node.arguments;
  if (node.callee.name === 'A2' && args.length >= 3 && t.isIdentifier(args[0])) {
    const fn = args[0].name;
    if (A2_ELEMENT_RE.test(fn) && !A2_BLOCKLIST.has(fn)) return { attrsIndex: 1 };
  }
  if (node.callee.name === 'A3' && args.length >= 4 && t.isIdentifier(args[0])) {
    if (A3_ELEMENTS.has(args[0].name)) return { attrsIndex: 2 };
  }
  return null;
}

/** stdlib-opaque Html value (text/map/lazy) usable with --wrap? */
function isOpaqueHtml(node) {
  if (!t.isCallExpression(node)) return false;
  if (t.isIdentifier(node.callee) && OPAQUE_HTML.has(node.callee.name)) return true; // text(x)
  // A2(map|lazy, ...) / A3(...) forms
  if (t.isIdentifier(node.callee) && /^A\d+$/.test(node.callee.name)) {
    const first = node.arguments[0];
    if (t.isIdentifier(first) && OPAQUE_HTML.has(first.name)) return true;
  }
  return false;
}

// Kernel helper `_VirtualDom_attribute` (what `Html.Attributes.attribute`
// compiles down to). It's a kernel F2 always present in any Html app, so unlike
// `$elm$html$Html$Attributes$attribute` it is NEVER tree-shaken away — even if
// the app's own source never calls `Html.Attributes.attribute`.
const ATTR_HELPER = '_VirtualDom_attribute';

function attributeCall(qname, attrName) {
  return t.callExpression(t.identifier('A2'), [
    t.identifier(ATTR_HELPER),
    t.stringLiteral(attrName),
    t.stringLiteral(qname),
  ]);
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

  // Unwrap F2/F3/... arity wrappers -> the inner function.
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

  // Bare value: the initializer itself is the rendered expression.
  return expandConditionals([initPath]);
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

function transform(code, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const stats = { spliced: 0, wrapped: 0, skipped: 0, tagged: [] };

  const ast = recast.parse(code, {
    parser: { parse: (src) => babelParser.parse(src, { sourceType: 'script' }) },
  });

  traverse(ast, {
    VariableDeclarator(path) {
      const id = path.node.id;
      if (!t.isIdentifier(id) || !id.name.startsWith(opts.prefix)) return;
      if (!path.node.init) return;
      const qname = demangle(id.name, opts.prefix);
      if (!qname) return;

      for (const exprPath of collectPositions(path.get('init'))) {
        const el = classifyElement(exprPath.node);
        if (el) {
          const attrsPath = exprPath.get('arguments.' + el.attrsIndex);
          if (alreadyTagged(attrsPath.node, opts.attr)) continue;
          attrsPath.replaceWith(
            t.callExpression(t.identifier('_List_Cons'), [
              attributeCall(qname, opts.attr),
              attrsPath.node,
            ])
          );
          stats.spliced++;
          stats.tagged.push(qname);
        } else if (opts.wrap && isOpaqueHtml(exprPath.node)) {
          exprPath.replaceWith(wrapNode(exprPath.node, qname, opts.attr));
          stats.wrapped++;
          stats.tagged.push(qname + ' (wrapped)');
        } else {
          stats.skipped++;
        }
      }
    },
  });

  return { code: recast.print(ast).code, stats };
}

/** Wrap an opaque Html value in a layout-neutral `display:contents` div. */
function wrapNode(node, qname, attrName) {
  const nameAttr = attributeCall(qname, attrName);
  const displayContents = t.callExpression(t.identifier('A2'), [
    t.identifier(ATTR_HELPER),
    t.stringLiteral('style'),
    t.stringLiteral('display:contents'),
  ]);
  const attrs = t.callExpression(t.identifier('_List_Cons'), [
    nameAttr,
    t.callExpression(t.identifier('_List_Cons'), [displayContents, t.identifier('_List_Nil')]),
  ]);
  const kids = t.callExpression(t.identifier('_List_fromArray'), [t.arrayExpression([node])]);
  return t.callExpression(t.identifier('A2'), [t.identifier('$elm$html$Html$div'), attrs, kids]);
}

module.exports = { transform, demangle, classifyElement };
