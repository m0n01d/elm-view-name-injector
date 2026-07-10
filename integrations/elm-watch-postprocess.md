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
import { fileURLToPath } from "url";
import path from "path";
const require = createRequire(import.meta.url);

// Tags view fns, embeds a fresh source manifest (jump-to-source), and appends
// the in-page overlay in dev/debug builds — always on. No-ops if the sibling
// repo isn't cloned; skipped in optimize (see below), so production is untouched.
let viewNames = null;
let buildManifest = null;
try {
  viewNames = require("../../elm-view-name-injector/src/inject-view-names.js");
  buildManifest = require("../../elm-view-name-injector/src/manifest.js").buildManifest;
} catch (e) {
  // sibling repo not present — dev build proceeds without the overlay
}

// this repo's root (…/scripts/elm-watch-postprocess.mjs -> …/)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
```

Then in your `postprocess`, run it for non-`optimize` builds:

```js
const postprocess = async ({ code, compilationMode }) => {
  if (compilationMode === "optimize") {
    return code; // (or your minifier) — production untouched
  }
  if (!viewNames) return code;
  // rebuild the manifest each compile so jump-to-source line numbers stay accurate;
  // transform() embeds only the entries for views tagged in this bundle
  const manifest = buildManifest ? buildManifest(projectRoot) : undefined;
  return viewNames.transform(code, { overlay: true, manifest }).code;
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

## Tagging `text` / `map` / `lazy` too (`wrap`)

Views that return opaque Html — `text "…"`, `Html.map`, `Html.Lazy.lazy` — have
no attribute list to splice into, so they're **skipped** by default (they render
untagged and don't appear in the overlay tree). To tag them anyway, pass `wrap`,
which wraps each in a layout-neutral `display:contents` div carrying the name.

There's no `--wrap` flag in this flow (that's for the standalone CLI). Instead
gate it behind an env var in the postprocess — it adds a DOM node, which can
affect child-combinator CSS (`.parent > .child`, `:first-child`, `+`/`~`), so
it's worth opting in deliberately:

```js
return viewNames.transform(code, {
  overlay: true,
  manifest,
  wrap: process.env.ELM_VIEW_WRAP === "1",
}).code;
```

```sh
ELM_VIEW_WRAP=1 npm start   # overlay + wrap; plain `npm start` = overlay only
```

Restart to toggle it (env is read at startup). If a page looks off with wrap on,
drop back to plain `npm start`.

## Notes

- **Production-safe.** Skipped in `optimize` mode, so production builds are never
  affected.
- **Perf.** The transform re-parses the bundle; on a multi-MB app expect a few
  extra seconds per hot recompile. If that's too much, scope it to the target
  you're working on, or gate it behind an env var.
- **Prereq.** `cd ../elm-view-name-injector && npm install` once (Babel deps).
- **Jump-to-source is automatic** with the snippet above — the manifest is rebuilt
  and embedded on every compile. (Alternative: skip the `manifest` option and
  serve a generated file instead —
  `node ../elm-view-name-injector/bin/manifest.js . -o public/elm-view-manifest.json`
  — the overlay fetches `/elm-view-manifest.json` when nothing is embedded.)
- **No diff pollution.** elm-watch's compiled output is typically gitignored, so
  only this one script file changes.
