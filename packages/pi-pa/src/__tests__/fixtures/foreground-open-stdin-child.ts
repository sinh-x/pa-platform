import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter } from "../../adapter.js";

class ForegroundFixturePty {
  readonly pid = 98_153;
  private onExitHandler?: (event: { exitCode: number; signal: number }) => void;
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(): void {}
  onExit(handler: (event: { exitCode: number; signal: number }) => void): void { this.onExitHandler = handler; }
  emitExit(): void { this.onExitHandler?.({ exitCode: 0, signal: 0 }); }
}

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
    process.stdout.write(`${JSON.stringify({
      type: "child-exit-evidence",
      readableFlowingBefore,
      readableFlowing: process.stdin.readableFlowing,
      dataListeners: process.stdin.listenerCount("data"),
    })}\n`);
    pty.emitExit();
  }, 50);
  const result = await resultPromise;
  process.stdout.write(`${JSON.stringify({
    type: "adapter-settled",
    exitCode: result.exitCode,
    readableFlowing: process.stdin.readableFlowing,
    dataListeners: process.stdin.listenerCount("data"),
  })}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
