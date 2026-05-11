export { checkEquivalence } from "./selakovic";
export { deriveOverallVerdict, deriveVerdictReason, VERDICT_REASON, type VerdictReason } from "./common/comparison/verdict";
export type {
  EquivalenceCheckResult,
  EquivalenceInput,
  Oracle,
  OracleObservation,
  OracleVerdict,
  Verdict,
} from "../contracts/equivalence-contracts";
