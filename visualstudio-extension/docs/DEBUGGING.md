# Copilot Token Tracker — Visual Studio Extension: Debugging Guide

## Prerequisites

| Requirement | Version |
|---|---|
| Visual Studio | 2022 (17.x) with the **"Visual Studio extension development"** workload |
| .NET SDK | 8.x or later (for MSBuild / `dotnet` CLI tools) |
| Node.js | 18+ (to build the VS Code extension webview bundles) |
| Microsoft Edge WebView2 Runtime | Shipped with Windows 11; download from [developer.microsoft.com/en-us/microsoft-edge/webview2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) for Windows 10 |

---

## First-time setup

The Visual Studio extension re-uses the compiled webview bundles from the VS Code extension.
**Build the VS Code extension first**, before opening the `.sln`.

```powershell
# From the repo root
cd vscode-extension
npm ci
npm run compile   # produces vscode-extension/dist/webview/{details,chart,usage,diagnostics}.js
```

Or from the repo root:
```powershell
./build.ps1 -Project vscode   # builds vscode-extension only
```

After a successful build the files `dist/webview/details.js`, `chart.js`, `usage.js`, and
`diagnostics.js` exist under `vscode-extension/`.

---

## Opening the solution

```
visualstudio-extension/CopilotTokenTracker.sln
```

Open this in **Visual Studio 2022**.  The project file contains an MSBuild target
(`CopyWebviewBundles`) that copies the `.js` files from `vscode-extension/dist/webview/`
into the local `webview/` folder before each build.

---

## Running / debugging (F5)

1. Set **CopilotTokenTracker** as the startup project (it already is).
2. Press **F5**.
3. An **Experimental Instance** of Visual Studio launches with the extension installed.
4. In the Experimental Instance: **View → Copilot Token Tracker**.

The tool window opens and the WebView2 dashboard loads automatically.

---

## Inspecting the WebView2 with DevTools

While the Experimental Instance is running, attach the browser DevTools:

1. In the **host** Visual Studio, open **Debug → Windows → Immediate Window** and run:

   ```csharp
   Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync().GetAwaiter().GetResult().BrowserVersionString
   ```

2. Or, in the **Experimental Instance**, navigate to:
   `edge://inspect` in any Edge window, then click **inspect** next to
   `copilot-tracker.local`.

DevTools are enabled by default in Debug builds (`AreDevToolsEnabled = true`).

---

## Refreshing data without restarting

The tool window has a **Refresh** command wired to `vscode.postMessage({ command: 'refresh' })`.
Alternatively, close and re-open the tool window, or call `RefreshAsync()` from the Immediate
Window:

```csharp
((CopilotTokenTracker.ToolWindow.TokenTrackerToolWindow)
    Microsoft.VisualStudio.Shell.Package.GetGlobalService(
        typeof(CopilotTokenTracker.ToolWindow.TokenTrackerToolWindow)))
    .RefreshAsync().Wait();
```

---

## Common issues

### "WebView2 initialisation failed"

- The WebView2 **Evergreen Runtime** is not installed.  Download the standalone
  installer from the link in the Prerequisites table above.
- Check the Output window for details.

### The dashboard shows "Loading…" and stays blank

- The webview JS bundle was not found.  Verify that
  `visualstudio-extension/src/CopilotTokenTracker/webview/details.js` exists.
- Re-run `npm run compile` in `vscode-extension/` and rebuild the C# project.

### "Session data not available" / empty charts

- VS Copilot Chat stores session files under `.vs/{solution}/copilot-chat/`
  and logs their paths to `%LOCALAPPDATA%\Temp\VSGitHubCopilotLogs\*.chat.log`.
- Open a solution in the Experimental Instance and have at least one Copilot
  Chat conversation, then refresh.

### Build error: `The "VSCTCompile" task was not found`

- The **"Visual Studio extension development"** workload is missing from your
  Visual Studio installation.  Open **Visual Studio Installer** and add it.

### Theme colours look wrong

- The extension reads VS environment colours via `VSColorTheme.GetThemedColor()`.
- If you are using a custom theme that overrides the standard colour keys, the
  CSS variables may fall back to the hard-coded dark-theme defaults — this is
  expected behaviour and can be improved as a follow-up.

---

## Building a .vsix package for distribution

```powershell
cd visualstudio-extension/src/CopilotTokenTracker
dotnet build -c Release
```

The `.vsix` file is written to `bin/Release/net472/`.  Install it with:
```powershell
& "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\VSIXInstaller.exe" CopilotTokenTracker.vsix
```
