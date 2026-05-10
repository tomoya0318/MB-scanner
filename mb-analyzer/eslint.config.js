import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import globals from "globals";

// 機能間の依存方向ルール。
// - contracts/ は Python ↔ TS の JSON 契約 (末端層、誰からも import される、何も import しない)
// - ast/ は Babel AST 操作の汎用ユーティリティ (末端層、機能間で共有)
// - contracts と ast は互いに独立した末端層なので、相互 import も禁止する
// - equivalence-checker/ は pruning/ 等の将来機能を import してはならない
// - preprocessing/ は pipeline 上 equivalence-checker / pruning の前段だが、機能的には
//   独立 (CLI で順次呼び出すだけ)。preprocessing/common は preprocessing/selakovic を
//   import してはならない (ドメイン非依存層、@angular/common 流の命名)
// - equivalence-checker/common も同様: dataset 非依存層なので equivalence-checker/selakovic を
//   import してはならない (preprocessing/common ↔ selakovic と対称)
// - cli/ のみ composition root として全機能を import できる
const DEPENDENCY_ZONES = [
  {
    target: "./src/contracts",
    from: [
      "./src/ast",
      "./src/equivalence-checker",
      "./src/preprocessing",
      "./src/pruning",
      "./src/equivalence-class-test",
      "./src/eslint-rule-codegen",
      "./src/cli",
    ],
  },
  {
    target: "./src/ast",
    from: [
      "./src/contracts",
      "./src/equivalence-checker",
      "./src/preprocessing",
      "./src/pruning",
      "./src/equivalence-class-test",
      "./src/eslint-rule-codegen",
      "./src/cli",
    ],
  },
  {
    target: "./src/preprocessing/common",
    from: [
      "./src/preprocessing/selakovic",
      "./src/equivalence-checker",
      "./src/pruning",
      "./src/equivalence-class-test",
      "./src/eslint-rule-codegen",
      "./src/cli",
    ],
  },
  {
    target: "./src/preprocessing",
    from: [
      "./src/equivalence-checker",
      "./src/pruning",
      "./src/equivalence-class-test",
      "./src/eslint-rule-codegen",
      "./src/cli",
    ],
  },
  {
    target: "./src/equivalence-checker/common",
    from: ["./src/equivalence-checker/selakovic", "./src/preprocessing"],
  },
  {
    target: "./src/equivalence-checker",
    from: ["./src/pruning", "./src/equivalence-class-test", "./src/eslint-rule-codegen", "./src/cli"],
  },
  {
    target: "./src/pruning",
    from: ["./src/equivalence-class-test", "./src/eslint-rule-codegen", "./src/cli"],
  },
  {
    target: "./src/equivalence-class-test",
    from: ["./src/eslint-rule-codegen", "./src/cli"],
  },
  {
    target: "./src/eslint-rule-codegen",
    from: ["./src/cli"],
  },
];

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: "./tsconfig.json",
        },
      },
    },
    rules: {
      "import/no-restricted-paths": ["error", { zones: DEPENDENCY_ZONES }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
  {
    files: ["build.mjs", "eslint.config.js", "vitest.config.ts"],
    languageOptions: {
      parserOptions: {
        projectService: false,
      },
      globals: {
        ...globals.node,
      },
    },
    ...tseslint.configs.disableTypeChecked,
  },
);
