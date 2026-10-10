# AI Engineering Fluency canvas — Copilot plugin

This folder is the root of the `ai-fluency-canvas` Copilot plugin: a
[GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app) canvas that shows your AI Engineering
Fluency stats (token usage, cost, sessions, charts, fluency score) from local session logs.

📖 **Install and usage docs for users: [docs/copilot-app/README.md](../docs/copilot-app/README.md)**

## Layout

```
copilot-app/                                  <- plugin root (marketplace "source": "./copilot-app")
├── plugin.json                               <- Agent Plugins 1.0 manifest (closed schema)
├── skills/ai-fluency/SKILL.md                <- tells the agent when/how to open the canvas
├── com.github.copilot/extensions/ai-fluency/ <- the canvas extension (canvasId "ai-fluency")
│   ├── extension.mjs                         <- entry point: hands the Copilot SDK to canvas.mjs
│   ├── canvas.mjs                            <- registers the canvas and its agent actions
│   ├── cli.mjs  refresher.mjs  store.mjs  server.mjs  panels.mjs
│   ├── assets/                               <- UI served on 127.0.0.1 (index.html, app.js, style.css)
│   ├── copilot-extension.json                <- only for the app's manual "Install extension" flow
│   ├── test/                                 <- canvas unit tests (synthetic fixtures)
│   └── README.md                             <- how the canvas works
└── test/manifest.test.mjs                    <- plugin.json / marketplace.json / no-personal-data checks
```

The marketplace catalog lives at [`.github/plugin/marketplace.json`](../.github/plugin/marketplace.json)
(marketplace name `ai-engineering-fluency`).

The extension folder keeps the name `ai-fluency` so the `canvasId` and the snapshot location
(`$COPILOT_HOME/extensions/ai-fluency/artifacts/`) stay the same whether the canvas is installed
as a plugin or copied by hand. Snapshots are **never** written inside this folder; `.gitignore`
and `test/manifest.test.mjs` both guard against committing an `artifacts/` directory,
`snapshot.json` or `refresh.lock*` files.

## Tests

No dependencies — plain `node --test` (Node.js 22+). From the repository root:

```bash
node --test "copilot-app/**/*.test.mjs"
```

CI runs the same command in [`.github/workflows/copilot-app.yml`](../.github/workflows/copilot-app.yml).

## Versioning and releasing

1. Bump `version` in **both** `copilot-app/plugin.json` and the `ai-fluency-canvas` entry in
   `.github/plugin/marketplace.json` (semver). `test/manifest.test.mjs` fails if they differ.
2. Merge to `main`. The marketplace is read straight from the repository, so there is no
   separate publish step.
3. Users pick up the new version with `copilot plugin marketplace update` followed by
   `copilot plugin update ai-fluency-canvas` (or the **Update** action in the app).

## Trying a branch before it is merged

Use a fresh, isolated config directory so nothing is installed into your real `~/.copilot`. The
`finally` block restores your previous `COPILOT_HOME` and deletes only the folder this run created:

```powershell
$testHome = Join-Path ([IO.Path]::GetTempPath()) "copilot-plugin-test-$([guid]::NewGuid())"
$previousHome = $env:COPILOT_HOME
try {
    $env:COPILOT_HOME = $testHome
    copilot plugin marketplace add rajbos/ai-engineering-fluency#<branch>
    copilot plugin install ai-fluency-canvas@ai-engineering-fluency
    copilot plugin list
} finally {
    $env:COPILOT_HOME = $previousHome
    Remove-Item -LiteralPath $testHome -Recurse -Force -ErrorAction SilentlyContinue
}
```

To try it in the Copilot app itself, install into your real config instead (after removing any
manually installed copy — see "Migrating" in the user docs).
