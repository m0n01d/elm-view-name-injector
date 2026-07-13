# Spec: inspect view arguments (and the reality of editing them)

**Status:** design / spec. Branch: `experiment/inspect-view-args`.

Goal: when you select a view in the overlay, see the actual **argument values**
that view function was called with. Stretch goal: edit a value and re-render.

This is the React-DevTools "props/state" feature. It's the hardest one to bring
to Elm, so this doc is deliberately explicit about what's feasible and what
isn't.

---

## Why this is hard (Elm vs React)

| | React | Elm |
|---|---|---|
| "props" | a discrete object on a component instance | positional **arguments** of a pure function |
| where they live | retained on the fiber | **not retained** — gone once `view model` returns |
| state | per-component, mutable via DevTools | one app `model`; views are pure projections of it |
| set from outside | `setState` / props edit | **no public API** to read or set the running model |

So there is no per-component state to read, args aren't stored anywhere, and the
runtime model is sealed in a kernel closure. Everything below works *around*
that.

## Feasibility summary

- **Inspect (read-only): feasible.** Capture args at call time, render them with
  `_Debug_toString`. Verified: `_Debug_toString` is present in `--debug`/dev
  builds; function values expose `.a`/`.f` so a wrapper can preserve arity.
- **Edit + re-render: not feasible in general.** Three hard blockers (see Phase 3).
  The realistic answer is Elm's built-in `--debug` debugger, not us.

## Key runtime facts (verified against a `--debug` bundle)

- `function F(arity, fun, wrapper){ wrapper.a = arity; wrapper.f = fun; return wrapper }`
- `A2(fun,a,b) = fun.a === 2 ? fun.f(a,b) : fun(a)(b)` (and A3/A4…). So a view fn
  value is an F-object; to wrap it we must return an F-object of the **same
  arity**.
- `_Debug_toString(value)` renders any Elm value to a string (real output in
  dev/`--debug`; stubbed under `--optimize`).
- **Scope:** the compiled app is one IIFE — `(function(scope){ …kernel…; _Platform_export(…) }(this))`.
  `F`, `A2`, `_Debug_toString` are **IIFE-locals**. The overlay is appended
  *after* the IIFE, so it can't see them. Anything the overlay needs must be
  bridged onto `window` from **inside** the bundle.

---

## Phase 1 — Inspect, per-function (last-call args)

### Capture (in-bundle transform, inside the IIFE)
For each tagged view function, wrap its value:

```js
// $author$project$M$view = F2(function(model, x){ … })
$author$project$M$view = __ev("M.view", F2(function(model, x){ … }));
```

Inject one helper (inside the IIFE, so it can use `F`):

```js
function __ev(name, fn) {
  if (fn && fn.a) {                      // F-wrapped (arity ≥ 2)
    return F(fn.a, function () {
      window.__elmViewArgs[name] = [].slice.call(arguments); // last call wins
      return fn.f.apply(null, arguments);
    }, fn);                              // reuse fn as the curried fallback
  }
  return function (a) {                  // arity 1
    window.__elmViewArgs[name] = [a];
    return fn(a);
  };
}
window.__elmViewArgs = {};
```

Also bridge the stringifier once, inside the IIFE where it's in scope:

```js
try { window.__elmViewToString = _Debug_toString; } catch (_) {}
```

Notes:
- Only wrap **arity ≥ 1** functions (arity-0 bare values have no args → skip).
- Store **raw value references** (cheap); do **not** stringify on every render.
- Retaining the last args keeps one model ref alive per view — negligible.

### Display (overlay, reads globals)
On select: `args = window.__elmViewArgs[qname]`; render each with
`window.__elmViewToString(arg)` into a collapsible **"Args"** section under the
footer. Stringify **lazily on select only**.

### Known limits
- **Per-function, not per-instance.** A view rendered many times (list rows)
  shows the **last** call's args. Accurate for singletons (most page/component
  views). Per-instance = Phase 2.
- **Big values.** Elm threads a large `model`; `_Debug_toString(model)` can be
  huge → truncate, collapse, expand-on-demand.
- **Mode.** Reliable where `_Debug_toString` is real (dev/`--debug`). The team
  runs `--debug`, so fine; detect absence and show a hint otherwise.

## Phase 1.5 — Label the args
Args compile to `a`, `b`, `_v0` — no names. Extend the manifest to also record
each view's **parameter names + type annotation** (parse `fn : A -> B -> Html`
and the arg patterns from source). Then show `model : Model = …`, not `arg 0`.

## Phase 2 — Per-instance accuracy
Correlate a specific DOM node to the specific call.
- Inject a runtime per-call id: prepend `var __id = __evNext(); __elmViewArgs[__id] = [args]`
  to the body and add a dynamic `attribute "elm-view-id" (String __id)` into the
  root element's attrs (next to `elm-view-name`). Overlay: element →
  `elm-view-id` → that instance's args.
- More invasive (modifies fn bodies + threads a runtime var into the splice);
  opaque/wrapped views fall back to per-function.

## Phase 3 — Edit + re-render (honest assessment)

Editing a view's **arg** in isolation isn't meaningful: the arg is derived from
`model`, and the next render recomputes it. The real target is editing the
**model**. Blockers:

1. **No public model get/set.** The running model lives in a kernel closure.
   Elm's `--debug` debugger mutates it via kernel; that path isn't scriptable
   from our overlay.
2. **No generic string→value deserialization.** `_Debug_toString` is one-way.
   Rebuilding an Elm value from edited text needs a per-type decoder we don't
   have — so even a sandboxed "re-run this view with edited args" is blocked.
3. **Args aren't independent state.** Overwriting them wouldn't persist past the
   next frame.

Realistic paths:
- **Defer to the native debugger.** It already does model export/import +
  time-travel. We can add a bridge — "copy model JSON" / "open debugger" — rather
  than reinvent it.
- **Kernel patch** (patched virtual-dom exposing `setModel`): fragile, ties us to
  internals — out of scope.

**Recommendation:** ship inspect (Phases 1–1.5, maybe 2). For "edit," lean on
Elm's debugger; revisit only for a concrete, bounded use case.

---

## Rollout plan
1. Phase 1: `captureArgs` option in `transform` (in-bundle: inject `__ev` +
   `__elmViewArgs` + `_Debug_toString` bridge; wrap tagged fn values). Overlay
   "Args" section, lazy stringify, truncation. Gate to dev/`--debug`.
2. Phase 1.5: param names/types in the manifest.
3. Phase 2: per-instance ids (opt-in; more invasive transform).
4. Phase 3: **not building edit**; add a "copy model / open debugger" bridge if
   there's demand.

## Risks
- **Perf:** lazy stringify only; never per-render. Wrapping every view adds a
  thin call layer — measure on Client/Config.
- **Arity correctness:** must return same-arity F-objects — test F1/F2/F3 and
  curried call sites.
- **Noise:** big `model` dumps — truncate/collapse.
- **Another partial-application trap:** wrapping fn **values** is safe (we keep
  arity), but verify against partially-applied views like `Icon.element`
  (`A2(lazy4, …)`) — the wrapper must not change how they're later applied.
