import { createRequire } from "node:module";
import astroPlugin from "eslint-plugin-astro";

const require = createRequire(import.meta.url);
const globals = require("globals");
const js = require("@eslint/js");
const prettierConfig = require("eslint-config-prettier");
const tsParser = require("@typescript-eslint/parser");
const reactPlugin = require("eslint-plugin-react");

export default [
  // Global ignores — bloc dédié, sans autre clé
  {
    ignores: [
      "node_modules/**",
      "interface/node_modules/**",
      "interface/dist/**",
      "interface/.astro/**",
      "data/**"
    ]
  },
  // Scripts de collecte : Node.js CommonJS
  {
    files: ["scripts/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.es2021
      }
    },
    rules: {
      "no-unused-vars": "error",
      "no-console": "off"
    }
  },
  // Interface : ESM navigateur (JS/MJS/JSX) + config ESLint elle-même
  {
    files: ["interface/src/**/*.{js,mjs,jsx}", "interface/*.mjs", "interface/*.js", "eslint.config.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true }
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.node
      }
    },
    rules: {
      "no-unused-vars": "error",
      "no-console": "off"
    }
  },
  // JSX : le cœur ESLint ne suit pas les usages JSX,
  // `jsx-uses-vars` évite les faux positifs (sans lui, AreaChart etc.
  // seraient signalés alors qu'utilisés dans le template)
  {
    files: ["interface/src/**/*.jsx"],
    plugins: { react: reactPlugin },
    rules: {
      "react/jsx-uses-vars": "error"
    }
  },
  // Fichiers Astro (frontmatter + template)
  ...astroPlugin.configs["flat/recommended"],
  {
    files: ["interface/src/**/*.astro"],
    rules: {
      "no-console": "off"
    }
  },
  // Frontmatter TypeScript (ex: `interface Props` dans Layout.astro)
  {
    files: ["**/*.astro/*.ts", "*.astro/*.ts"],
    languageOptions: {
      parser: tsParser
    },
    rules: {
      "no-console": "off"
    }
  },
  prettierConfig
];
