import { timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { assertUnmanagedOperator } from "./operator-origin.js";

export interface OperatorTerminal {
  assertAvailable(): void;
  display(text: string): void;
  confirm(prompt: string, expected: string): Promise<boolean>;
  secret(prompt: string): Promise<Buffer>;
}
/** Hidden fresh controlling-terminal input only. No argv/environment/stdin-pipe
 * password, no cache, no transcript/log callbacks and no fallback to echoed input.
 * TTY is transport, not proof of human origin; managed-origin checks are separate.
 */
/** assertOperator is a trusted terminal-fixture seam, never argv/environment. */
export function operatorTerminal(assertOperator: () => void = assertUnmanagedOperator): OperatorTerminal {
  const available = () => {
    assertOperator();
    if (!process.stdin.isTTY || !process.stderr.isTTY || typeof process.stdin.setRawMode !== "function") throw new Error("Operator terminal required");
  };
  return {
    assertAvailable: available,
    display(text) { available(); process.stderr.write(text); },
    async confirm(prompt, expected) {
      available(); const reader = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      try { return (await reader.question(prompt)) === expected; } finally { reader.close(); }
    },
    async secret(prompt) {
      available();
      return new Promise<Buffer>((resolve, reject) => {
        const data = Buffer.alloc(1024); let length = 0, complete = false;
        const wasRaw = process.stdin.isRaw, wasFlowing = process.stdin.readableFlowing;
        const finish = (error?: Error) => {
          if (complete) return; complete = true;
          process.stdin.off("data", input); process.stdin.off("end", ended); process.stdin.off("error", failed);
          process.stdin.setRawMode(wasRaw); if (wasFlowing !== true) process.stdin.pause(); process.stderr.write("\n");
          const result = Buffer.from(data.subarray(0, length)); data.fill(0);
          if (error) { result.fill(0); reject(error); } else resolve(result);
        };
        const input = (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          for (const byte of bytes) {
            if (complete) break;
            if (byte === 3 || byte === 4) { finish(new Error("Operator input cancelled")); break; }
            if (byte === 13 || byte === 10) { finish(); break; }
            if (byte === 127 || byte === 8) { if (length) { do { length--; } while (length && (data[length]! & 0xc0) === 0x80); data.fill(0, length); } continue; }
            if (byte < 32 || length >= data.length) { finish(new Error("Operator input rejected")); break; }
            data[length++] = byte;
          }
        };
        const ended = () => finish(new Error("Operator input closed")), failed = () => finish(new Error("Operator input unavailable"));
        process.stdin.setRawMode(true); process.stdin.on("data", input); process.stdin.once("end", ended); process.stdin.once("error", failed); process.stderr.write(prompt); process.stdin.resume();
      });
    },
  };
}
export async function newOperatorSecret(terminal: OperatorTerminal): Promise<Buffer> {
  const first = await terminal.secret("New operator password (12–1024 UTF-8 bytes): ");
  let second: Buffer | undefined;
  try {
    second = await terminal.secret("Repeat new operator password: ");
    if (first.length !== second.length || !timingSafeEqual(first, second)) throw new Error("Operator input mismatch");
    return first;
  } catch (error) { first.fill(0); throw error; }
  finally { second?.fill(0); }
}
