/** sandbox 層の barrel — executor 群 + capture 型 + transform を一括 re-export。 */
export { executeSandboxed, type ExecuteOptions } from "./executors/vm";
export { executeInJsdom, type JsdomExecuteOptions } from "./executors/jsdom";
export { SandboxSetupError } from "./errors";
export { UNSERIALIZABLE_MARKER } from "./capture/snapshot";
export { makeRecorder, RECORDER_GLOBAL, type Recorder, type WrapOptions } from "./capture/recording-proxy";
export { applyIterationCap, type IterationCapOptions } from "./transforms/iteration-cap";
export type {
  ArgumentSnapshot,
  ConsoleCall,
  ConsoleMethod,
  ExceptionCapture,
  ExecutionCapture,
  TraceEntry,
} from "./capture/types";
