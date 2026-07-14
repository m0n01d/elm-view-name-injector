# Pop out — a detached DevTools window

The in-page overlay is handy but it sits on top of the app. Click **⇱** in the
panel header and it detaches into a separate browser window — like the native
Elm debugger's pop-out — so the page is unobstructed and the panel can live on a
second monitor. **⇤** (or closing the window) pops it back in.

## How it works

The panel and the app it inspects live in **two windows**, but there's only ever
**one JS context** — the overlay IIFE keeps running in the app page. Only the
panel's *DOM* moves.

- **Move, don't rebuild.** Popping out does
  `popupWindow.document.body.appendChild(dt)`. A cross-document `appendChild`
  adopts the node *and keeps its event listeners*, so every button, the search
  box, and the tree wiring keep working with no re-binding.
- **Reads stay local.** Because the code still executes in the app window,
  `window.__elmViewArgs` / `window.__elmLazyStats` / the manifest and
  `document.querySelectorAll('[elm-view-name]')` all resolve against the app —
  no `opener` gymnastics. Internally the app window/document are captured as
  `appWin` / `appDoc` so these never accidentally point at the popout.
- **Highlight stays put.** The highlight box lives in the app window's shadow
  root, so hovering a row in the popout still outlines the real element on the
  page (visible when you look back at the app window — the point of a second
  monitor).
- **Styles travel.** The same CSS string used for the shadow root is written
  into the popout document's `<head>`; a `.dt.popped` variant drops the badge,
  drag, and resize chrome and lets the panel fill the OS window.

## Surviving navigation (the MPA win)

A multi-app frontend does a **full page reload** on every route change, which
resets the inline overlay each time. The popout is a *separate* window, so it
survives — and the overlay re-attaches to it automatically:

1. While popped out, a `localStorage` flag (`__elmViewsPopped`) is set, and the
   window is opened with a stable name (`window.open('', '__elm_view_names_popout', …)`).
2. On the next page load the fresh IIFE reads the flag and calls
   `window.open('', name)` — which returns the **existing** named window (no new
   popup, so no user gesture needed). It clears the stale panel from the old
   page and adopts a fresh one.
3. If the window was closed in the meantime, that call returns `null` (a real
   popup would be blocked without a gesture), so the flag is cleared and the
   overlay stays inline.

The result: the DevTools window **follows you across pages** instead of
resetting — something the inline overlay fundamentally can't do in an MPA.

## Notes & limits

- The first pop-out needs the button click (a user gesture) so the browser
  allows `window.open`; if popups are blocked it logs a warning and stays inline.
- Re-attach across navigation only works for an *already-open* window; closing
  it (or clicking **⇤**) clears the flag.
- Chrome-first. Safari can be finicky about named-window reuse.
- Pure viewer — no app behavior changes; the popout only ever reads.
