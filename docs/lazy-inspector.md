# Spec: Lazy hit/miss inspector — Elm's "why did it re-render"

## Goal

For each `Html.Lazy.lazy*` call, show a live **hit / miss** count so you can see
whether memoization is actually working — and catch the classic Elm bug where a
`lazy` recomputes every frame because an argument's referential equality is
broken (a freshly-built list, record, or lambda passed in).

React's "why did this render" doesn't map cleanly to Elm: the whole `view` runs
every frame, so *everything* "re-renders" by default. `Html.Lazy` is the **only**
built-in way to skip work, so the meaningful question is: **is each `lazy`
hitting its cache, or missing (recomputing)?** Frequent misses = wasted work.

`elm-review`'s `UseMemoizedLazyLambda` catches *some* of this statically (inline
lambdas); this catches it **at runtime, live**, including broken equality from
non-lambda args.

## Verified kernel mechanics (elm/virtual-dom, 0.19.1)

```js
function _VirtualDom_thunk(refs, thunk) { return { $: 5, l: refs, m: thunk, k: undefined }; }
var _VirtualDom_lazy  = F2(function(func, a)    { return _VirtualDom_thunk([func, a],    function(){ return func(a); }); });
var _VirtualDom_lazy2 = F3(function(func, a, b) { return _VirtualDom_thunk([func, a, b], function(){ return A2(func, a, b); }); });
// … lazy3 … lazy8
```

A lazy node is a **thunk**: `$: 5`, `l` = the memo refs (`[func, ...args]`),
`m` = the thunk that computes the vdom, `k` = the cached rendered node.

During diff, two thunks are compared by their `l` refs (`===` each):
- **HIT** — all refs equal → the old cached `k` is reused; **`m` is never called**.
- **MISS** — any ref differs → the kernel forces `m()` to recompute, then diffs.
- **MOUNT** — first render forces `m()` once (counts as the first miss).

lazy compiles to `A2($elm$html$Html$Lazy$lazy, fn, a)`, lazy2 to
`A3($elm$html$Html$Lazy$lazy2, fn, a, b)`, … (arity `N = k + 1`).

## Instrumentation

**The trick:** `m` is called **only on a miss/mount**. So:
- count **encounters** = every time a lazy call site runs (creates a thunk), and
- count **misses** = every time that thunk's `m` is forced.
- **hits = encounters − misses** (first encounter is the mount).

### Transform

For each `A<N>($elm$html$Html$Lazy$lazy<k>, …)`, replace the lazy **callee** with
a keyed wrapper (args untouched, so the memo refs `l` are identical — no
behavior change):

```
A2($elm$html$Html$Lazy$lazy, fn, a)   →   A2(__lz("<key>", 2), fn, a)
A3($elm$html$Html$Lazy$lazy2, fn,a,b) →   A3(__lz("<key>", 3), fn, a, b)
```

Runtime helper (injected once, like the other runtimes):

```js
var _lzReal = { 2:_VirtualDom_lazy, 3:_VirtualDom_lazy2, /* …4..9 */ };
window.__elmLazyStats = window.__elmLazyStats || {};   // { key: { enc, miss } }
function __lz(key, n) {
  var real = _lzReal[n];
  var rec = (__elmLazyStats[key] = __elmLazyStats[key] || { enc: 0, miss: 0 });
  return _makeF(n, function(args){          // F<n> of the right arity
    var node = _applyN(real, args);         // the real thunk {$:5, l:args, m, k}
    rec.enc++;
    var m = node.m;
    node.m = function(){ rec.miss++; return m(); };  // forced only on miss/mount
    return node;
  });
}
```

- `node.l` (the memo refs) is left exactly as the real lazy built it → hit/miss
  decisions are unchanged; we only wrap `m` and count.
- `__lz(key, n)` is called each render (cheap: one closure); its identity isn't a
  memo ref, so it can't break memoization.

### Key (attribution)

Derive `key` at transform time from the **memoized function** (first arg):
- identifier `$author$project$Module$name` → demangle → `"Module.name"`
  (e.g. `A2(lazy, $author$project$Page$Home$viewList, model)` → `Page.Home.viewList`).
- lambda / local var → fall back to the enclosing declaration's name +
  `"/lazy#<i>"`.

Most lazies wrap a named top-level view, so keys are usually clean and meaningful.

## Overlay UI

A new **"Lazy"** section (toggle in the header, next to 🎯), listing every lazy
site:

```
Lazy (12 sites)                        [reset]
Page.Home.viewList        142 hit / 3 miss   98%   ▁▁▁▁▁▁▁▁
Page.Grid.viewRow          0 hit / 210 miss   0%   ██████████   ⚠ never memoizes
Ui.Table.body             88 hit / 88 miss   50%   ▄▄▄▄▄▄▄▄
```

- Sort by **miss rate** so the offenders (⚠ 0% — recompute every frame) float up:
  that's the direct answer to "why is this re-rendering."
- Steady-state rate excludes the mount (miss #1), so a healthy lazy reads ~100%.
- **Reset** zeroes counters → measure hits/misses across one interaction ("what
  recomputed when I clicked this?").
- Nice-to-have: badge lazy'd rows in the component tree (⚡ + hit-rate color), and
  clicking a Lazy row selects/【highlights the element (reuses `elm-view-name`).

## Rollout

- New transform option `lazy` (independent of `capture`; **no `_Debug_toString`
  needed** — pure counting, works in any dev build).
- Overlay reads `window.__elmLazyStats`; section hidden if the registry is absent.
- Cost: a counter increment + one closure per lazy per render — negligible.

## Limitations / phases

- **P1:** counts + the sortable Lazy list (keyed by memoized fn).
- **P2:** per-source-site attribution (line numbers) when the same fn is lazied
  at multiple sites; tree badges; reset-per-interaction UX.
- **P3 (out of scope):** "suggest lazy here" — flag expensive *non-lazy* views.
  Non-lazy views always recompute (by design); detecting which are *expensive*
  needs timing (the profiler feature), not this.
- Keys merge multiple call sites of the same memoized fn until P2.
- This measures memoization, not raw render cost; pairs well with a future
  profiler.
