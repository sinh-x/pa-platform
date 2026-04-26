import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { listRepos, resolveProjectFromCwd } from "./repos.js";

export interface SelectProjectOptions {
  cwd?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (message: string) => void;
}

function createLineQueue(rl: ReturnType<typeof createInterface>): () => Promise<string> {
  const buffer: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  rl.on("line", (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else buffer.push(line);
  });
  return () => {
    const line = buffer.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve) => waiting.push(resolve));
  };
}

export async function selectProject(options: SelectProjectOptions = {}): Promise<{ key: string; prefix: string; path: string }> {
  const log = options.log ?? ((message: string) => console.log(message));
  const cwd = resolveProjectFromCwd(options.cwd ?? process.cwd());
  if (cwd) {
    log(`Detected project: ${cwd.key}`);
    log("");
    return { key: cwd.key, prefix: cwd.prefix, path: "" };
  }

  const repos = listRepos().filter((repo) => repo.prefix);
  if (repos.length === 0) throw new Error("No registered repos found in repos.yaml");
  log("Select a project:");
  log("");
  repos.forEach((repo, i) => log(`  ${i + 1}. ${repo.name} (${repo.prefix}) - ${repo.path}`));
  log("");

  const rl = createInterface({ input: (options.input ?? process.stdin) as Readable, output: (options.output ?? process.stdout) as Writable });
  const nextLine = createLineQueue(rl);
  try {
    while (true) {
      const num = Number.parseInt((await nextLine()).trim(), 10);
      if (num >= 1 && num <= repos.length) {
        const chosen = repos[num - 1]!;
        return { key: chosen.name, prefix: chosen.prefix!, path: chosen.path };
      }
      log(`Invalid selection. Enter a number between 1 and ${repos.length}:`);
    }
  } finally {
    rl.close();
  }
}
