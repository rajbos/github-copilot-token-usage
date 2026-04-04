/**
 * VS Code API compatibility shim for WebView2 (Visual Studio extension).
 *
 * This script is injected as an EmbeddedResource and emitted into every HTML
 * page before any webview bundle script runs.  It provides:
 *
 *   1.  acquireVsCodeApi() — returns a vscode-like object whose postMessage()
 *       forwards to window.chrome.webview.postMessage() so the host receives it.
 *
 *   2.  Relay of host→webview messages arriving on window.chrome.webview as
 *       standard window 'message' events, which is what the existing bundle
 *       listeners (window.addEventListener('message', …)) already expect.
 *
 * The shim must be idempotent (safe to run more than once without side-effects).
 */
(function (global) {
    'use strict';

    if (global._vsCodeApiAcquired) { return; }
    global._vsCodeApiAcquired = true;

    var _state    = {};
    var _vsApi    = null;

    // ── acquireVsCodeApi ──────────────────────────────────────────────────────

    global.acquireVsCodeApi = function acquireVsCodeApi() {
        if (_vsApi) { return _vsApi; }

        _vsApi = {
            /**
             * Posts a message to the .NET host.
             * Pass the value directly — WebView2 serialises objects to JSON so the
             * host receives a proper JSON object via WebMessageAsJson.
             * Pre-stringifying would cause double-encoding (the host would see a
             * JSON string instead of a JSON object and postMessage routing would fail).
             */
            postMessage: function (msg) {
                if (global.chrome && global.chrome.webview) {
                    global.chrome.webview.postMessage(msg);
                }
            },

            setState: function (newState) {
                _state = newState || {};
            },

            getState: function () {
                return _state;
            },
        };

        return _vsApi;
    };

    // ── Host → webview message relay ─────────────────────────────────────────

    function setupWebViewRelay() {
        if (!global.chrome || !global.chrome.webview) { return; }

        global.chrome.webview.addEventListener('message', function (event) {
            var data = event.data;

            // WebView2 delivers messages as strings by default.  Parse JSON
            // so listeners receive an object, matching VS Code extension behaviour.
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (_) { /* leave as string */ }
            }

            global.dispatchEvent(new MessageEvent('message', { data: data }));
        });
    }

    // The WebView2 chrome object may not be present during unit testing
    // (e.g. in a plain browser), so guard the relay setup.
    if (global.chrome && global.chrome.webview) {
        setupWebViewRelay();
    } else {
        // Retry once the page finishes loading, in case chrome.webview is
        // not yet available when this script first runs.
        global.addEventListener('load', setupWebViewRelay, { once: true });
    }

}(window));
