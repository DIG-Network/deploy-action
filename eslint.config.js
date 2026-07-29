import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";

// The strict Lint gate (CLAUDE.md §2.4a) for this Action's OWN plain-ESM JS.
// Scope: src/, test/, and the .github/scripts/ tooling — all real Node ESM.
export default [
  {
    // Ignore generated/vendored trees only; everything else is hand-written JS
    // we want held to the strict bar.
    ignores: ["node_modules/**", "coverage/**", "dist/**"],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.node,
    },
  },
  // Keep prettier LAST so it disables every stylistic rule prettier already owns —
  // the format:check gate is the sole authority on formatting, no rule conflicts here.
  prettier,
];
