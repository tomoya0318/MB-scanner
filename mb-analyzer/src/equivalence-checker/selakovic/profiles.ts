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
  ExceptionProfile,
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
 * O4 (external-observation): `new_globals` から除外するパターン。
 * - `/^ng/` = AngularJS が立てる `ngContext` 等 (angular-7759_4 の偽 not_equal 解消)。
 * - `/^__selakovic/` = runnable scaffolding 由来の漏れ。
 * - 一文字 / よくある loop・temp 変数名 = `f1` body / preF1 が `<script>` として top-level 実行されるため
 *   `var i` / `for(var keys ...)` 等が global に漏れる (= workload/lib の意図した state ではない script 実行 artifact)。
 *   underscore-1224 の偽 not_equal (`new_globals` が片側だけ `keys` を含む) 解消。
 */
export const EXTERNAL_OBSERVATION_PROFILE: ExternalObservationProfile = {
  ignoreNewGlobalPatterns: [
    /^ng/,
    /^__selakovic/,
    /^[a-z]$/,
    /^(arr|el|fn|idx|item|key|keys|len|n|node|obj|res|result|str|tmp|val|values)$/,
  ],
};

/**
 * O3 (exception): Selakovic dataset は slow/fast を `<lib>_before/`/`<lib>_after/` の別 dir に置くため、
 * dep 解決失敗時の error message に `Cannot find module './backbone_before/...'` のように配置 artifact が混じる。
 * 比較前に `_(before|after)` を除去して「両側同じく落ちた」と正しく判定する (backbone-1097/2858/707 / mocha-763)。
 */
export const EXCEPTION_PROFILE: ExceptionProfile = {
  normalizeMessagePatterns: [[/([A-Za-z][\w.$-]*)_(?:before|after)(?=[/'")\s.\\:]|$)/g, "$1"]],
};

/**
 * C6 (interaction-trace): trace から除外する path prefix。framework の bootstrap-phase 自己呼び出し
 * (`angular.module(...)` / `angular.injector(...)` / `React.render(...)` 等) を比較対象に乗せない。
 * 記録 Proxy で包む対象を「workload が叩く境界」に限れば本来ノイズは乗らないが、保険として持つ。
 * (内部レイアウトノイズ — `cid`・`_`-prefix フィールド — の除去は記録 Proxy 側の serializer / get-trap で
 *  キー単位に行う。`ignoreGets` 全 get 除外は「workload が境界 object を read しただけ」を観測から落として
 *  しまい偽 inconclusive を生むので使わない。)
 */
export const INTERACTION_TRACE_PROFILE: InteractionTraceProfile = {
  ignorePathPrefixes: [],
};

/**
 * iteration-cap (ADR-0017): 計測ハーネスは preprocess が除去済 (`f1` は 1 回しか走らない) なので、
 * ここで縮めるのは `f1` body / lib 内部に残る大きいリテラル境界ループ。`threshold` 以上のリテラル上限を
 * `cap` に clamp する。`cap=null` で無効。
 *
 * threshold は当初 10000 だったが、(a) 反復回数は等価の構成要素ではない (ADR-0013) し spike で「縮小しても
 * verdict は変わらない」を実証済、(b) ループが数百〜数千回回ると 1 反復あたりの C6 trace エントリ × 反復回数が
 * 記録 Proxy の trace 上限 (2000) を超え、その「どこで打ち切られたか」が slow/fast の trace 量の僅差で
 * ずれて偽 not_equal を生む (moment-1885 等)、ので 100 に下げて「数百回以上のループは 5 回に clamp」にする。
 */
export const ITERATION_CAP: IterationCapOptions = { threshold: 100, cap: 5 };

/**
 * jsdom 環境の重い候補 (AngularJS 665KB-2MB の load+bootstrap を含む) 用に推奨する timeout (ms)。
 * 呼び出し側が `timeout_ms` を明示していればそちらを尊重する (バッチ API は必須なので通常そちら)。
 */
export const HEAVY_JSDOM_TIMEOUT_MS = 20_000;
