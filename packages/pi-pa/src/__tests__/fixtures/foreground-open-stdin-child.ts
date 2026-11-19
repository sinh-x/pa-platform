import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
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
const primer = join(dir, "primer.txt");
writeFileSync(primer, "open stdin lifecycle fixture");
const pty = new ForegroundFixturePty();
let childEnv: NodeJS.ProcessEnv | undefined;
const readableFlowingBefore = process.stdin.readableFlowing;
const adapter = new PiAdapter({
  cwd: dir,
  versionProbe: () => "0.84.4",
  nativeRegistryProbe: () => undefined,
  supervision: {
    spawnPty: (_file, _args, options) => { childEnv = options.env; return pty as never; },
    input: process.stdin,
    output: process.stdout,
    processExists: () => true,
  },
});

try {
  const resultPromise = adapter.spawn({ primerPath: primer, deployId: "d-open-stdin", mode: "foreground", sessionId: "open-stdin-session" });
  setTimeout(async () => {
    if (process.env.PAP315_FIXTURE_HERDR_REPORT === "1" && childEnv?.HERDR_SOCKET_PATH) {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(childEnv!.HERDR_SOCKET_PATH!);
        socket.on("error", reject);
        socket.on("connect", () => socket.write(`${JSON.stringify({ id: "fixture-report", method: "pane.report_agent", params: {
          pane_id: childEnv!.HERDR_PANE_ID, source: "herdr:pi", agent: "pi", seq: 41, state: "idle", agent_session_id: "open-stdin-session",
        } })}\n`));
        socket.on("data", () => { socket.destroy(); resolve(); });
      });
    }
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
    herdrCleanup: result.metadata?.herdrCleanup,
    readableFlowing: process.stdin.readableFlowing,
    dataListeners: process.stdin.listenerCount("data"),
  })}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
