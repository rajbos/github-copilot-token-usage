---
applyTo: "visualstudio-extension/**"
---

# Visual Studio Extension — Architecture & Development Guide

The `visualstudio-extension/` folder contains a C# Visual Studio extension (`.vsix`) that replicates the core views of the VS Code extension for users of Visual Studio IDE.

## Planned Approach (Option C — WebView2 + existing webviews)

The extension hosts a **WebView2** control inside a Visual Studio Tool Window (C# `AsyncPackage`). The existing compiled webview bundles from `vscode-extension/dist/webview/` run inside WebView2 — avoiding a full UI rewrite. A thin C# bridge handles file I/O and passes JSON to the webview via `PostWebMessageAsJson`.

### Key design decisions

- **Data layer**: The `VisualStudioDataAccess` class in `vscode-extension/src/visualstudio.ts` already handles all session discovery and parsing for Visual Studio Copilot Chat binary session files (MessagePack format). The C# host reads session metadata and delegates token estimation to this layer by shelling out to the CLI, or by re-implementing only the discovery logic in C#.
- **UI**: WebView2 renders the existing `details`, `chart`, `usage`, and `diagnostics` webview bundles. The VS Code CSS theme tokens (`--vscode-*`) will need a compatibility shim mapping to Visual Studio theme tokens.
- **No cloud storage**: Azure Storage integration is out of scope for the initial version.

## Developer Workflow

```bash
# Prerequisites: Visual Studio 2022, .NET SDK, VSIX workload
cd visualstudio-extension
dotnet build --configuration Release
```

Or from the repo root:
```powershell
./build.ps1 -Project visualstudio
```

## Session File Discovery

Visual Studio Copilot Chat stores sessions as MessagePack-encoded binary files:
```
<project>\.vs\<solution>.<ext>\copilot-chat\<hash>\sessions\<uuid>
```

Discovery is already implemented — see `vscode-extension/src/visualstudio.ts` for `VisualStudioDataAccess.discoverSessions()`.
