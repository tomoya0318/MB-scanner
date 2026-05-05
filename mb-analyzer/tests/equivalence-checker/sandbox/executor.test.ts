/**
 * 対象: executeSandboxed (vm.Script による slow/fast 実行 + 観測値 (return/exception/console/globals/arg_snapshots) の捕捉)
 * 観点: 4 oracle が使う ExecutionCapture を過不足なく生成し、stabilizer との統合で決定的に動くこと
 * 判定事項:
 *   - 戻り値: 式の serialize、setup 変数参照、文のみなら return_is_undefined=true、NaN/-0 区別
 *   - 例外: throw Error の ctor/message 捕捉、primitive throw → ctor "Unknown"
 *   - timeout: 無限ループで timed_out=true + exception 捕捉
 *   - console: log/error 等が console_log に順序通りに蓄積
 *   - 引数変異 (O2): setup 由来の配列・オブジェクトの pre/post snapshot、プリミティブは除外
 *   - 新規 global (O4): body で代入された key だけが new_globals、setup 由来は除外
 *   - Promise: resolve は return_value、reject は exception、async IIFE も await 済み
 *   - 決定性: stabilizer により Math.random / Date.now が同一 setup/body で再現
 */
import { describe, expect, it } from "vitest";
import { executeSandboxed } from "../../../src/equivalence-checker/sandbox/executor";

function run(body: string, setup = "", timeout_ms = 2000) {
  return executeSandboxed({ setup, body, timeout_ms });
}

describe("executeSandboxed: 戻り値", () => {
  it("単純な式の戻り値を serialize", async () => {
    const res = await run("1 + 2");
    expect(res.return_value).toBe("3");
    expect(res.return_is_undefined).toBe(false);
    expect(res.exception).toBeNull();
    expect(res.timed_out).toBe(false);
  });

  it("setup で定義した変数を body から参照できる", async () => {
    const res = await run("x * 10", "const x = 4;");
    expect(res.return_value).toBe("40");
  });

  it("body が文だけだと return_value は undefined で return_is_undefined が true", async () => {
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
  it("body で代入された新規 global key が new_globals に入る", async () => {
    const res = await run("g = 1; g");
    expect(res.new_globals).toContain("g");
  });

  it("setup 由来の key は new_globals に含まれない", async () => {
    const res = await run("1", "var setupVar = 5;");
    expect(res.new_globals).not.toContain("setupVar");
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
  it("同じ setup/body で Math.random / Date.now が毎回同じ値になる", async () => {
    const body = `[Math.random(), Math.random(), Date.now()]`;
    const a = await run(body);
    const b = await run(body);
    expect(a.return_value).toBe(b.return_value);
  });
});

describe("executeSandboxed: undefined stub fallback", () => {
  it("setup に require / angular を含んでも例外で死なず body が走る", async () => {
    const setup = `
      var $ = require("jquery");
      var module = angular.module("app", []);
      var f1 = function (n) { return n + 1; };
    `;
    const res = await run("f1(10)", setup);
    expect(res.exception).toBeNull();
    expect(res.return_value).toBe("11");
  });

  it("body 内の execute(f1, n) ハーネス呼び出しは stub で吸収される", async () => {
    const setup = `var f1 = function () { return 42; };`;
    const res = await run("var a = execute(f1, 10); typeof a", setup);
    expect(res.exception).toBeNull();
    expect(res.return_value).toBe('"function"');
  });
});

describe("executeSandboxed: setup 例外", () => {
  it("setup で throw された例外は exception に詰めて body は実行しない", async () => {
    const res = await run(
      "globalThis.bodyRan = true; 999",
      `throw new TypeError("setup boom");`,
    );
    expect(res.exception).toEqual({ ctor: "TypeError", message: "setup boom" });
    expect(res.return_is_undefined).toBe(true);
    expect(res.new_globals).not.toContain("bodyRan");
  });

  it("setup で primitive throw も Unknown として捕捉される", async () => {
    const res = await run("1", `throw "raw string"`);
    expect(res.exception?.ctor).toBe("Unknown");
    expect(res.exception?.message).toBe("raw string");
  });
});
