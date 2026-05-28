# Expo `"use dom"` blank on iOS — minimal reproduction

Reproduction for an iOS-only bug in Expo SDK 56 where a `"use dom"` component
blanks reliably when its initial-props payload is non-trivial. The WKWebView
content process spawns but is killed by iOS before the JS bundle finishes
executing — Metro shows `[BrowserEngineKit] Failed to terminate process: ... No
such process found` errors and no `Running application "main"` log ever
appears.

## Versions

- Expo SDK 56 (template default — `expo ~56.0.6`)
- React 19.2.3, React Native 0.85.3
- Tested on iOS Simulator (iPhone 15, iOS 17.5+) and physical device
- Reproduces in both dev-client and release builds

## Setup

```bash
yarn install          # or npm install
npx expo prebuild
npx expo run:ios
```

## Steps to reproduce the bug

1. Launch the app on iOS (Simulator or device).
2. On the menu screen, tap **"Mount with SMALL payload (1 item) — should render"**.
   - Expected & actual: the DOM component renders one paragraph.
   - The on-screen log panel shows `[DOM] mount` and `[DOM] post-paint` lines.
   - Metro shows `DOM LOG Running application "main"` after `DOM Bundled`.
3. Tap **← back**, then tap **"Mount with LARGE payload (30 items) — blanks on iOS"**.
   - **Expected:** the DOM component renders 30 paragraphs of lorem ipsum.
   - **Actual on iOS:** the DOM area is blank. The on-screen log panel stays empty.
   - Metro shows:
     ```
     DOM Bundled NNms DomComponent.tsx (1 module)
     [WebKit] WebContent[<PID>] Could not register system wide server: -25204
     [BrowserEngineKit] Failed to terminate process: Error Domain=com.apple.extensionKit.errorDomain Code=18 "(null)"
         UserInfo={NSUnderlyingError=... {Error Domain=RBSRequestErrorDomain Code=3 "No such process found"}}
     [BrowserEngineKit] Failed to terminate process: ... No such process found
     [BrowserEngineKit] Failed to terminate process: ... No such process found
     ```
   - **No `DOM LOG Running application "main"` line ever fires.** The bundle is
     delivered to the WKWebView but the content process is killed before it
     can execute.

## Smoking gun

The single most informative difference is in Metro between the working SMALL
mount and the failing LARGE mount:

**SMALL (renders):**
```
DOM Bundled NNms DomComponent.tsx (1 module)
[WebKit] WebContent[<PID>] Could not register system wide server: -25204    ← process spawned
DOM LOG Running application "main" with appParams: ...                       ← bundle executed
[DOM] mount { itemsCount: 1, bodyHeight: 778, ... }
[DOM] post-paint { bodyHeight: 778, bodyRect: 778, ... }
```

**LARGE (blank):**
```
DOM Bundled NNms DomComponent.tsx (1 module)
[WebKit] WebContent[<PID>] Could not register system wide server: -25204    ← process spawned (same)
[BrowserEngineKit] Failed to terminate process: ... No such process found   ← iOS already killed it
[BrowserEngineKit] Failed to terminate process: ... No such process found
[BrowserEngineKit] Failed to terminate process: ... No such process found
                                              ← no Running application, no [DOM] logs
```

The PID in the WebContent log proves the content process WAS created. The
BrowserEngineKit "Failed to terminate ... No such process found" errors
immediately after prove iOS already killed it before the cleanup syscall could
reach it. The JS bundle ships into a dead WebView.

## What this is NOT caused by

Verified in the original (much larger) production codebase from which this
repro was extracted:

- **NOT** `@expo/dom-webview` specific. Opting out via `dom={{ useExpoDOMWebView: false }}` (falling back to `react-native-webview`) reproduces the same blank.
- **NOT** a `matchContents` body-size observer race. Removing `matchContents` doesn't fix it.
- **NOT** a parent-View frame race. Keeping the parent View persistent across skeleton ↔ WebView transitions doesn't fix it.
- **NOT** a `key`/remount timing race. Single RAF, double RAF, and `setTimeout(0)` all behave identically.
- **NOT** an initial-paint sizing issue. `position: fixed; inset: 0` on `#root` doesn't help.

## What partially helps

- **App-root invisible `"use dom"` warmup component** mounted at `App.tsx` top level (1×1 px, `opacity: 0.01`, `position: absolute`). Keeps the WKWebView pool warm, reduces BrowserEngineKit errors on subsequent mounts. Does NOT fix the large-payload case.
- **Wake-tick pulse on the WebView's props.** Bumping any prop value 5 times at 80/160/320/640/1000 ms after mount forces the wrapper to emit `$$props` postMessages. For small payloads this kicks WKWebView into actually executing the bundle. For large payloads the content process is already dead before 80 ms, so the wake-ticks land on nothing.

Neither mitigation addresses the underlying race.

## Suspected root cause

iOS WKWebView's content process is briefly backgrounded between WebView attach
and first paint when:

1. The parent view hierarchy is deep (tab/drawer-nested screens, not root navigation routes), AND
2. The initial-props payload delivered via `WKWebViewConfiguration.injectedJavaScriptObject` (which sets `window.$$EXPO_INITIAL_PROPS` on the DOM side) takes more than a few hundred ms to serialize/deserialize.

iOS aggressively kills the backgrounded process during this window. The
WKWebView surface stays alive but blank — no delegate callback fires because
from WKWebView's perspective the navigation succeeded; only the content
process is gone.

The Apple-side workaround is `_alwaysRunsAtForegroundPriority` (private SPI on
`WKWebViewConfiguration`), which is App-Store-rejection risk and was
explicitly removed from Cordova-Ionic-WebView for that reason (issue #286 on
`cordova-plugin-ionic-webview`).

## Possible Expo-level fixes (not implemented; suggested)

1. **Lazy-mount the WKWebView** via `setTimeout(0)` after the parent View has had at least one full layout pass, so the WebView is never attached to a 0-frame parent.
2. **Send `initialProps` via `$$props` postMessage immediately after mount** instead of via `injectedJavaScriptObject`. This keeps the WebView's first load tiny (just the host page + zero props) and lets the heavy payload arrive after the content process is alive.
3. **Add a "WebView mounted but bundle never executed" watchdog** in the wrapper that calls `webviewRef.current?.reload()` after a timeout. The wrapper already calls `reload()` from `onContentProcessDidTerminate` (see `node_modules/expo/src/dom/webview-wrapper.tsx:129`), but that delegate doesn't fire when iOS kills the process before it ever fully attached.
4. **Expose a documented mechanism for keeping the WKWebView pool warm at app start** so apps don't have to manually mount an invisible warmup WebView.

## Comparison with a working mount

Originally observed in production: an `AnalysisDOM` "use dom" component in the
same project mounts as the **root of a navigation route** (React Navigation
push animation gives the parent View a full layout pass before the WebView
attaches) and **renders reliably even with multi-KB payloads**. Same Expo SDK,
same `@expo/dom-webview`, same React/RN versions.

The differentiator between the working `AnalysisDOM` and the failing
`ChatSessionDOM` (whose props we modeled in this repro):

- Mount-time host hierarchy depth (route root vs. tab-nested)
- Slight differences in initial-props payload size

Both lead back to the same WKWebView content-process backgrounding race.
