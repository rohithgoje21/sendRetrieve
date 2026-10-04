const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    { ignores: ["node_modules", "uploads"] },
    js.configs.recommended,
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: "commonjs",
            globals: globals.node,
        },
        rules: {
            "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
            "no-empty": ["error", { allowEmptyCatch: true }],
            eqeqeq: ["error", "smart"],
            "prefer-const": "error",
        },
    },
    {
        files: ["test/**/*.js"],
        languageOptions: { globals: { ...globals.node, ...globals.jest } },
    },
];
