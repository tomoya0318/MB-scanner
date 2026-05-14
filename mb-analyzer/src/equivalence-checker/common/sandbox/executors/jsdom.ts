import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import vm from "node:vm";

import { JSDOM } from "jsdom";

import { hookJsdomConsole } from "../capture/console-hook";
import { makeRecorder, RECORDER_GLOBAL, type Recorder } from "../capture/recording-proxy";
import {
  captureException,
  collectArgSnapshots,
  collectNewGlobals,
  isTimeoutError,
  normalizeSetup,
  resolveIfPromise,
  snapshotSetupState,
  snapshotValue,
} from "../capture/snapshot";
import type { ConsoleCall, ExceptionCapture, ExecutionCapture } from "../capture/types";
import { SandboxSetupError } from "../errors";
import { freezeContextNonDeterminism } from "../transforms/non-determinism";

/**
 * `jsdom` の window/document を持つ VM context で 1 スクリプトを実行し `ExecutionCapture` を返す。
 * 判断: ai-guide/adr/0012-equivalence-checker-execution-environment.md
 *
 * - `runScripts: "outside-only"` で素の jsdom + `getInternalVMContext()` を使う (= `<script>` は実行しないが
 *   外から `vm.runInContext` で同じ realm に注入できる)。browser ライブラリ (AngularJS / jQuery 等) が
 *   `window` / `document` を参照しても動く。
 * - server `test_case_*.js` の `require('./<lib>_*.js')` 解決のため、グローバル `require` を注入する:
 *   相対パスは `module_base_dir` 起点で resolve して同 context で eval (`.js` / `.json` 対応)、bare npm dep は
 *   dataset fork の `node_modules` から host `createRequire` で解決を試みる (見つからなければ throw → `error`)。
 * - server SUT が前提にしがちな最小 Node グローバル (`process` / `Buffer` / `global` / `setImmediate`) を注入する。
 * - `mount_html` が来たら、その HTML (`<script>` 除去後) を `<body>` に流し込んで mount する (react-808 の `#demo*` 不在対策)。
 * - 実行後の `dom.serialize()` を `capture.dom_html` に詰める (C2 DOM-mutation oracle の取得側)。
 * - `recordInteractions` が真なら記録 Proxy を `globalThis.__recorder` として context に注入し、workload 実行後に
 *   `recorder.trace` を `capture.interaction_trace` に詰める (C6 の取得側)。runnable 側が `globalThis.__recorder` を見て
 *   workload が叩く境界オブジェクトを wrap する (`preprocessing/selakovic/assemble/*`)。注入しなければ runnable は素通り。
 * - `vm.ts` (素 vm 版) と同じ `ExecutionCapture` 形を返す (= oracle 層はこの型のみに依存)。
 */
export interface JsdomExecuteOptions {
  setup: string;
  workload: string;
  timeout_ms: number;
  /** 相対 `require('./x')` を解決する基準ディレクトリ (絶対パス)。省略時は relative require が throw。 */
  module_base_dir?: string;
  /** mount する HTML (`<body>` の中身、または `<!doctype>`/`<html>` で始まる完全な文書)。`<script>` は除去される。 */
  mount_html?: string;
  /** 真なら記録 Proxy を `globalThis.__recorder` として注入し、workload 実行後の `recorder.trace` を `capture.interaction_trace` に詰める。 */
  recordInteractions?: boolean;
}

/** workload 段階の評価結果 (戻り値 / 例外 / timeout を構造化)。 */
interface WorkloadEvaluation {
  returnValue: string;
  returnIsUndefined: boolean;
  exception: ExceptionCapture | null;
  timedOut: boolean;
}

const DEFAULT_DOCUMENT = "<!doctype html><html><head></head><body></body></html>";

function stripScriptTags(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

function buildDocument(mountHtml: string | undefined): string {
  if (mountHtml === undefined) return DEFAULT_DOCUMENT;
  const stripped = stripScriptTags(mountHtml);
  const head = stripped.trimStart().slice(0, 32).toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html")) return stripped;
  return `<!doctype html><html><head></head><body>${stripped}</body></html>`;
}

/**
 * setup フェーズを context 上で実行する副作用呼び出し (戻り値なし)。
 * setup 内での throw は `SandboxSetupError` で型分離して outer realm に投げる
 * (= checker.ts の outer catch が `verdict_reason: "setup-failure"` に分類するため、ADR-0023 §D-β)。
 * cross-realm 制約: vm.ts と同じく `new SandboxSetupError(e)` は host コード (= outer realm) で生成する。
 */
function prepareSandbox(setupCode: string, context: vm.Context, timeoutMs: number): void {
  if (setupCode.length === 0) return;
  try {
    vm.runInContext(normalizeSetup(setupCode), context, { timeout: timeoutMs, displayErrors: false });
  } catch (e) {
    throw new SandboxSetupError(e);
  }
}

/**
 * workload を context 上で評価して `{ returnValue, returnIsUndefined, exception, timedOut }` を返す。
 * vm.ts と並走する同形 helper。例外は戻り値に詰めて返り、outer には throw しない。
 */
async function evaluateWorkload(
  workloadCode: string,
  context: vm.Context,
  timeoutMs: number,
): Promise<WorkloadEvaluation> {
  let exception: ExceptionCapture | null = null;
  let timedOut = false;
  let returnValue = "undefined";
  let returnIsUndefined = true;
  try {
    const result: unknown = vm.runInContext(workloadCode, context, { timeout: timeoutMs, displayErrors: false });
    const resolved = await resolveIfPromise(result);
    if (resolved !== undefined) returnIsUndefined = false;
    returnValue = snapshotValue(resolved);
  } catch (e) {
    if (isTimeoutError(e)) timedOut = true;
    exception = captureException(e);
  }
  return { returnValue, returnIsUndefined, exception, timedOut };
}

export async function executeInJsdom(options: JsdomExecuteOptions): Promise<ExecutionCapture> {
  const dom = new JSDOM(buildDocument(options.mount_html), {
    runScripts: "outside-only",
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const context = dom.getInternalVMContext();
  const consoleCalls: ConsoleCall[] = [];
  hookJsdomConsole(dom, consoleCalls);
  freezeContextNonDeterminism(context);
  installServerGlobals(context);
  installRequire(context, options.module_base_dir, options.timeout_ms);

  const ctxRecord = context as unknown as Record<string, unknown>;
  let recorder: Recorder | null = null;
  if (options.recordInteractions === true) {
    recorder = makeRecorder();
    ctxRecord[RECORDER_GLOBAL] = recorder;
  }
  const baselineKeys = new Set(Object.keys(ctxRecord));

  // workload 実行前の DOM を覚えておく (= 初期 mount HTML の正規化前)。
  // workload 実行後にこれと比較して `dom_changed` を立てる。両側 false なら dom_mutation oracle は
  // N/A を返す (= 「両側とも DOM を変更しなかった」を positive evidence に誤認しないため、ADR-0018)。
  let initialDomHtml: string | null = null;
  try {
    initialDomHtml = dom.serialize();
  } catch {
    initialDomHtml = null;
  }

  prepareSandbox(options.setup, context, options.timeout_ms);

  const { setupKeys, trackedKeys, preSnapshots } = snapshotSetupState(ctxRecord, baselineKeys);

  const evaluation = await evaluateWorkload(options.workload, context, options.timeout_ms);

  let domHtml: string | null = null;
  try {
    domHtml = dom.serialize();
  } catch {
    domHtml = null;
  }
  // 初期 mount HTML との文字列比較で「workload 実行で DOM が変わったか」を判定する。
  // 厳密な正規化 (属性順 / 空白 collapse / framework ノイズ) は dom_mutation oracle が profile で行うが、
  // ここの目的は「何か触ったか」の 0/1 判定なので素の文字列比較で十分 (両側に同じ初期 HTML を流すので
  // 比較は対称)。`domHtml` か `initialDomHtml` が serialize 失敗で null なら undefined のまま (= 不明)。
  let domChanged: boolean | undefined;
  if (domHtml !== null && initialDomHtml !== null) {
    domChanged = domHtml !== initialDomHtml;
  }

  const capture: ExecutionCapture = {
    return_value: evaluation.returnValue,
    return_is_undefined: evaluation.returnIsUndefined,
    arg_snapshots: collectArgSnapshots(ctxRecord, trackedKeys, preSnapshots),
    exception: evaluation.exception,
    console_log: [...consoleCalls],
    new_globals: collectNewGlobals(ctxRecord, baselineKeys, setupKeys),
    timed_out: evaluation.timedOut,
    dom_html: domHtml,
  };
  if (domChanged !== undefined) capture.dom_changed = domChanged;
  if (recorder !== null) capture.interaction_trace = recorder.trace;
  return capture;
}

/** server SUT が前提にしがちな最小 Node グローバルを context に注入する。 */
function installServerGlobals(context: vm.Context): void {
  const rec = context as unknown as Record<string, unknown>;
  if (!("process" in rec) || rec.process === undefined) {
    rec.process = {
      browser: false,
      env: {},
      argv: [],
      platform: process.platform,
      version: process.version,
      versions: { ...process.versions },
      cwd: () => "/",
      nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
        queueMicrotask(() => {
          fn(...args);
        });
      },
      stdout: { isTTY: false, write: () => true },
      stderr: { isTTY: false, write: () => true },
    };
  }
  if (!("Buffer" in rec) || rec.Buffer === undefined) rec.Buffer = Buffer;
  if (!("global" in rec) || rec.global === undefined) rec.global = rec;
  if (!("setImmediate" in rec) || rec.setImmediate === undefined) {
    rec.setImmediate = (fn: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(() => {
      fn(...args);
    }, 0);
    rec.clearImmediate = (id: ReturnType<typeof setTimeout>) => {
      clearTimeout(id);
    };
  }
}

interface ModuleRecord {
  exports: unknown;
}

/** グローバル `require` を context に注入する (server `test_case` の相対/bare require 解決用)。 */
function installRequire(context: vm.Context, moduleBaseDir: string | undefined, timeoutMs: number): void {
  const cache = new Map<string, ModuleRecord>();
  const baseRequire = moduleBaseDir !== undefined ? createRequire(join(moduleBaseDir, "package.json")) : null;

  const makeRequire = (fromDir: string) => {
    const requireFn = (spec: string): unknown => {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        try {
          const resolved = resolveRelative(fromDir, spec);
          const cached = cache.get(resolved);
          if (cached !== undefined) return cached.exports;
          if (resolved.endsWith(".json")) {
            const json: unknown = JSON.parse(readFileSync(resolved, "utf-8"));
            const record: ModuleRecord = { exports: json };
            cache.set(resolved, record);
            return json;
          }
          const src = readFileSync(resolved, "utf-8");
          const record: ModuleRecord = { exports: {} };
          cache.set(resolved, record);
          const wrapper: unknown = vm.runInContext(
            `(function (module, exports, require, __dirname, __filename) {\n${src}\n})`,
            context,
            { timeout: timeoutMs, displayErrors: false },
          );
          (wrapper as (m: ModuleRecord, e: unknown, r: unknown, d: string, f: string) => void)(
            record,
            record.exports,
            makeRequire(dirname(resolved)),
            dirname(resolved),
            resolved,
          );
          return record.exports;
        } catch (e) {
          // フォールバック: 相対パスに `/node_modules/<x>` パターンがあれば、その最後のセグメントを
          // bare module として shared lockfile から解決を試す (判断: ai-guide/adr/0016-equivalence-sandbox-sut-dependency-resolution.md)。
          // dataset の test_case が `require('./<lib>/node_modules/<dep>')` のように lib の transitive dep を
          // hardcode パスで参照するパターンを救う — pnpm の shared install (上位 dir の node_modules) は
          // Node の relative 解決では辿れないため。bare 解決も失敗したら元の例外を投げる。
          const m = /\/node_modules\/([^/]+)\/?$/.exec(spec);
          const depName = m?.[1];
          if (depName !== undefined && baseRequire !== null) {
            try {
              return baseRequire(depName) as unknown;
            } catch {
              /* bare 解決も失敗 → 下の throw e */
            }
          }
          throw e;
        }
      }
      // bare npm dep — Selakovic dataset fork は SUT lib の依存を lockfile 同梱で vendor 済。
      // host の dataset node_modules から解決を試み、無ければ throw (= 呼び出し側の error verdict に乗る)。
      if (baseRequire !== null) {
        return baseRequire(spec) as unknown;
      }
      throw new Error(`Cannot resolve bare module '${spec}' (no module_base_dir provided)`);
    };
    return requireFn;
  };

  const root = moduleBaseDir ?? process.cwd();
  (context as unknown as Record<string, unknown>).require = makeRequire(root);
}

function resolveRelative(fromDir: string, spec: string): string {
  let resolved = isAbsolute(spec) ? spec : join(fromDir, spec);
  if (!existsSync(resolved) && existsSync(`${resolved}.js`)) resolved = `${resolved}.js`;
  if (!existsSync(resolved) && existsSync(`${resolved}.json`)) resolved = `${resolved}.json`;
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    const pkgPath = join(resolved, "package.json");
    const main = existsSync(pkgPath)
      ? ((JSON.parse(readFileSync(pkgPath, "utf-8")) as { main?: string }).main ?? "index.js")
      : "index.js";
    resolved = join(resolved, main);
    if (!existsSync(resolved) && existsSync(`${resolved}.js`)) resolved = `${resolved}.js`;
    if (!existsSync(resolved) && existsSync(`${resolved}.json`)) resolved = `${resolved}.json`;
  }
  if (!existsSync(resolved)) throw new Error(`Cannot find module '${spec}' (resolved to ${resolved})`);
  return resolved;
}
