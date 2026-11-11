import { readFileSync, accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicWebError } from "./types.js";

export interface PublicWebRuntime { curl: string; python: string; ca: string; script: string }
/** Build-owned package metadata, never environment/PATH or caller-selected code. */
export function publicWebRuntime(): PublicWebRuntime {
  try {
    const data = JSON.parse(readFileSync(new URL("../../dist/public-web/runtime.json", import.meta.url), "utf8"));
    for (const key of ["curl", "python", "ca"]) {
      if (typeof data[key] !== "string" || !data[key].startsWith("/nix/store/") || /[\r\n\0]/.test(data[key])) throw new Error();
      accessSync(data[key], key === "ca" ? constants.R_OK : constants.X_OK);
    }
    const script = fileURLToPath(new URL("../../dist/public-web/extract.py", import.meta.url));
    accessSync(script, constants.R_OK);
    return { curl: data.curl, python: data.python, ca: data.ca, script };
  } catch { throw new PublicWebError("WEB_POLICY"); }
}
