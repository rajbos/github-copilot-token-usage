// Root ESLint config so the shared sources in <repo>/src are linted with the
// same rules as the VS Code extension (which owns the ESLint dependencies).
// ESLint resolves the config for each linted file by walking up from that file,
// so files under src/ find this config while vscode-extension/** keeps using
// vscode-extension/eslint.config.mjs.
import base from './vscode-extension/eslint.config.mjs';

export default [
    ...base,
    // src/test holds unit tests (compiled and run via vscode-extension's test scripts); like
    // vscode-extension/test/**, they are not part of the lint scope.
    { ignores: ["src/test/**"] },
    {
        // Shared-source boundary (docs/adr/SHARED-SRC-API-BOUNDARY.md): src/ is consumed by the
        // VS Code extension, the CLI and the desktop app, so it must stay editor-neutral and must
        // not depend on any of its consumers. Editor-host services (extension lookup, settings,
        // app name, ...) are injected through `deps` objects instead — see SessionDiscoveryDeps
        // and WindsurfHost, with the VS Code implementations in
        // vscode-extension/src/srcHostAdapters.ts.
        files: ["src/**/*.ts"],
        rules: {
            "no-restricted-imports": ["error", {
                paths: [{
                    name: "vscode",
                    message: "The shared src/ must not import 'vscode'. Take the host service as an injected dependency (see SessionDiscoveryDeps / WindsurfHost) and implement it in vscode-extension/src/srcHostAdapters.ts.",
                }],
                patterns: [{
                    group: ["**/vscode-extension/**", "**/cli/**", "**/desktop/**"],
                    message: "The shared src/ must not import from its consumers (vscode-extension/, cli/, desktop/). Move the code it needs into src/ instead.",
                }],
            }],
        },
    },
];
