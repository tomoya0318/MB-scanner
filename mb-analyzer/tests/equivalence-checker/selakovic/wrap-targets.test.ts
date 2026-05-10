/**
 * 対象: wrapTargetsFor (記録 Proxy で何を包むかの spec)
 * 観点: enclosure_type → wrap spec のマッピング (server は init/setupTest 戻り値、Angular は注入 service、
 *       lib-file は lib global、それ以外は包まない)。spec はまだ executor から消費していない (wrap-targets.ts 参照)。
 */
import { describe, expect, it } from "vitest";
import { wrapTargetsFor } from "../../../src/equivalence-checker/selakovic/wrap-targets";

describe("wrapTargetsFor", () => {
  it("server-test-case → init-setup-results", () => {
    expect(wrapTargetsFor("server-test-case")).toEqual({ kind: "init-setup-results" });
  });

  it("angular-controller-wrapper → injected-services ($scope / $compile / $filter)", () => {
    expect(wrapTargetsFor("angular-controller-wrapper")).toEqual({
      kind: "injected-services",
      names: ["$scope", "$compile", "$filter"],
    });
  });

  it("lib-file / lib-file+f1-body → globals", () => {
    expect(wrapTargetsFor("lib-file")?.kind).toBe("globals");
    expect(wrapTargetsFor("lib-file+f1-body")?.kind).toBe("globals");
  });

  it("f1-body / fallback / 未知 / undefined は包まない (null)", () => {
    expect(wrapTargetsFor("f1-body")).toBeNull();
    expect(wrapTargetsFor("fallback")).toBeNull();
    expect(wrapTargetsFor("FunctionDeclaration")).toBeNull();
    expect(wrapTargetsFor(undefined)).toBeNull();
  });
});
