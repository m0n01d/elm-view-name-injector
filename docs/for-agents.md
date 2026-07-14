# Using this from a coding agent

If you're an LLM agent doing feature work on an Elm app, the overlay UI isn't the
useful part — the **runtime signals** the injector plants in a dev build are.
They give you a bridge you can't get from static analysis: from *what actually
rendered in the browser, in this state* to *the exact Elm function and source
line to edit*. `grep` finds where a view is **defined**; these signals tell you
what's **on screen** and where its code lives.

Drive them from whatever browser surface you have — a preview pane's
`javascript_tool`, a real-browser MCP, or a Playwright page.

## The four signals

| Signal | Where | What it gives you |
|---|---|---|
| `elm-view-name="Module.fn"` | attribute on every rendered element | map any DOM node → its Elm view function |
| `window.__elmViewManifest` | global: `{ "Module.fn": { file, line, sig } }` | that function → source `file:line` + its type signature |
| `window.__elmViewArgs` | global: `{ "Module.fn": [arg0, arg1, …] }` (Debug builds) | the raw arguments the view was last called with |
| `window.__elmLazyStats` | global: `{ key: { enc, miss } }` | `Html.Lazy` hit/miss — memoization behavior |

`elm-view-name`, the manifest, and lazy stats work in any dev build.
`__elmViewArgs` needs `_Debug_toString`, i.e. an Elm **Debug** build (in
elm-watch, toggle Debug in its overlay); pair it with
`window.__elmViewToString(value)` to render an Elm value as a readable string.
The manifest only contains views the injector actually tagged.

## Cookbook

**DOM → source — the one you'll use most.** Given a visible element (from a
coordinate, a text match, a `data-qa`, whatever), get the code to open:

```js
const el = document.elementFromPoint(x, y).closest('[elm-view-name]');
const name = el.getAttribute('elm-view-name');
({ name, ...window.__elmViewManifest?.[name] })   // → { name, file, line, sig }
```

then `Read <file>:<line>` in the repo.

**"Did my view actually render?"** — a mount/regression check that beats scraping
for brittle text or classes:

```js
!!document.querySelector('[elm-view-name="App.Client.Pages.MyPage.viewCard"]')
```

**"What views make up this page / region?"** — orient before editing:

```js
[...document.querySelectorAll('[elm-view-name]')].map(e => e.getAttribute('elm-view-name'))
// or scope to a subtree: someEl.querySelectorAll('[elm-view-name]')
```

**"What data did this view receive?"** (Debug build):

```js
const name = 'App.Client.Pages.MyPage.viewCard';
(window.__elmViewArgs?.[name] || []).map(a => window.__elmViewToString(a))
```

**"Is this view re-rendering when it shouldn't?"** — check memoization:

```js
window.__elmLazyStats   // low hit rate on a hot view ⇒ a lazy that always misses
```

**Whole-app map for planning** — every tagged view → file:line:

```js
window.__elmViewManifest
```

**E2E selectors** — Playwright/tests can target `[elm-view-name="Module.fn"]` as a
semantic locator alongside `data-qa`.

## The loop it closes

1. Make a change, load the affected screen.
2. Confirm the intended view mounted (`querySelector` above) — no guessing from a
   screenshot.
3. If something's off, click/inspect the element → `elm-view-name` → manifest →
   open the precise `file:line` → edit.
4. Re-verify the same view re-rendered.

You're working from runtime ground-truth instead of inferring structure from
source.

## Enabling it in a dev build

The signals only exist if the bundle was run through the injector. In an
elm-watch project this is one postprocess hook — see
[../integrations/elm-watch-postprocess.md](../integrations/elm-watch-postprocess.md)
for the drop-in. In short, per worktree:

1. Clone this repo somewhere the project's postprocess can `require` it (e.g. a
   sibling directory).
2. Wire the postprocess hook, enabling the options you want:
   `overlay` (the panel), `capture` (→ `__elmViewArgs`, Debug), `lazy`
   (→ `__elmLazyStats`), and a `manifest` built by `src/manifest.js`
   (→ `__elmViewManifest`). All are pure, dev-only, and skipped in `optimize`.
3. Restart the dev server and hard-reload the page.

For a one-off bundle (no elm-watch), the CLI does the same: `node bin/cli.js
out.js -i --overlay` (see the [README](../README.md)).

## Gotchas

- **Dev only.** The injector is skipped in `optimize`/production builds, so none
  of these globals exist there — don't write app code that depends on them.
- **Restart after changing the injector.** elm-watch's worker `require`-caches
  the injector at startup; edits won't take effect until the dev server
  restarts.
- **Hard-reload after changing the overlay.** The overlay mounts once and guards
  re-mount, so a hot update won't replace an already-mounted old copy — do a
  full reload.
- **Args need Debug.** `__elmViewArgs` / `__elmViewToString` are only populated
  in a Debug build.
- **Manifest line numbers can drift** between a save and a recompile; treat
  `file:line` as a strong lead and confirm against the source.
