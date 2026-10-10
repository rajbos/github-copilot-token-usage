import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import sonarjs from "eslint-plugin-sonarjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(extRoot, "..");

// Warning ratchet (see scripts/check-lint-baseline.mjs): files that still carry
// no-explicit-any warnings. Every other file gets the rule at `error`, so new files cannot
// introduce `any`. The list only shrinks: `npm run lint:baseline:update` after cleaning a file.
const baselinePath = path.join(extRoot, "lint-baseline.json");
const baselineRules = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")).rules ?? {} : {};
// Baseline paths are repo-root relative. Files under this directory match relative to it; the
// shared ../src files fall outside ESLint's base path and can only be matched with a `**/`
// glob. That glob can also match a same-named file in vscode-extension/src, which at worst gets
// `warn` instead of `error` for `any` — it is still held by the lint-baseline.json ratchet.
const toPattern = (repoRel) => repoRel.startsWith("vscode-extension/")
    ? repoRel.slice("vscode-extension/".length)
    : "**/" + repoRel;
const legacyAnyFiles = Object.keys(baselineRules["@typescript-eslint/no-explicit-any"] ?? {}).map(toPattern);

// Files currently over the max-lines ceiling, pinned at their present size so no second
// file can cross 6000. Shrink these numbers as the files are decomposed; never raise them.
const MAX_LINES = 6000;
const oversizedFiles = { "vscode-extension/src/extension.ts": 11184 };

export default [
  ...typescriptEslint.configs["flat/recommended"].map(c => ({ ...c, files: ["**/*.ts"] })),
  {
    files: ["**/*.ts"],

    plugins: {
        "@typescript-eslint": typescriptEslint,
        sonarjs,
    },

    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        // Recommended rules that still have legacy violations stay at warn and are held by the
        // lint-baseline.json ratchet; the rest of the recommended set is already error.
        "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
        "@typescript-eslint/no-require-imports": "warn",
        "@typescript-eslint/triple-slash-reference": "warn",
        "@typescript-eslint/no-unsafe-function-type": "warn",
        "@typescript-eslint/ban-ts-comment": "warn",
        "@typescript-eslint/no-explicit-any": "error",

        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",

        // Webview XSS hardening: session-log data (titles, tool names, model names, file paths)
        // is untrusted — it can be shaped by a malicious repo or a prompt-injected agent — so
        // direct HTML-sink writes are banned everywhere except through the sanctioned
        // `setHtml()` wrapper in src/webview/shared/domUtils.ts, which carries an inline
        // eslint-disable documenting the trust contract callers must uphold.
        "no-restricted-syntax": ["error",
            {
                selector: "AssignmentExpression[left.property.name='innerHTML']",
                message: "Direct innerHTML assignment is banned. Untrusted session-log data flows into these webviews — build the HTML with escapeHtml()/escapeAttr() and write it via setHtml(el, html) from src/webview/shared/domUtils.ts instead.",
            },
            {
                selector: "AssignmentExpression[left.property.name='outerHTML']",
                message: "Direct outerHTML assignment is banned. Use setHtml(el, html) from src/webview/shared/domUtils.ts instead.",
            },
            {
                selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
                message: "insertAdjacentHTML() is banned. Use setHtml(el, html) from src/webview/shared/domUtils.ts instead.",
            },
            {
                selector: "CallExpression[callee.object.name='document'][callee.property.name='write']",
                message: "document.write() is banned in webview code.",
            },
        ],

        // Complexity rules — violations are warnings (informational, do not break the build)
        "complexity": ["warn", 15],
        "sonarjs/cognitive-complexity": ["warn", 15],
        "max-depth": ["warn", 5],
        "max-lines-per-function": ["warn", 80],

        // File-size ceiling. The per-function rules above are satisfied almost everywhere
        // (extension.ts's methods individually pass max-lines-per-function), yet the file itself
        // became enormous — proof that "every function is small" doesn't stop a file from
        // becoming unmanageable. extension.ts is by far the largest file; the threshold isn't a
        // target size. Run `pnpm run lint` for the current offenders. As extension.ts is decomposed
        // (docs/adr/EXTENSION-TS-DECOMPOSITION.md) and other files are split, ratchet this
        // number down rather than raising it to accommodate growth.
        "max-lines": ["error", { max: MAX_LINES, skipBlankLines: true, skipComments: true }],
    },
},
...(legacyAnyFiles.length ? [{
    // Legacy files that still contain explicit `any`: warn only (counts held by the baseline).
    files: legacyAnyFiles,
    rules: { "@typescript-eslint/no-explicit-any": "warn" },
}] : []),
{
    // cli/ has no baseline of its own yet (its lint wiring is tracked separately); keep `any`
    // a warning there so `cd cli && npm run lint` does not start failing.
    files: ["**/cli/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "warn" },
},
...Object.entries(oversizedFiles).map(([file, max]) => ({
    files: [toPattern(file)],
    rules: { "max-lines": ["error", { max, skipBlankLines: true, skipComments: true }] },
})),
{
    files: ["**/*.test.ts", "**/test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
}];
