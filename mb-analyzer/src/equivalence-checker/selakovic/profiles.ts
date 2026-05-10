/**
 * Selakovic dataset 固有の正規化「値」— `common/` の各 primitive に `opts`/config として渡す。
 * 値の根拠は計測ハーネス知識 / 使用 framework 知識 (`tmp/oracle-mapping.md` §5.4 / §8)。暫定値が多く、
 * 2b.4 の 97 件再走で詰める (詰めるたびにここを更新 → 再走 → crosscheck)。
 *
 * `common/` のソースには framework/dataset 固有の string literal を置かない (ESLint zone + grep)。
 * それらは全部このファイルと `wrap-targets.ts` にだけ現れる。
 */
import type {
  DomNormalizeProfile,
  ExternalObservationProfile,
  InteractionTraceProfile,
} from "../common/comparison/oracles";
import type { IterationCapOptions } from "../common/sandbox";

/**
 * C2 の DOM 正規化プロファイル。AngularJS 1.x / React 0.x が DOM に動的に付与するノイズを除去する。
 * root = `<body>` (デフォルト)。`tmp/oracle-mapping.md` §5.4 の DOM patch issue (Angular/9369, React/808, React/934, …)
 * を 2b.4 で見て詰める。
 */
export const DOM_NORMALIZE_PROFILE: DomNormalizeProfile = {
  ignoreAttributes: [
    // AngularJS 1.x が compile/link 時に付ける属性
    "ng-version",
    "ng-app",
    "ng-controller",
    "ng-scope",
    "ng-binding",
    "ng-isolate-scope",
    "ng-cloak",
    // React 0.x の要素同定属性
    "data-reactid",
    "data-reactroot",
  ],
  ignoreClassTokens: ["ng-scope", "ng-binding", "ng-isolate-scope", "ng-pristine", "ng-untouched", "ng-valid"],
  ignoreCommentNodes: true, // <!-- ngRepeat: ... -->, <!-- ngIf: ... -->, <!-- ngView -->, <!-- react-text: N -->, <!-- /react-text -->
  collapseWhitespace: true,
  sortAttributes: true,
};

/**
 * O4 (external-observation): `new_globals` から除外する framework 内部 global のパターン。
 * `/^ng/` は AngularJS が立てる `ngContext` 等 (angular-7759_4 の偽 not_equal 解消)。
 */
export const EXTERNAL_OBSERVATION_PROFILE: ExternalObservationProfile = {
  ignoreNewGlobalPatterns: [/^ng/],
};

/**
 * C6 (interaction-trace): trace から除外する path prefix。framework の bootstrap-phase 自己呼び出し
 * (`angular.module(...)` / `angular.injector(...)` / `React.render(...)` 等) を比較対象に乗せない。
 * 記録 Proxy で包む対象を「workload が叩く境界」に限れば本来ノイズは乗らないが、保険として持つ。
 */
export const INTERACTION_TRACE_PROFILE: InteractionTraceProfile = {
  ignorePathPrefixes: [],
};

/** serializer の `skipKeyPrefixes` — AngularJS の `$$hashKey` 等の内部プロパティを正規化で無視する。 */
export const SERIALIZER_SKIP_KEY_PREFIXES: readonly string[] = ["$$"];

/**
 * iteration-cap (ADR-0017): 計測ハーネスは preprocess が除去済 (`f1` は 1 回しか走らない) なので、
 * ここで縮めるのは `f1` body / lib 内部に残る大きいリテラル境界ループの保険。`threshold` 以上の
 * リテラル上限を `cap` に clamp する。`cap=null` で無効。— 2b.4 で実物を見て調整。
 */
export const ITERATION_CAP: IterationCapOptions = { threshold: 10_000, cap: 5 };

/**
 * jsdom 環境の重い候補 (AngularJS 665KB-2MB の load+bootstrap を含む) 用に推奨する timeout (ms)。
 * 呼び出し側が `timeout_ms` を明示していればそちらを尊重する (バッチ API は必須なので通常そちら)。
 */
export const HEAVY_JSDOM_TIMEOUT_MS = 20_000;
