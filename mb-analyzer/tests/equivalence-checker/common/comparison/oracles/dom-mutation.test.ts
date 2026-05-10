/**
 * 対象: Oracle C2 - checkDomMutation (dom-mutation)
 * 観点: jsdom 実行後の dom_html を正規化プロファイル (ng-* 属性 / ng-scope class / コメント無視 / 空白 collapse / 属性 sort)
 *       で揃えてから slow/fast を文字列比較する
 * 判定事項:
 *   - 両側 dom_html 無し → not_applicable
 *   - framework ノイズだけの差は正規化で消えて equal
 *   - 真の DOM 差は not_equal
 *   - 片方だけ DOM 取得 → not_equal
 *   - rootSelector で比較対象 subtree を絞れる
 */
import { describe, expect, it } from "vitest";
import { checkDomMutation } from "../../../../../src/equivalence-checker/common/comparison/oracles/dom-mutation";
import { capture } from "../../../../fixtures/capture";

describe("checkDomMutation", () => {
  it("両側 dom_html 無し → not_applicable", () => {
    expect(checkDomMutation(capture(), capture()).verdict).toBe("not_applicable");
  });

  it("framework ノイズ (ng-* 属性 / ng-scope class / ngRepeat コメント / 空白 / 属性順) だけの差は equal", () => {
    const profile = {
      ignoreAttributes: ["ng-version"],
      ignoreClassTokens: ["ng-scope"],
      ignoreCommentNodes: true,
      collapseWhitespace: true,
      sortAttributes: true,
    };
    const slow = capture({
      dom_html: `<!doctype html><html><head></head><body><div class="x ng-scope" ng-version="1.5"><!-- ngRepeat: a in b -->  Hi  </div></body></html>`,
    });
    const fast = capture({
      dom_html: `<!doctype html><html><head></head><body><div ng-version="1.6" class="x"> Hi </div></body></html>`,
    });
    expect(checkDomMutation(slow, fast, profile).verdict).toBe("equal");
  });

  it("真の DOM 差は not_equal", () => {
    const slow = capture({ dom_html: `<!doctype html><html><head></head><body><p>A</p></body></html>` });
    const fast = capture({ dom_html: `<!doctype html><html><head></head><body><p>B</p></body></html>` });
    expect(checkDomMutation(slow, fast).verdict).toBe("not_equal");
  });

  it("片方だけ DOM 取得 → not_equal", () => {
    expect(
      checkDomMutation(capture({ dom_html: "<html><head></head><body></body></html>" }), capture()).verdict,
    ).toBe("not_equal");
  });

  it("rootSelector で比較対象 subtree を絞れる", () => {
    const slow = capture({
      dom_html: `<html><head></head><body><div id="demo">X</div><div>noise-A</div></body></html>`,
    });
    const fast = capture({
      dom_html: `<html><head></head><body><div id="demo">X</div><div>noise-B</div></body></html>`,
    });
    expect(checkDomMutation(slow, fast, { rootSelector: "#demo" }).verdict).toBe("equal");
    expect(checkDomMutation(slow, fast).verdict).toBe("not_equal");
  });
});
