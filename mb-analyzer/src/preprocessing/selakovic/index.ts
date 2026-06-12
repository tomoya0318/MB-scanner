/**
 * Selakovic 前処理器 (ADR-0011 Tier 2) の public API。
 *
 * - `preprocess` / `SelakovicPreprocessInput` — issue のファイル内容を `(setup, before, after)` candidate に
 *   変換する本体 (`pipeline.ts`、純関数)
 * - `detectLayout` / `loadLibPair` / `extractInlineScripts` — CLI が issue ディレクトリを読んで
 *   `SelakovicPreprocessInput` を組むのに使う (`io/` は唯一の FS I/O 層、`extractInlineScripts` は pure)
 *
 * 内部構成 (`io/` → `decompose/` → `route/` → `assemble/` → `pipeline.ts`) は外に出さない。
 */
export { preprocess } from "./pipeline";
export type { SelakovicPreprocessInput } from "./pipeline";
export { detectLayout } from "./io/layout";
export type { DetectedLayout } from "./io/layout";
export { loadLibPair } from "./io/lib-pair";
export type { LibPair } from "./io/lib-pair";
export { resolveScriptDepSources } from "./io/script-deps";
export type { ResolvedScriptDeps } from "./io/script-deps";
export { extractInlineScripts } from "./decompose/inline-script";
