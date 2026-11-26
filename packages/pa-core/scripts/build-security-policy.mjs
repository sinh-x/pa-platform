#!/usr/bin/env node
// The compiler must complete first. A failed validation never copies an asset.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SecurityPolicyError, validateSecurityPolicy } from "../dist/security-policy.js";
const source = new URL("../src/policies/security-defaults.v1.yaml", import.meta.url);
const output = new URL("../dist/policies/security-defaults.v1.yaml", import.meta.url);
try {
  const bytes = await readFile(source);
  const policy = validateSecurityPolicy(bytes);
  await mkdir(new URL("../dist/policies/", import.meta.url), { recursive: true });
  await writeFile(output, bytes);
  if (!(await readFile(output)).equals(bytes)) throw new Error("asset-parity");
  console.log(`PA security defaults validated and copied (${policy.schemaVersion}; sha256 ${policy.sha256}).`);
} catch (error) {
  console.error((error instanceof SecurityPolicyError ? error : new SecurityPolicyError("unavailable")).message);
  process.exitCode = 1;
}
