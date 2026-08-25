import { composeRuntimeHooks, type CoreExecutionHooks } from "@pa-platform/pa-core";
import { createDefaultOpencodeHooks } from "@pa-platform/opencode-pa";
import { createDefaultPiHooks } from "@pa-platform/pi-pa";

/** Compose all Agent API runtime registrations without making adapters depend on one another. */
export function createRuntimeHostHooks(args: {
  opencode?: CoreExecutionHooks;
  pi?: CoreExecutionHooks;
} = {}): CoreExecutionHooks {
  return composeRuntimeHooks(args.opencode ?? createDefaultOpencodeHooks(), args.pi ?? createDefaultPiHooks(), "opencode");
}

export { composeRuntimeHooks } from "@pa-platform/pa-core";
