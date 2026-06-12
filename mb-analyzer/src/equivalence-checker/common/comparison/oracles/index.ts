/** oracle 群の barrel。各 oracle は `(before, after, opts?) → OracleObservation` の純関数。 */
export { checkReturnValue } from "./return-value";
export { checkArgumentMutation } from "./argument-mutation";
export { checkException, type ExceptionProfile } from "./exception";
export { checkExternalObservation, type ExternalObservationProfile } from "./external-observation";
export { checkDomMutation, type DomNormalizeProfile } from "./dom-mutation";
export { checkInteractionTrace, type InteractionTraceProfile } from "./interaction-trace";
