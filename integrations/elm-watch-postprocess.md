# Always-on overlay under `elm-watch`

The one-shot `scripts/try-on-elm-watch.mjs` is fine for a snapshot, but it gets
overwritten on the next hot recompile. To tag **every** build automatically and
always show the overlay, hook the injector into your project's elm-watch
postprocess.

This assumes the injector repo sits next to your Elm project:

    …/your-project/          <- your elm-watch app (has scripts/elm-watch-postprocess.mjs)
    …/elm-view-name-injector <- sibling

If your project doesn't have a postprocess yet, add one in `elm-watch.json`:

```json
{ "postprocess": ["elm-watch-node", "scripts/elm-watch-postprocess.mjs"] }
```

## Edit `scripts/elm-watch-postprocess.mjs`

Near the top, require the sibling injector (safe if it's missing):

```js
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Tags view fns + appends the in-page overlay in dev/debug builds — always on.
// No-ops if the sibling repo isn't cloned; skipped in optimize (see below), so
// production is unaffected.
let viewNames = null;
try {
  viewNames = require("../../elm-view-name-injector/src/inject-view-names.js");
} catch (e) {
  // sibling repo not present — dev build proceeds without the overlay
}
```

Then in your `postprocess`, run it for non-`optimize` builds:

```js
const postprocess = async ({ code, compilationMode }) => {
  if (compilationMode === "optimize") {
    return code; // (or your minifier) — production untouched
  }
  return viewNames ? viewNames.transform(code, { overlay: true }).code : code;
};
```

## Run

```sh
npm start        # or however you launch elm-watch hot — no flag needed
```

Toggle **Debug** in the elm-watch overlay if you want the time-travel debugger
too; the injector's badge parks top-right so the two don't collide. Inspect in
DevTools:

```js
document.querySelectorAll('[elm-view-name]')
$0.getAttribute('elm-view-name')   // pick an element, see which fn rendered it
```

## Notes

- **Production-safe.** Skipped in `optimize` mode, so production builds are never
  affected.
- **Perf.** The transform re-parses the bundle; on a multi-MB app expect a few
  extra seconds per hot recompile. If that's too much, scope it to the target
  you're working on, or gate it behind an env var.
- **Prereq.** `cd ../elm-view-name-injector && npm install` once (Babel deps).
- **Jump-to-source.** Generate a manifest so the overlay can open files:
  `node ../elm-view-name-injector/bin/manifest.js . -o public/elm-view-manifest.json`
  (the overlay fetches `/elm-view-manifest.json` when nothing is embedded).
- **No diff pollution.** elm-watch's compiled output is typically gitignored, so
  only this one script file changes.
