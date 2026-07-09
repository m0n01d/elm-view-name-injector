# Design notes

How this tool was derived, the Elm codegen facts it relies on, and the
classifier that drives it. All findings were verified by compiling the
[`example/`](../example) corpus with Elm 0.19.1 and inspecting the output.

## Approaches considered

| | elm-review wrap (source) | **compiled-JS transform** (this tool) |
|---|---|---|
| DOM impact | always adds a wrapper node | **none** for element roots (splices onto the real element) |
| Qualified name | module header + decl (AST) | **free** from the mangled var name |
| Detection | needs a type annotation (elm-review has no type inference) | structural, from stable Html symbols — no annotation needed |
| Touches your source | yes (codemod + revert) | **no** — post-processes build output |
| Composition coverage | universal via wrapper | splice root only → nesting is automatic |
| Fragility | stable Elm syntax | Elm codegen internals (stable but undocumented) |
| Runs at | edit/codemod time | build time |

The runtime is impossible without a wrapper: `Html msg` is opaque, and there is
no `addAttribute : Attribute msg -> Html msg -> Html msg`. The compiled JS has
the attribute list as a plain argument, so we can inject onto the real element.

## Elm 0.19.1 codegen facts relied on

- **App symbols**: `var $author$project$<Module>$<decl> = …`. The
  `$author$project$` prefix is hard-coded for application (non-package) code;
  dependencies are `$elm$…`, `$user$pkg$…`. Demangle by stripping the prefix,
  splitting on `$`: last segment = decl, the rest joined by `.` = module.
- **Elements**:
  - `A2($elm$html$Html$<tag>, attrs, kids)` — attrs is argument index **1**.
  - `A3($elm$html$Html$node, tag, attrs, kids)` and
    `A3($elm$html$Html$Keyed$node, …)` — attrs is argument index **2**.
- **Attributes and event handlers share one list** (`Events.onClick` sits
  alongside `Attributes.class` in the same `_List_fromArray`), so injection is
  the same regardless of what's already there.
- **Arity**: 1-arg → bare `function(x){…}`; N-arg → `F<N>(function(…){…})`;
  0-arg → the element call is the initializer directly.
- **Control flow**: `if` → a ternary inside `return`; `case` → a `switch` with
  **one `return` per branch**; `let` → `var`s before the `return`; `|>` pipes
  ending in an element are **inlined** to a plain element call.
- **Kernel helpers** `_List_Cons`, `_List_fromArray`, `_List_Nil`,
  `_VirtualDom_attribute` are always present in an Html app.

### The tree-shake lesson

`$elm$html$Html$Attributes$attribute` is **dead-code-eliminated** if the app's
own source never calls `Html.Attributes.attribute` (the example corpus had 0
references → injecting it produced `ReferenceError: … is not defined` at render).
`Html.Attributes.attribute` compiles down to the kernel `_VirtualDom_attribute`
(`F2(function(key, value){…})`), which is always bundled. **We inject that.**
Lesson: never reference a package-level symbol you don't know survives; prefer
kernel helpers.

## The injection

```js
// attrs'  =  _List_Cons( A2(_VirtualDom_attribute, "elm-view-name", "Module.decl"), attrs )
```

Consing onto *whatever the attrs expression is* means we don't case on its shape
— `_List_fromArray([...])`, `_List_Nil`, `A2($elm$core$List$cons, …)`, and
`_Utils_ap(base, extra)` are all handled uniformly.

## Classifier (verified against the corpus)

| Return/init shape | Example (module.decl) | Action |
|---|---|---|
| `A2(Html$<tag>, …)` (bare, F1, F2, F3) | `Main.viewA0`–`viewA3`, `Widget.Counter.view` | **splice** arg 1 |
| attrs `_List_Nil` / cons / `_Utils_ap` | `Main.viewElemEmptyAttrs`, `viewConsAttrs`, `viewAttrsAppended` | **splice** arg 1 |
| ternary (`if`) | `Page.Settings.Form.viewStatus` | **splice both branches** |
| `switch` (`case`) | `Main.viewCase` | **splice each element branch** |
| `let … in` (var before return) | `Page.Settings.Form.viewField` | **splice** the return |
| `A3(Html$node, …)` / `Keyed$node` | `Main.viewCustomNode`, `Main.viewKeyed` | **splice** arg 2 |
| element root, child *calls* in kids | `Ui.Layout.page`, `Page.Home.viewToolbar` | **splice root** → nesting free |
| higher-order (Html arg) | `Ui.Layout.card` | **splice root**; the arg is tagged upstream |
| `Html$text(…)` | `Main.viewText`, `viewPipeText` | skip (or `--wrap`) |
| `A2(Html$map, …)` | `Main.viewMap` | skip (or `--wrap`); `map` blocklisted from element regex |
| `A2(Html$Lazy$lazy, …)` | `Main.viewLazy` | skip (or `--wrap`) |
| call to another view (same or cross module) | `Main.viewDelegate`, `Page.Home.view` (→`Ui.Layout.page`) | skip — callee self-tags |
| alias `var x = y;` | `Main.viewPointFree` | skip |
| `_List_fromArray([...])` (List return) | `Main.viewItems` | skip — not a single element |
| records / model | `Main.init`, `Main.update` | skip |

## Edge cases handled

- Collect **every** `return` (switch branches), not just one.
- Recurse into `ConditionalExpression` branches.
- Don't descend into nested closures (e.g. the lambda in `List.map`) when
  collecting a function's own returns.
- **Idempotency**: re-running is a no-op (skip if the attrs list already starts
  with our `_VirtualDom_attribute "elm-view-name"` cons).
- `--wrap` uses `_VirtualDom_attribute "style" "display:contents"` so it depends
  on no tree-shakable symbol and stays layout-neutral.

## Open questions / future work

- Recursive views (a menu that calls itself) — should tag fine (local splice),
  untested.
- `--optimize` output: symbols we read survive optimize (only minify renames
  them); record-field mangling doesn't affect us. Worth a dedicated fixture.
- Minimal-diff printing via recast keeps unchanged code byte-identical; consider
  a `--compact` mode using `@babel/generator` for smaller output.
- A companion `elm-review` **data extractor** could emit a `name → file:line`
  manifest to pair with the DOM attributes (click element → jump to source).
