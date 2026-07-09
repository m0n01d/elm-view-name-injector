# elm-view-name-injector

DevTools-style **component names for Elm**. A post-compile transform that tags
each Elm view function's rendered element with an HTML attribute naming the
function that produced it:

```html
<div elm-view-name="Main.viewParent">
  <span elm-view-name="Main.viewChild">a</span>
  <span elm-view-name="Main.viewChild">b</span>
</div>
```

Point at any element in the browser and know which Elm function rendered it.
No source changes, **no wrapper nodes**, no runtime library — it edits the
compiled JS.

> Status: proof-of-concept. Works against Elm 0.19.1 output in standard **and
> `--debug`** modes. Intended as a **dev/QA build-time tool**, not for
> production bundles.

---

## Why not elm-review / a runtime helper?

Two hard constraints shaped this design:

1. **You cannot add an attribute to an existing `Html msg`.** It's opaque;
   attributes are set only at construction (`Html.node tag attrs kids`). There's
   no `addAttribute : Attribute msg -> Html msg -> Html msg`. A *runtime* helper
   would have to introduce a wrapper element.
2. **The compiled JS has no such limitation.** There, an element is just
   `A2($elm$html$Html$div, attrs, kids)` — the attribute list is a plain
   argument. So we splice our attribute directly onto the **real** element, and
   the fully-qualified name is *free* from the mangled variable name.

See [docs/DESIGN.md](docs/DESIGN.md) for the full comparison and codegen notes.

## How it works

Elm's codegen is boringly regular:

- App symbols are `var $author$project$<Module>$<decl> = …` (the `$author$project$`
  prefix is literal for application code). → demangles to `Module.decl`.
- Elements are `A2($elm$html$Html$<tag>, attrs, kids)` (attrs = arg 1) or
  `A3($elm$html$Html$node|Keyed$node, tag, attrs, kids)` (attrs = arg 2).
- Attributes **and** event handlers share one list, so we just cons onto it.

For every top-level declaration whose rendered root is such an element, we
replace its attrs argument with:

```js
_List_Cons( A2(_VirtualDom_attribute, "elm-view-name", "Module.decl"), <original attrs> )
```

`_VirtualDom_attribute` and `_List_Cons` are **kernel** helpers — always present
in any Html app, immune to tree-shaking (using `$elm$html$Html$Attributes$attribute`
would dangle in apps that never call it in source — a real bug this avoids).

**Composition needs zero special handling.** Each declaration tags only its own
root element; child-view *calls* appear verbatim in parents' children and
self-tag at runtime, so the nested `elm-view-name` DOM tree emerges for free.

Values whose root isn't an element (`text`, `Html.map`, `Html.Lazy.lazy`,
delegation, records, `List (Html msg)`) are left untagged — safe by default.
`--wrap` optionally tags the stdlib-opaque forms (`text`/`map`/`lazy`) via a
layout-neutral `display:contents` div.

## Install

```sh
npm install    # @babel/parser, @babel/traverse, @babel/types, recast
```

## Usage

```sh
# file -> file
node bin/cli.js out.js -o out.tagged.js --stats

# in place
node bin/cli.js out.js -i

# stdin -> stdout (for build pipelines)
cat out.js | node bin/cli.js --stdin > out.tagged.js
```

Options: `--attr <name>` (default `elm-view-name`), `--prefix <str>`
(default `$author$project$`), `--wrap`, `--stats`.

### With plain `elm make`

```sh
elm make src/Main.elm --output=app.js          # or --debug
node bin/cli.js app.js -i
```

### With elm-watch (DEBUG / hot mode)

Add a postprocess step in `elm-watch.json` — it pipes the compiled JS on stdin:

```json
{ "targets": { "App": {
  "inputs": ["src/Main.elm"],
  "output": "build/app.js",
  "postprocess": ["node", "../elm-view-name-injector/bin/cli.js", "--stdin"]
}}}
```

Run the injector **before** any minifier in the chain — it reads the
`$author$project$` symbols, which terser/uglify would rename away. The injected
attribute *values* (`"Main.view"`) are string literals and survive minification.

## Try the example

The [`example/`](example/) corpus exercises ~30 view-function shapes (arity 0–3,
if/case/let/pipe/map/lazy/keyed/custom-node, 0–5 attrs+events, and negative
cases), spread across **7 modules** (`Main`, `Ui.*`, `Widget.*`, `Page.*`,
including the 3-segment `Page.Settings.Form`) to exercise demangling and
cross-module composition. See [example/README.md](example/README.md).

```sh
ELM_BINARY=/path/to/elm node scripts/build-example.js          # or: --debug / --wrap
python3 -m http.server 8123 --directory example                # open index.html
```

Then in the console: `document.querySelectorAll('[elm-view-name]')`.

## Test

```sh
npm test
```

Runs against a committed compiled fixture (`test/fixtures/corpus.compiled.js`) —
no Elm toolchain required. Asserts the full classifier table, branch handling,
negative cases, idempotency, output validity, and `--wrap`.

## Limitations

- **Un-minified input only** — run before terser/uglify.
- **Couples to Elm 0.19.x codegen internals** (stable across 0.19.0→0.19.1, but
  undocumented). Breaks loudly (no matches), not silently.
- Only elements can be splice-tagged; opaque returns need `--wrap` (which adds a
  node) or stay untagged. Delegation targets self-tag anyway.
- `display:contents` wrappers (from `--wrap`) can affect direct-child CSS
  selectors and `querySelector` expectations — hence dev-only.
- SVG is excluded by design.

## License

MIT
