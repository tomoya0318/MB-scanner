/**
 * sandbox 実行結果の値を canonical な文字列に変換する。
 * 目的は 2 つの実行結果の等価判定であり、人間可読性より決定性を優先する。
 *
 * - NaN / -0 / ±Infinity / BigInt / Symbol / 関数を専用表現で区別
 * - オブジェクトのキーは sort してイテレーション順序非依存に
 * - 循環参照は SerializationError を投げる（oracle 側で error verdict に丸める）
 * - DOM ノード (jsdom の Element/Node 等) は `<dom:tag#id.cls text="...">` 等の短縮表現
 * - `opts.skipKeyPrefixes` で指定 prefix の plain-object own key を無視 (例: AngularJS の `$$hashKey`)
 * - `opts.maxDepth` で object グラフの深さ上限 (循環ではない深いグラフのハング防止)。default = 無制限。
 */

export class SerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SerializationError";
  }
}

export interface SerializeOptions {
  /** これらの prefix で始まる plain-object の own string key を無視する (正規化)。値は selakovic adapter から渡す。 */
  skipKeyPrefixes?: readonly string[];
  /** object グラフの最大深さ。超えたら `"<deep>"` を返す。default = 無制限 (深い構造は呼び出し側が必要なら制限する)。 */
  maxDepth?: number;
}

const EMPTY_OPTIONS: SerializeOptions = {};

export function serializeValue(value: unknown, options: SerializeOptions = EMPTY_OPTIONS): string {
  return serialize(value, [], options, 0);
}

function serializeNumber(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Number.POSITIVE_INFINITY) return "Infinity";
  if (n === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (n === 0) return Object.is(n, -0) ? "-0" : "0";
  return String(n);
}

/** DOM ノード (Element / Text / Comment / Document) を短い識別表現にする。ノードでなければ null。 */
function domNodeRepr(obj: object): string | null {
  const node = obj as {
    nodeType?: unknown;
    nodeName?: unknown;
    id?: unknown;
    className?: unknown;
    textContent?: unknown;
  };
  if (typeof node.nodeType !== "number" || typeof node.nodeName !== "string") return null;
  const text = typeof node.textContent === "string" ? node.textContent : "";
  switch (node.nodeType) {
    case 1: {
      const id = typeof node.id === "string" && node.id.length > 0 ? `#${node.id}` : "";
      const cls =
        typeof node.className === "string" && node.className.trim().length > 0
          ? `.${node.className.trim().split(/\s+/).join(".")}`
          : "";
      return `<dom:${node.nodeName.toLowerCase()}${id}${cls} text=${JSON.stringify(text)}>`;
    }
    case 3:
      return `<dom:#text ${JSON.stringify(text)}>`;
    case 8:
      return `<dom:#comment ${JSON.stringify(text)}>`;
    case 9:
      return "<dom:#document>";
    default:
      return `<dom:${node.nodeName}>`;
  }
}

function serialize(value: unknown, stack: object[], options: SerializeOptions, depth: number): string {
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
  const dom = domNodeRepr(obj);
  if (dom !== null) return dom;
  if (options.maxDepth !== undefined && depth >= options.maxDepth) return "<deep>";

  stack.push(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item) => serialize(item, stack, options, depth + 1));
      return `[${parts.join(",")}]`;
    }
    if (obj instanceof Date) {
      return `<Date:${String(obj.getTime())}>`;
    }
    if (obj instanceof Map) {
      const entries: Array<[string, string]> = [...obj.entries()].map(([k, v]) => [
        serialize(k, stack, options, depth + 1),
        serialize(v, stack, options, depth + 1),
      ]);
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const body = entries.map(([k, v]) => `${k}=>${v}`).join(",");
      return `<Map:{${body}}>`;
    }
    if (obj instanceof Set) {
      const items = [...obj.values()].map((v) => serialize(v, stack, options, depth + 1));
      items.sort();
      return `<Set:{${items.join(",")}}>`;
    }
    const skipPrefixes = options.skipKeyPrefixes ?? [];
    const keys = Object.keys(obj)
      .filter((k) => !skipPrefixes.some((p) => k.startsWith(p)))
      .sort();
    const parts = keys.map((k) => {
      const v = (obj as Record<string, unknown>)[k];
      return `${JSON.stringify(k)}:${serialize(v, stack, options, depth + 1)}`;
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

  describe("serializeValue opts (in-source)", () => {
    it("skipKeyPrefixes で指定 prefix の own key を無視する", () => {
      expect(serializeValue({ a: 1, $$hashKey: "x", $$id: 2, b: 3 }, { skipKeyPrefixes: ["$$"] })).toBe(
        '{"a":1,"b":3}',
      );
      // 既定 (opts なし) は無視しない
      expect(serializeValue({ a: 1, $$hashKey: "x" })).toBe('{"$$hashKey":"x","a":1}');
    });

    it("maxDepth を超えたら <deep> (他の sentinel と同様にクォートなし)", () => {
      expect(serializeValue({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toBe('{"a":{"b":<deep>}}');
      // 既定は無制限
      expect(serializeValue({ a: { b: { c: 1 } } })).toBe('{"a":{"b":{"c":1}}}');
    });

    it("DOM 風オブジェクト (nodeType/nodeName) は短縮表現", () => {
      const el = { nodeType: 1, nodeName: "DIV", id: "demo", className: "foo bar", textContent: "hi" };
      expect(serializeValue(el)).toBe('<dom:div#demo.foo.bar text="hi">');
      expect(serializeValue({ nodeType: 3, nodeName: "#text", textContent: "x" })).toBe('<dom:#text "x">');
      expect(serializeValue({ nodeType: 9, nodeName: "#document" })).toBe("<dom:#document>");
    });
  });
}
