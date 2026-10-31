import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const url = new URL(import.meta.url), path = url.searchParams.get("frame");
if (!path) throw new Error("qualification import audit frame missing");
const frame = JSON.parse(readFileSync(path, "utf8"));
register(new URL("./workflow_import_audit.mjs", import.meta.url), { parentURL: import.meta.url, data: frame });
