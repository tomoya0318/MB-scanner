/** oracle 群の barrel。各 oracle は `(slow, fast, opts?) → OracleObservation` の純関数。 */
export { checkReturnValue } from "./return-value";
export { checkArgumentMutation } from "./argument-mutation";
export { checkException } from "./exception";
export { checkExternalObservation } from "./external-observation";
