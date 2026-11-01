---
"@testivai/witness-webdriverio": minor
---

Hybrid app web views (experimental): new `witness()` option `context` captures in another Appium context for one call and switches back afterwards, also when the capture fails. `context: 'webview'` is the app's web view (the `WEBVIEW_<appPackage>` context on Android, else the first `WEBVIEW_…` context, as iOS numbers them); any other value is an exact context name (`'WEBVIEW_com.example.app'`, `'NATIVE_APP'`). A hybrid app driven in the native context gets its web view captured as a page, with every layer (DOM diff, style check, attribution, shift detection), instead of a native capture; `context: 'NATIVE_APP'` from a web view is a native capture. A session with no web view, or without the name asked for, fails with the contexts it has and what the app's build needs (WebView debugging enabled). `WitnessBrowser` gains the optional `getContexts()` and `switchContext()`.
