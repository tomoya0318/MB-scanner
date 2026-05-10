/**
 * 対象: equivalence-checker/sandbox/jsdom-executor.ts (ADR-0012 の jsdom 環境 最小版)。
 * 観点: jsdom window/document を持つ context で body を実行し `ExecutionCapture` を返す /
 *       console 捕捉 / Date.now の凍結 / 相対 require の解決 / 例外捕捉。
 */
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, it } from "vitest";

import { executeInJsdom } from "../../../src/equivalence-checker/sandbox/jsdom-executor";

const TIMEOUT = 5000;

describe("executeInJsdom", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("setup スコープの object 変化を arg_snapshots で追跡し、body の完了値を return_value にする", async () => {
    const cap = await executeInJsdom({ setup: "var obj = { a: 1 };", body: "obj.a = 2; obj.a", timeout_ms: TIMEOUT });
    expect(cap.return_value).toBe("2");
    expect(cap.return_is_undefined).toBe(false);
    const snap = cap.arg_snapshots.find((s) => s.key === "obj");
    expect(snap?.pre).toContain("1");
    expect(snap?.post).toContain("2");
  });

  it("document / window を参照できる", async () => {
    const cap = await executeInJsdom({ setup: "", body: "document.body.innerHTML = '<p>hi</p>'; document.body.innerHTML", timeout_ms: TIMEOUT });
    expect(cap.exception).toBeNull();
    expect(cap.return_value).toContain("<p>hi</p>");
  });

  it("console.log を捕捉する", async () => {
    const cap = await executeInJsdom({ setup: "", body: "console.log('hello', 42); 1", timeout_ms: TIMEOUT });
    expect(cap.console_log).toHaveLength(1);
    expect(cap.console_log[0]?.method).toBe("log");
    expect(cap.console_log[0]?.args).toEqual(["hello", 42]);
  });

  it("Date.now() / Math.random() が凍結されている (slow/fast で食い違わない)", async () => {
    const a = await executeInJsdom({ setup: "", body: "Date.now()", timeout_ms: TIMEOUT });
    const b = await executeInJsdom({ setup: "", body: "Date.now()", timeout_ms: TIMEOUT });
    expect(a.return_value).toBe("0");
    expect(b.return_value).toBe("0");
    const r1 = await executeInJsdom({ setup: "", body: "Math.random()", timeout_ms: TIMEOUT });
    const r2 = await executeInJsdom({ setup: "", body: "Math.random()", timeout_ms: TIMEOUT });
    expect(r1.return_value).toBe(r2.return_value);
  });

  it("例外を duck-typing で捕捉する", async () => {
    const cap = await executeInJsdom({ setup: "", body: "throw new TypeError('boom')", timeout_ms: TIMEOUT });
    expect(cap.exception?.ctor).toBe("TypeError");
    expect(cap.exception?.message).toBe("boom");
  });

  it("相対 require を module_base_dir 起点で解決する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mbs-jsdom-req-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "mod.js"), "module.exports = { value: 42, dep: require('./dep.js') };");
    writeFileSync(join(dir, "dep.js"), "module.exports = 7;");
    const cap = await executeInJsdom({ setup: "", body: "var m = require('./mod.js'); m.value + m.dep", timeout_ms: TIMEOUT, module_base_dir: dir });
    expect(cap.exception).toBeNull();
    expect(cap.return_value).toBe("49");
  });

  it("module_base_dir なしで相対 require は解決できないが、bare require は明確なエラーになる", async () => {
    const cap = await executeInJsdom({ setup: "", body: "require('some-missing-pkg')", timeout_ms: TIMEOUT });
    expect(cap.exception).not.toBeNull();
    expect(cap.exception?.message).toContain("module_base_dir");
  });
});
