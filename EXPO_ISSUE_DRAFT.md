# `"use dom"` component blanks on iOS WKWebView when initial-props payload is non-trivial — content process dies before bundle executes (SDK 56)

## Summary

On Expo SDK 56 + RN 0.85.3 (Fabric / new arch), `"use dom"` components reliably blank on iOS when the initial-props payload passed to the component is non-trivial (a few KB serialized). The WKWebView content process is spawned but iOS kills it before the JS bundle reaches its first `Running application "main"` log. Smaller initial-props payloads work; larger ones blank. The failing path emits `[BrowserEngineKit] Failed to terminate process: ... No such process found` errors immediately after `DOM Bundled`, which is consistent with the known WKWebView content-process backgrounding race documented in third-party reports (see nevermeant.dev "Handling Blank WKWebViews" and Apple Developer Forums thread 766259).

## Versions

- `expo` 56.0.0
- `@expo/dom-webview` ~56.0.5
- `react-native` 0.85.3
- `react` / `react-dom` 19.2.3 (aligned in both `dependencies` and `resolutions`)
- `react-native-webview` 13.16.1 (also installed — opting out via `dom={{ useExpoDOMWebView: false }}` does NOT fix the issue; same race exists in `react-native-webview`'s iOS path)
- New architecture: enabled (Fabric)
- iOS 17.5+ Simulator and physical device

## Repro

1. Create a `"use dom"` component (any component, but heavier ones are worse). In our case the props payload includes ~2-4 chat messages with markdown content (~3-10 KB JSON when serialized).
2. Mount the component inside a screen that uses a tab/drawer navigator (not as a direct navigation route).
3. Cold-launch the app and let it restore directly into the screen.
4. The WebView mounts but stays blank. `Running application "main"` (the standard react-native-dom bootstrap log) **never fires**.
5. Metro logs show:
   ```
   DOM Bundled NNms components/Dom/<YourComponent>.tsx (1 module)
   [WebKit] WebContent[<PID>] Could not register system wide server: -25204
   [BrowserEngineKit] Failed to terminate process: Error Domain=com.apple.extensionKit.errorDomain Code=18 "(null)"
     UserInfo={NSUnderlyingError=... {Error Domain=RBSRequestErrorDomain Code=3 "No such process found"}}
   [BrowserEngineKit] Failed to terminate process: ... No such process found
   [BrowserEngineKit] Failed to terminate process: ... No such process found
                                              ← `Running application "main"` never appears
   ```
6. Same component mounted on the same screen but with a smaller props payload (1 short item) renders correctly. Same component mounted as a navigation-route root (not a tab-nested screen) renders correctly even with the larger payload.

## Side-by-side diagnosis from our debugging

We have three `"use dom"` components in the project. All use Expo's default `@expo/dom-webview`. Behavior under SDK 56:

| Component | Mount location | `dom` prop | Internal `#root` CSS | Behavior |
|---|---|---|---|---|
| `AnalysisDOM` | Navigation-route root (`<View flex:1>` parent that's laid out via React Navigation push) | none | `position: fixed; inset: 0; height: 100%; width: 100%` | **Always renders** even with large payloads |
| `ChatSessionDOM` | Tab-nested screen (`HomeChatScreen` inside a drawer + tabs) | none (was `{ scrollEnabled, onRenderProcessGone, onContentProcessDidTerminate }`; removed didn't help) | `html, body { height: 100% }`, `#chat-container { min-height: 100% }` | **Blanks on cold-launch / session-switch when payload > ~2 small items** |
| `ChatMarkdownDOM` | Inside a Modal's ScrollView | none | content-driven sizing via `onHeightChange` postMessage | **Blanks on cached/saved analyses with non-trivial markdown** |

The differentiator is **not** the `dom` prop, the CSS, or the wrapper choice. It IS the size of the initial-props payload and the mount-time host hierarchy depth.

## Things we tried that did NOT fix the issue

1. **Opt out to `react-native-webview`** via `dom={{ useExpoDOMWebView: false }}`. The race exists in RN-WebView's iOS path too.
2. **Remove `matchContents: true`** from `dom`. The body-size observer race is a separate (real) issue but not what causes the blank.
3. **Keep the parent View persistent** across skeleton ↔ WebView transitions (so the WebView attaches to an already-laid-out parent). Didn't help.
4. **Defer the WebView mount via double-RAF** (`useEffect(() => { setMountKey(null); rAF1(() => rAF2(() => setMountKey(key))) }, ...)`). Didn't help.
5. **Bootstrap with `items=[]` then swap to real items 250ms later** via a state-driven prop substitution. The `$$props` postMessage update did not propagate to the DOM-side React tree — mechanism unverified. Even small sessions broke under this approach.

## Things that DID help (partial mitigations)

1. **App-root invisible "warmup" DOM component.** A 1×1 px `"use dom"` component mounted at the very top of the React tree, kept alive for the whole app lifetime, with `position: absolute; opacity: 0.01`. This keeps the WKWebView pool warm and reduces (but does not eliminate) the BrowserEngineKit errors.
2. **Wake-tick pulse on props.** Parent bumps a dummy `__wakeTick` prop 5 times at 80/160/320/640/1000ms after WebView mount. Each bump forces the wrapper to emit `$$props` via postMessage. This makes WKWebView pick up the bundle for small payloads (because the content process is still alive). For large payloads the content process is already dead before 80ms, so this doesn't help.

The combination of (1) + (2) is enough to make sessions with ≤2 short items render reliably. It does NOT fix the larger-payload case.

## Suspected root cause

iOS WKWebView's content process is briefly backgrounded between WebView attach and first paint when:
- The parent view hierarchy is deep (multiple navigation containers stacked).
- The initial-props payload (delivered via `WKWebViewConfiguration.injectedJavaScriptObject` / `window.$$EXPO_INITIAL_PROPS`) is non-trivial and takes more than a few hundred ms to serialize/deserialize.

iOS aggressively kills the backgrounded process. The bundle never gets to execute. The WKWebView surface stays alive but blank — no delegate callback fires because from WKWebView's perspective the navigation succeeded; only the content process is gone.

The Apple-side workaround is `_alwaysRunsAtForegroundPriority` (private API on `WKWebViewConfiguration`), which is App-Store-rejection risk and was explicitly removed from Cordova-Ionic-WebView for that reason (issue #286 on `cordova-plugin-ionic-webview`).

## What an Expo-level fix could look like

Options that wouldn't require a private API in app builds:

1. **Lazy-mount the WebView.** Mount the WKWebView via `setTimeout(0)` or `requestAnimationFrame` chain after the parent View has had at least one full layout pass, instead of synchronously in the same commit. The existing wrapper already does some of this but the race window is still small enough to lose on iOS.
2. **Send initialProps via `$$props` postMessage immediately after mount** instead of injecting them via `injectedJavaScriptObject`. This would split the payload across the initial WebView load (zero props) and a subsequent message (full props), keeping the first-load bridge work small.
3. **Watch for "WebView mounted but bundle never executed" via the existing `onContentProcessDidTerminate` delegate**, and force a reload after a timeout. The wrapper already calls `webviewRef.current?.reload()` in `onContentProcessDidTerminate` (`webview-wrapper.tsx:129`) but the delegate doesn't fire when iOS kills the process before it ever fully attached. A timer-based fallback would help.
4. **Expose a documented mechanism for keeping the WKWebView pool warm at app start** (so apps don't have to manually mount an invisible warmup WebView).

## Reproduction project / further diagnostics

I'm happy to set up a minimal reproduction project on request. The full Metro logs (with `[HomeChat:gate]` state-transition logs, `DOM Bundled` / `Running application` events, and `[BrowserEngineKit]` errors) are available from our internal debugging session — I can attach them or transcribe relevant excerpts.

The most informative single log artifact: the difference in WebKit logs between a working mount and a failing mount is exactly the presence vs. absence of `Running application "main"` after the WebContent process is registered. Working:
```
DOM Bundled NNms components/Dom/<X>.tsx (1 module)
[WebKit] WebContent[<PID>] Could not register system wide server: -25204
DOM LOG Running application "main" with appParams: ...   ← here
... DOM-side logs continue ...
```

Failing:
```
DOM Bundled NNms components/Dom/<X>.tsx (1 module)
[WebKit] WebContent[<PID>] Could not register system wide server: -25204
[BrowserEngineKit] Failed to terminate process: ... No such process found
[BrowserEngineKit] Failed to terminate process: ... No such process found
                                              ← no Running application, no DOM-side logs
```

The PID in the WebContent log proves the content process WAS spawned. The BrowserEngineKit "Failed to terminate ... No such process found" errors that immediately follow prove iOS already killed it before it could be cleaned up normally. The JS bundle never executes.
