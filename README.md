# Expo `"use dom"` blank on iOS — investigation scaffold

⚠️ **This minimal app does NOT currently reproduce the bug.** It was built as an
attempt to isolate an iOS-only WKWebView content-process-death bug we hit in
our production app (Expo SDK 56, RN 0.85.3, Fabric). Both the SMALL and LARGE
buttons in this repro render their DOM component successfully. We are leaving
the scaffold here because:

1. It's a starting point for adding more layers (react-navigation, providers,
   concurrent work) until the bug surfaces.
2. The accompanying [`EXPO_ISSUE_DRAFT.md`](./EXPO_ISSUE_DRAFT.md) contains the
   full diagnosis from our production app — concrete Metro logs, things tried,
   suspected root cause, suggested upstream fixes — that's the actual value of
   this repo right now.

See [`EXPO_ISSUE_DRAFT.md`](./EXPO_ISSUE_DRAFT.md) for the bug writeup.

## What's in this scaffold

- `App.js` — menu with two buttons: SMALL (1 item) and LARGE (30 items × 50
  lorem-ipsum repeats ≈ 30 KB serialized). Each mounts a `"use dom"` component
  with the chosen payload, plus an on-screen log panel that surfaces
  `[DOM] mount`/`post-paint` events.
- `DomComponent.tsx` — minimal `"use dom"` component, reports lifecycle via
  the `onDomDebug` callback.
- Dependencies the `--template blank` scaffold doesn't include but `"use dom"`
  requires: `@expo/metro-runtime`, `react-dom`, `react-native-web`. Added
  through `npx expo install`.

## How we tried to reproduce

```bash
yarn install            # or npm install
npx expo prebuild --platform ios
npx expo run:ios
```

Then tap SMALL → renders 1 paragraph and logs `[DOM] mount {itemsCount: 1}`.
Tap LARGE → renders 30 paragraphs and logs `[DOM] mount {itemsCount: 30,
bodyHeight: 32637}`. **Both work.** No `[BrowserEngineKit] No such process
found` errors. No blank.

So the differentiator between this passing minimal repro and the failing
production app is something we haven't identified yet. Candidates (none
verified):

1. **Navigation depth.** Production has `App → AuthProvider → NavigationContainer
   → DrawerNavigator → BottomTabs → HomeChatScreen → "use dom"`. This scaffold
   has `App → DomComponent`.
2. **Concurrent main-thread work at mount time.** Production fires many API
   calls / state updates concurrent with the DOM mount (Clerk auth, several
   API requests, Rollbar init, link-preview prefetches, etc.). The scaffold
   does none of this.
3. **Number of marshalled props on the DOM component.** Production passes ~30
   props (theme, callbacks, suggestions, highlights, search metadata, etc.).
   Scaffold passes 2.
4. **Specific libraries.** Production uses `@clerk/clerk-expo`,
   `react-native-keyboard-controller`, `react-native-screens` native stack,
   `react-native-reanimated`, `expo-audio`, `expo-speech`. None of these are in
   this scaffold.

## Suggested layers to add next

If someone has the time to iterate:

- [ ] Add react-navigation (Stack + Drawer + BottomTabs) and mount the DOM
      component inside the deepest tab.
- [ ] Add a concurrent burst of work in `useEffect(() => { ... }, [])` that
      runs at the same React commit as the DOM component mounts (e.g. 5x
      `setTimeout(() => fetch('...'), 0)` calls and a few state updates).
- [ ] Add 20+ extra marshalled props (theme object, callback functions,
      arrays of dummy data).
- [ ] Add `@clerk/clerk-expo` and gate the DOM mount behind an auth flow.

When the scaffold starts blanking after one of these layers is added, we'll
have found the missing trigger and can update the issue with a working repro.

## Bug summary (mirrored from EXPO_ISSUE_DRAFT.md)

In our production app, the WKWebView content process spawns (we see
`[WebKit] WebContent[<PID>] Could not register system wide server: -25204`)
but is killed by iOS before the JS bundle's first `Running application "main"`
log fires. Metro shows `[BrowserEngineKit] Failed to terminate process: ... No
such process found` errors immediately after the WebContent process is
registered, and no DOM-side logs ever appear. The WKWebView surface stays
alive but blank.

This matches the WKWebView content-process-backgrounding race documented in
nevermeant.dev's "Handling Blank WKWebViews" writeup and Apple Developer
Forums thread 766259. Apple's only documented mitigation is the private SPI
`_alwaysRunsAtForegroundPriority` on `WKWebViewConfiguration`, which is App
Store rejection risk.
