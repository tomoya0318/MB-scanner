/**
 * `console.*` の呼出列を記録する instrumentation (C3 = external-observation oracle の取得側)。
 * vm context 用には差し替え用オブジェクトを生成し、jsdom 用には既存 `window.console` を上書きする。
 */
import type { JSDOM } from "jsdom";

import type { ConsoleCall, ConsoleMethod } from "./types";

const CONSOLE_METHODS: readonly ConsoleMethod[] = ["log", "error", "warn", "info", "debug"];

/** vm sandbox に `console` として渡すフック。各メソッドが `sink` に push する。 */
export function createConsoleHook(sink: ConsoleCall[]): Record<ConsoleMethod, (...args: unknown[]) => void> {
  const hook = {} as Record<ConsoleMethod, (...args: unknown[]) => void>;
  for (const method of CONSOLE_METHODS) {
    hook[method] = (...args: unknown[]) => {
      sink.push({ method, args });
    };
  }
  return hook;
}

/** jsdom window の `console.*` を `sink` に push するフックで上書きする。 */
export function hookJsdomConsole(dom: JSDOM, sink: ConsoleCall[]): void {
  const console = dom.window.console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => {
      sink.push({ method, args });
    };
  }
}
