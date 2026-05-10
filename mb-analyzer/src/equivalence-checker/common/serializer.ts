/**
 * sandbox 実行結果の値を canonical な文字列に変換する。
 * 目的は 2 つの実行結果の等価判定であり、人間可読性より決定性を優先する。
 *
 * - NaN / -0 / ±Infinity / BigInt / Symbol / 関数を専用表現で区別
 * - オブジェクトのキーは sort してイテレーション順序非依存に
 * - 循環参照は SerializationError を投げる（oracle 側で error verdict に丸める）
 */

export class SerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SerializationError";
  }
}

export function serializeValue(value: unknown): string {
  return serialize(value, []);
}

function serializeNumber(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Number.POSITIVE_INFINITY) return "Infinity";
  if (n === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (n === 0) return Object.is(n, -0) ? "-0" : "0";
  return String(n);
}

function serialize(value: unknown, stack: object[]): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";

  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "bigint") return `${(value as bigint).toString()}n`;
  if (t === "symbol") return `<symbol:${(value as symbol).description ?? ""}>`;
  if (t === "function") return "<function>";
  if (t === "number") return serializeNumber(value as number);

  const obj = value as object;
  if (stack.includes(obj)) {
    throw new SerializationError("Circular reference detected while serializing value");
  }
  stack.push(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item) => serialize(item, stack));
      return `[${parts.join(",")}]`;
    }
    if (obj instanceof Date) {
      return `<Date:${String(obj.getTime())}>`;
    }
    if (obj instanceof Map) {
      const entries: Array<[string, string]> = [...obj.entries()].map(([k, v]) => [
        serialize(k, stack),
        serialize(v, stack),
      ]);
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const body = entries.map(([k, v]) => `${k}=>${v}`).join(",");
      return `<Map:{${body}}>`;
    }
    if (obj instanceof Set) {
      const items = [...obj.values()].map((v) => serialize(v, stack));
      items.sort();
      return `<Set:{${items.join(",")}}>`;
    }
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => {
      const v = (obj as Record<string, unknown>)[k];
      return `${JSON.stringify(k)}:${serialize(v, stack)}`;
    });
    return `{${parts.join(",")}}`;
  } finally {
    stack.pop();
  }
}

// 判断: ai-guide/adr/0007-in-source-testing-internal-helpers.md
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("serializeNumber (in-source)", () => {
    it("NaN / Infinity / -Infinity / -0 を区別する", () => {
      expect(serializeNumber(NaN)).toBe("NaN");
      expect(serializeNumber(Infinity)).toBe("Infinity");
      expect(serializeNumber(-Infinity)).toBe("-Infinity");
      expect(serializeNumber(-0)).toBe("-0");
      expect(serializeNumber(0)).toBe("0");
      expect(serializeNumber(3.14)).toBe("3.14");
    });
  });
}
