import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter } from "../../adapter.js";

type OutputShape = "valid-json" | "non-json" | "different-json";

class ForegroundFixturePty {
  readonly pid = 98_153;
  private onDataHandler?: (data: string) => void;
  private onExitHandler?: (event: { exitCode: number; signal: number }) => void;
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(handler: (data: string) => void): void { this.onDataHandler = handler; }
  onExit(handler: (event: { exitCode: number; signal: number }) => void): void { this.onExitHandler = handler; }
  emitData(data: string): void { this.onDataHandler?.(data); }
  emitExit(): void { this.onExitHandler?.({ exitCode: 0, signal: 0 }); }
}

const outputShape = process.argv[2] as OutputShape | undefined;
if (!outputShape || !(["valid-json", "non-json", "different-json"] as const).includes(outputShape)) throw new Error(`Unsupported output shape: ${outputShape ?? "missing"}`);
const outputByShape: Record<OutputShape, string> = {
  "valid-json": `${JSON.stringify({ type: "message", text: "valid Pi output" })}\n`,
  "non-json": "plain Pi terminal output\n",
  "different-json": `${JSON.stringify({ unexpected: { nested: "Pi output" }, items: [1, 2] })}\n`,
};

const dir = mkdtempSync(join(tmpdir(), "ppa-open-stdin-child-"));
const primer = join(dir, "primer.md");
writeFileSync(primer, "open stdin lifecycle fixture");
const pty = new ForegroundFixturePty();
const readableFlowingBefore = process.stdin.readableFlowing;
const adapter = new PiAdapter({
  cwd: dir,
  versionProbe: () => "0.80.8",
  nativeRegistryProbe: () => undefined,
  supervision: {
    spawnPty: () => pty as never,
    input: process.stdin,
    output: process.stdout,
    processExists: () => true,
  },
});

try {
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-open-stdin", mode: "foreground", sessionId: "open-stdin-session" });
  setTimeout(() => {
    pty.emitData(outputByShape[outputShape]);
    process.stdout.write(`${JSON.stringify({
      type: "child-exit-evidence",
      outputShape,
      readableFlowingBefore,
      readableFlowing: process.stdin.readableFlowing,
      dataListeners: process.stdin.listenerCount("data"),
    })}\n`);
    pty.emitExit();
  }, 50);
  const result = await resultPromise;
  process.stdout.write(`${JSON.stringify({
    type: "adapter-settled",
    outputShape,
    exitCode: result.exitCode,
    readableFlowing: process.stdin.readableFlowing,
    dataListeners: process.stdin.listenerCount("data"),
  })}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
