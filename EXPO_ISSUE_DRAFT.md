# `"use dom"` component blanks on iOS — WKWebView content process killed before bundle executes (SDK 56)

## Disclosure up front: we cannot isolate this in a minimal repro yet

We tried to build a minimal `npx create-expo-app --template blank` reproduction that mounts a `"use dom"` component with progressively larger initial-props payloads (up to 30 items × 50 lorem-ipsum repeats ≈ 30 KB serialized). **In that minimal scaffold the bug does not manifest** — both small and large payloads render correctly with the expected `Running application "main"` log.

So our initial "large initial-props payload" framing is incomplete. The bug reproduces 100% reliably in our production app (Expo SDK 56, RN 0.85.3, Fabric, deep navigation stack with drawer + bottom tabs) but we have not yet found the minimum set of layers needed to reproduce it in isolation. We are filing this anyway because the diagnostic evidence is concrete and reproducible **in our project**, and the underlying iOS WKWebView behavior is well-documented in third-party reports. We are happy to add layers to the minimal repro and re-test if the team can suggest which subsystem is most likely the trigger.

Repo of what we have so far (renders correctly — does NOT reproduce the bug): https://github.com/ayush-rgp/expo-dom-ios-blank-repro

## Summary

In our production app, certain `"use dom"` component mounts blank reliably on iOS while their bundle is delivered by Metro but never executes. The WKWebView content process spawns (we see `[WebKit] WebContent[<PID>] Could not register system wide server: -25204`) but is killed by iOS before the first paint — Metro shows `[BrowserEngineKit] Failed to terminate process: ... No such process found` errors and the `DOM LOG Running application "main"` log never fires.

Versions:
- `expo` 56.0.4
- `@expo/dom-webview` ~56.0.5
- `react-native` 0.85.3, new architecture (Fabric) enabled
- `react` / `react-dom` 19.2.3 (aligned across `dependencies` and `resolutions`)
- `react-native-webview` 13.16.1 (also installed — opting out via `dom={{ useExpoDOMWebView: false }}` does NOT fix the issue)
- iOS 17.5+ Simulator (iPhone 15) and physical device. Same behavior in dev-client and release builds.

## The smoking-gun log pattern

Across hundreds of mount cycles in our production app, the difference between a **working** mount and a **failing** mount is exactly the presence vs. absence of `Running application "main"` after the WebContent process is registered.

**Working mount (small saved session, 2 items):**
```
DOM Bundled NNms components/Dom/ChatSessionDOM.tsx (1 module)
[WebKit] WebContent[<PID>] Could not register system wide server: -25204
[WebKit] WebContent[<PID>] _AXAddToElementCache was called even though the element was in the cache:
DOM LOG Running application "main" with appParams: ...
DOM LOG [ChatSessionDOM] 🏁 Initial Scroll Evaluation: { itemsCount: 2, ... }
[DOM] [ChatSessionDOM] mount { bodyHeight: 778, itemsCount: 2, ... }
[DOM] [ChatSessionDOM] post-paint { bodyHeight: 778, ... }
```

**Failing mount (saved session with 4 items):**
```
DOM Bundled NNms components/Dom/ChatSessionDOM.tsx (1 module)
[WebKit] WebContent[<PID>] Could not register system wide server: -25204
[WebKit] WebContent[<PID>] _AXAddToElementCache was called even though the element was in the cache:
[BrowserEngineKit] Failed to terminate process: Error Domain=com.apple.extensionKit.errorDomain Code=18 "(null)"
    UserInfo={NSUnderlyingError=... {Error Domain=RBSRequestErrorDomain Code=3 "No such process found"}}
[BrowserEngineKit] Failed to terminate process: ... No such process found
[BrowserEngineKit] Failed to terminate process: ... No such process found
                                                  ← no `Running application`, no DOM-side logs
```

The PID in the WebContent log proves the content process WAS spawned. The BrowserEngineKit "Failed to terminate ... No such process found" errors that immediately follow prove **iOS already killed the process** before the cleanup syscall could find it. The JS bundle ships into a dead WebView.

This pattern is consistent with the WKWebView content-process-backgrounding race documented in third-party reports — see nevermeant.dev's "Handling Blank WKWebViews" writeup and Apple Developer Forums thread 766259. Apple's only documented mitigation is the **private SPI** `_alwaysRunsAtForegroundPriority` on `WKWebViewConfiguration`, which Cordova-Ionic explicitly removed from `cordova-plugin-ionic-webview` (issue #286) over App Store rejection risk.

## Side-by-side: AnalysisDOM (always works) vs ChatSessionDOM (blanks intermittently)

Our app has three `"use dom"` components, all using Expo's default `@expo/dom-webview` backend. Same SDK, same react/RN versions:

| Component | Mount location | `dom` prop | Internal `#root` CSS | Behavior |
|---|---|---|---|---|
| `AnalysisDOM` | Navigation-route root (`<View flex:1>` parent that's laid out via React Navigation push animation) | none | `position: fixed; inset: 0; height: 100%; width: 100%` | **Always renders** even with multi-KB payloads |
| `ChatSessionDOM` | Tab-nested screen (`HomeChatScreen` inside drawer + bottom tabs) | none | `html, body { height: 100% }`, `#chat-container { min-height: 100% }` | **Blanks on cold-launch / session-switch** when (some combination of payload + concurrent work) is large enough |
| `ChatMarkdownDOM` | Inside a Modal's ScrollView | none | content-driven sizing via `onHeightChange` postMessage | **Blanks on cached/saved analyses** with non-trivial markdown |

The most suspicious differences between the working and failing components:
- **Mount-time host hierarchy depth.** AnalysisDOM is the root content of a route — by the time WKWebView attaches, React Navigation's push animation has already given the parent View a full layout pass. ChatSessionDOM mounts inside a tab inside a drawer inside several providers; the parent View is freshly created in the same React commit as the WebView.
- **Concurrent main-thread work during cold-launch.** When HomeChatScreen mounts, the app simultaneously fires `getProfile`, `listUserSessions`, `getSessionWithMessages`, `fetchSessionHighlights`, `getSuggestionsForMessage`, `loadModels`, `loadWebSearchModels`, Clerk auth refresh, Rollbar init, speech service init, link-preview prefetches. AnalysisDOM mounts as a navigation push later in the lifecycle when the main thread is calmer.

We have **not** verified which of these (or another factor entirely) is the trigger. We could not isolate it in a fresh `create-expo-app` minimal scaffold despite trying with 30-item × 50-paragraph payloads (~30 KB serialized) — it rendered fine.

## What we tried in production that did NOT fix the blank

1. **Remove `matchContents: true`** from `dom`. The body-size observer race is a separate (real) issue but not what causes the blank.
2. **Opt out to `react-native-webview`** via `dom={{ useExpoDOMWebView: false }}`. The race exists in RN-WebView's iOS path too — same backgrounding behavior.
3. **Keep the parent View persistent** across skeleton ↔ WebView transitions so the WebView attaches into an already-laid-out parent.
4. **Defer the WebView mount via double-RAF** in a `useEffect`.
5. **Bootstrap mount with `items=[]` then swap to real items 250 ms later** via state-driven prop substitution. The `$$props` postMessage update did not propagate to the DOM-side React tree in our app — mechanism unverified. (Even small sessions broke under this approach.)

## What partially helps in production

1. **App-root invisible "warmup" DOM component.** A 1×1 px `"use dom"` component mounted at the top of `App.tsx`, kept alive for the whole app lifetime, with `position: absolute; opacity: 0.01`. Keeps the WKWebView pool warm, reduces (but does not eliminate) BrowserEngineKit errors on subsequent mounts.
2. **Wake-tick pulse on the WebView's props.** Parent bumps a dummy prop 5x at 80/160/320/640/1000 ms after WebView mount. Each bump forces the wrapper to emit `$$props` via postMessage. For small payloads this kicks WKWebView into executing the bundle (the content process is still alive). For large payloads the content process is already dead before 80 ms, so the wake-ticks land on nothing.

The combination of (1) + (2) makes sessions with ≤2 short items render reliably in our production app. It does NOT fix the larger-payload / larger-component-tree case. Neither addresses the underlying race.

## Suspected root cause

iOS WKWebView's content process is briefly backgrounded between WebView attach and first paint when:

- The parent view hierarchy is deep (tab/drawer-nested screens, not root navigation routes), AND
- The main thread is busy with concurrent work at the moment of mount (multiple API calls, multiple state updates, deferred effects).

iOS aggressively kills the backgrounded process during this window. The WKWebView surface stays alive but blank — no delegate callback fires because from WKWebView's perspective the navigation succeeded; only the content process is gone.

The Apple-side workaround is `_alwaysRunsAtForegroundPriority` (private SPI on `WKWebViewConfiguration`), which is App-Store-rejection risk.

## Possible Expo-level fixes (suggested)

Options that wouldn't require shipping a private API in app builds:

1. **Lazy-mount the WKWebView** via `setTimeout(0)` or RAF after the parent View has had at least one full layout pass, instead of synchronously in the same commit. Reduces the chance of the WebView being attached to an in-progress layout that iOS treats as backgrounded.
2. **Send `initialProps` via `$$props` postMessage immediately after mount** instead of via `injectedJavaScriptObject` / `$$EXPO_INITIAL_PROPS`. This keeps the WebView's first load tiny (host page + zero props) and lets the heavy payload arrive after the content process is confirmed alive.
3. **Watchdog reload.** The wrapper already calls `webviewRef.current?.reload()` in `onContentProcessDidTerminate` (`node_modules/expo/src/dom/webview-wrapper.tsx:129`), but that delegate doesn't fire when iOS kills the process before it fully attached. A timer-based fallback that calls `reload()` if no message has arrived from the WebView within ~1500 ms of mount would catch this case.
4. **Expose `_alwaysRunsAtForegroundPriority` behind a documented opt-in flag**, scoped to native dev builds only (so production builds can revert to the default), or document the App-Store-rejection risk so apps can make an informed choice.
5. **Expose a documented mechanism for keeping the WKWebView pool warm at app start**, so apps don't have to manually mount an invisible warmup WebView at App root.

## What we can do to help further

- Add layers (react-navigation drawer, tabs, providers, concurrent network calls) to the minimal repro until it blanks, then update the linked repo.
- Share full Metro logs / Xcode device logs from a failing cold-launch in the production app.
- Bisect the production dependency list to identify which library (Clerk, react-native-keyboard-controller, react-native-screens, react-native-reanimated, etc.) makes the difference, if any.

Happy to do any/all of the above if the maintainers can point at which suspicion is most worth investing time in.
