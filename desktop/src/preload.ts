import { contextBridge, ipcRenderer } from 'electron';
import { createPersistedViewState } from '../../src/webview/shared/persistedViewState';

// Expose a VS Code-compatible API shim so the existing IIFE webview bundles
// (compiled with `external: ['vscode']`) can call acquireVsCodeApi() as a global.
// postMessage routes to the Electron main process via IPC.
//
// getState/setState are persisted in localStorage, keyed per panel (app://panel/<id>), so UI
// choices such as the Chart view's collapsed "By Editor" section survive re-opening the panel
// and restarting the app, like they do in VS Code.
contextBridge.exposeInMainWorld('acquireVsCodeApi', () => {
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch { /* storage unavailable: state just won't persist */ }
    const state = createPersistedViewState<unknown>(storage, `webview-state:${window.location.pathname}`);
    return {
        postMessage: (message: unknown) => {
            ipcRenderer.send('webview-message', message);
        },
        setState: state.setState,
        getState: state.getState,
    };
});

// Bridge main-process loading progress to the page as window messages, matching
// how VS Code webviews receive webview.postMessage — so the shared loading
// screen script (vscode-extension/src/loadingHtml.ts) runs unchanged here.
ipcRenderer.on('loading-message', (_event, message: unknown) => {
    window.postMessage(message, '*');
});
