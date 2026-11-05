// Compatibility facade: retained Pi evidence bytes, refs and process semantics
// remain unchanged. Both runtime adapters now use the same neutral owner.
export { NativeExecutionEvidence, NativeProcessEvidenceError, trustedNativeExecutable, runNativeExecutionProcess, nativePublicText,
  type NativeBlob, type NativeProcessResult } from "@pa-platform/pa-core";
