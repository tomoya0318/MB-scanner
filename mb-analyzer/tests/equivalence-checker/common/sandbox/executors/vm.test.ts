/**
 * 対象: executeSandboxed (素 node:vm context での before/after 実行 + 観測値 (return/exception/console/globals/arg_snapshots) の捕捉)
 * 観点: 4 oracle が使う ExecutionCapture を過不足なく生成し、非決定性遮断・host 逃げ道遮断と統合して決定的に動くこと
 * 判定事項:
 *   - 戻り値: 式の serialize、setup 変数参照、文のみなら return_is_undefined=true、NaN/-0 区別
 *   - 例外: throw Error の ctor/message 捕捉、primitive throw → ctor "Unknown"
 *   - timeout: 無限ループで timed_out=true + exception 捕捉
 *   - console: log/error 等が console_log に順序通りに蓄積
 *   - 引数変異 (O2): setup 由来の配列・オブジェクトの pre/post snapshot、プリミティブは除外
 *   - 新規 global (O4): workload で代入された key だけが new_globals、setup 由来は除外
 *   - host 逃げ道: process / require / eval / Function は undefined として遮断
 *   - Promise: resolve は return_value、reject は exception、async IIFE も await 済み
 *   - 決定性: 非決定性遮断により Math.random / Date.now が同一 setup/workload で再現
 */
import { describe, expect, it } from "vitest";
import { executeSandboxed } from "../../../../../src/equivalence-checker/common/sandbox/executors/vm";
import { SandboxSetupError } from "../../../../../src/equivalence-checker/common/sandbox/errors";

function run(workload: string, setup = "", timeout_ms = 2000) {
  return executeSandboxed({ setup, workload, timeout_ms });
}

describe("executeSandboxed: 戻り値", () => {
  it("単純な式の戻り値を serialize", async () => {
    const res = await run("1 + 2");
    expect(res.return_value).toBe("3");
    expect(res.return_is_undefined).toBe(false);
    expect(res.exception).toBeNull();
    expect(res.timed_out).toBe(false);
  });

  it("setup で定義した変数を workload から参照できる", async () => {
    const res = await run("x * 10", "const x = 4;");
    expect(res.return_value).toBe("40");
  });

  it("workload が文だけだと return_value は undefined で return_is_undefined が true", async () => {
    const res = await run("let z = 1;");
    expect(res.return_is_undefined).toBe(true);
    expect(res.return_value).toBe("undefined");
  });

  it("NaN / -0 を区別して serialize", async () => {
    expect((await run("0 / 0")).return_value).toBe("NaN");
    expect((await run("-0")).return_value).toBe("-0");
  });
});

describe("executeSandboxed: 例外", () => {
  it("throw された Error は ctor と message を捕捉", async () => {
    const res = await run(`throw new TypeError("bad")`);
    expect(res.exception).toEqual({ ctor: "TypeError", message: "bad" });
    expect(res.return_is_undefined).toBe(true);
  });

  it("throw された primitive は Unknown として扱う", async () => {
    const res = await run(`throw "plain"`);
    expect(res.exception?.ctor).toBe("Unknown");
    expect(res.exception?.message).toBe("plain");
  });
});

describe("executeSandboxed: timeout", () => {
  it("無限ループは timed_out が true で例外も捕捉", async () => {
    const res = await run("while(true){}", "", 50);
    expect(res.timed_out).toBe(true);
    expect(res.exception).not.toBeNull();
  });
});

describe("executeSandboxed: console", () => {
  it("console 呼び出しが console_log に蓄積", async () => {
    const res = await run(`console.log("a"); console.error("b"); 1`);
    expect(res.console_log.map((c) => c.method)).toEqual(["log", "error"]);
    expect(res.console_log[0]?.args).toEqual(["a"]);
  });
});

describe("executeSandboxed: 引数変異 (O2)", () => {
  it("setup で定義された配列への push が pre/post に現れる", async () => {
    const res = await run("arr.push(3); arr.length", "const arr = [1, 2];");
    expect(res.arg_snapshots).toHaveLength(1);
    const snap = res.arg_snapshots[0]!;
    expect(snap.key).toBe("arr");
    expect(snap.pre).toBe("[1,2]");
    expect(snap.post).toBe("[1,2,3]");
  });

  it("setup で定義されたオブジェクトのプロパティ変更が観測される", async () => {
    const res = await run("obj.count = 42;", "const obj = { count: 0 };");
    const snap = res.arg_snapshots[0]!;
    expect(snap.pre).toBe('{"count":0}');
    expect(snap.post).toBe('{"count":42}');
  });

  it("プリミティブ束縛は arg_snapshots に含まれない", async () => {
    const res = await run("n + 1", "const n = 5;");
    expect(res.arg_snapshots).toHaveLength(0);
  });

  it("setup で object を定義しない場合 arg_snapshots は空", async () => {
    const res = await run("1 + 1");
    expect(res.arg_snapshots).toEqual([]);
  });
});

describe("executeSandboxed: 新規 global (O4)", () => {
  it("workload で代入された新規 global key が new_globals に入る", async () => {
    const res = await run("g = 1; g");
    expect(res.new_globals).toContain("g");
  });

  it("setup 由来の key は new_globals に含まれない", async () => {
    const res = await run("1", "var setupVar = 5;");
    expect(res.new_globals).not.toContain("setupVar");
  });
});

describe("executeSandboxed: host 逃げ道の遮断", () => {
  it("process / require / eval / Function は undefined", async () => {
    const res = await run(`[typeof process, typeof require, typeof eval, typeof Function]`);
    expect(res.return_value).toBe('["undefined","undefined","undefined","undefined"]');
  });
});

describe("executeSandboxed: Promise 解決", () => {
  it("Promise が返されたら await 後の値を return_value とする", async () => {
    const res = await run("Promise.resolve(7)");
    expect(res.return_value).toBe("7");
    expect(res.exception).toBeNull();
  });

  it("Promise の reject は例外として捕捉", async () => {
    const res = await run(`Promise.reject(new RangeError("boom"))`);
    expect(res.exception?.ctor).toBe("RangeError");
    expect(res.exception?.message).toBe("boom");
  });

  it("async IIFE の await も解決される", async () => {
    const res = await run(`(async () => { return 21 * 2; })()`);
    expect(res.return_value).toBe("42");
  });
});

describe("executeSandboxed: 決定性", () => {
  it("同じ setup/workload で Math.random / Date.now が毎回同じ値になる", async () => {
    const workload = `[Math.random(), Math.random(), Date.now()]`;
    const a = await run(workload);
    const b = await run(workload);
    expect(a.return_value).toBe(b.return_value);
  });
});

describe("executeSandboxed: setup throw → SandboxSetupError 分離", () => {
  // ADR-0023 §D-β: setup 段階の throw は outer realm で `SandboxSetupError` として届く。
  // checker.ts の outer catch がこの型を見て `verdict_reason: "setup-failure"` を付ける経路の前提。
  it("setup で throw すると SandboxSetupError が outer に伝播し cause を保持する", async () => {
    await expect(
      executeSandboxed({ setup: `throw new Error("setup boom")`, workload: "1", timeout_ms: 2000 }),
    ).rejects.toSatisfy((e) => {
      if (!(e instanceof SandboxSetupError)) return false;
      // cross-realm Error なので outer の instanceof Error は false になる ─ cause が「何か」入っていれば十分。
      return e.cause !== undefined && e.cause !== null;
    });
  });

  it("workload 段階の throw は SandboxSetupError にはならず capture.exception に詰まる", async () => {
    const cap = await run(`throw new Error("workload boom")`);
    expect(cap.exception?.message).toBe("workload boom");
  });
});
