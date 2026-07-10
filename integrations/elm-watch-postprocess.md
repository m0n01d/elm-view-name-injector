# Live tagging under `elm-watch hot` (the ui repo)

The one-shot `scripts/try-on-elm-watch.mjs` is fine for a snapshot, but it gets
overwritten on the next hot recompile. To tag **every** hot reload
automatically, hook the injector into the existing elm-watch postprocess.

This assumes the injector repo sits next to the ui repo:

    …/AVETTA/ui
    …/AVETTA/elm-view-name-injector   <- sibling

## Edit `ui/scripts/elm-watch-postprocess.mjs`

Add an import near the top:

```js
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Inert unless ELM_VIEW_NAMES is set, so this is SAFE TO COMMIT — it changes
// nothing in normal builds. Resolves the sibling injector repo.
const viewNames = process.env.ELM_VIEW_NAMES
  ? require("../../elm-view-name-injector/src/inject-view-names.js")
  : null;
```

Then change the `postprocess` function so dev/hot builds get tagged:

```js
const postprocess = async ({ code, compilationMode, runMode }) => {
  if (compilationMode === "optimize") {
    return minify(await transform(code, false, true, false)); // unchanged
  }
  // standard / debug / hot: optionally inject view names.
  //   ELM_VIEW_NAMES=1        -> tag elements only
  //   ELM_VIEW_NAMES=overlay  -> tag + append the in-page DevTools overlay
  return viewNames
    ? viewNames.transform(code, { overlay: process.env.ELM_VIEW_NAMES === 'overlay' }).code
    : code;
};
```

## Run

```sh
cd ui
ELM_VIEW_NAMES=1 npm start        # hot dev, every reload tags views
# (plain `npm start` = off, production `npm run build` = untouched)
```

Now every recompile — including your WS-5278 changes — re-tags automatically.
Inspect in DevTools:

```js
document.querySelectorAll('[elm-view-name]')
$0.getAttribute('elm-view-name')   // pick an element, see which fn rendered it
```

## Notes

- **Off by default / production-safe.** Guarded by `ELM_VIEW_NAMES` and skipped in
  `optimize` mode, so `npm run build` is never affected. Committing the edit is
  harmless.
- **Perf.** The transform re-parses/prints the bundle. On the ~2.8 MB Client app
  expect a couple extra seconds per hot reload. Small apps are instant.
- **Prereq.** `cd ../elm-view-name-injector && npm install` once (for its
  Babel/recast deps).
- **No PR pollution.** `public/pre-compiled/**` is gitignored; this edit is the
  only touched tracked file, and it's inert without the env var.
