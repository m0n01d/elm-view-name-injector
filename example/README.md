# example corpus

A small multi-module Elm app whose `Main.view` transitively references every
view so nothing tree-shakes. Used as the demo and (compiled) as the test fixture.

## Module tree (views are spread out on purpose)

| Module | File | Views | Exercises |
|---|---|---|---|
| `Main` | `src/Main.elm` | `viewA0`–`viewA3`, `viewCase`, `viewKeyed`, `viewCustomNode`, `viewConsAttrs`, `viewChildrenMap`, `viewOneAttr`…`viewManyAttrsEvents`, `viewAttrsAppended`, `view`, + negatives | arity (F1/F2/F3/bare), return shapes, 0–5 attrs/events |
| `Types` | `src/Types.elm` | — | shared `Model`/`Msg` (avoids an import cycle) |
| `Ui.Button` | `src/Ui/Button.elm` | `primary`, `secondary` | msg-agnostic F2 components |
| `Ui.Layout` | `src/Ui/Layout.elm` | `card`, `page` | higher-order / slot wrappers (`Html msg` arg + `::` children) |
| `Widget.Badge` | `src/Widget/Badge.elm` | `view` | a `view` distinct from every other `view` |
| `Widget.Counter` | `src/Widget/Counter.elm` | `view` | element with events, uses shared `Model`/`Msg` |
| `Page.Home` | `src/Page/Home.elm` | `view`, `viewToolbar` | cross-module compose; **`view` delegates** to `Ui.Layout.page` (skipped) |
| `Page.Settings.Form` | `src/Page/Settings/Form.elm` | `view`, `viewField`, `viewStatus` | **3-segment module path**; `let` and `if` return shapes |

## What it proves

- **Demangling across many modules**, including `Page.Settings.Form.*`
  (3 segments) and four different `view` functions that stay distinct.
- **Cross-module nesting** emerges automatically, e.g.
  `Widget.Badge.view < Ui.Layout.card < Ui.Layout.page < Main.view`.
- **Cross-module delegation**: `Page.Home.view` returns `Ui.Layout.page (...)`,
  so it's skipped and `Ui.Layout.page` tags the rendered `<section>`.
- **Negatives**: `viewText`/`viewMap`/`viewLazy`/`viewDelegate`/`viewPointFree`
  (opaque/alias) and `viewItems : … -> List (Html Msg)` are not tagged.

## Build & serve

```sh
ELM_BINARY=/path/to/elm node ../scripts/build-example.js   # or: --debug / --wrap
python3 -m http.server 8123 --directory .                  # open /index.html
```

Then in the console: `document.querySelectorAll('[elm-view-name]')`.
