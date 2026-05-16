import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import sonarjs from "eslint-plugin-sonarjs";

export default [{
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
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",

        // Complexity rules — violations are warnings (informational, do not break the build)
        "complexity": ["warn", 15],
        "sonarjs/cognitive-complexity": ["warn", 15],
        "max-depth": ["warn", 5],
        "max-lines-per-function": ["warn", 80],
    },
}];