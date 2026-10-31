import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

// Fixed inert bootstrap: no Pi/provider/project code executes until the parent
// synchronously finishes native admission. execve retains the observed PID and
// Linux start-time incarnation. The release file is NOT custody authority.
const BOOTSTRAP = String.raw`
const fs=require('node:fs'),path=require('node:path');
const [gate,nonce,binary,...args]=process.argv.slice(1);
if(typeof process.execve!=='function'||!path.isAbsolute(gate)||!path.isAbsolute(binary)||!/^[a-f0-9]{64}$/.test(nonce))process.exit(125);
const started=Date.now();
function wait(){
  if(Date.now()-started>=30000)process.exit(124);
  try {
    const fd=fs.openSync(gate,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    let body;try{const s=fs.fstatSync(fd);if(s.nlink===2){setTimeout(wait,10);return}if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&4095)!==384||s.size!==65)process.exit(125);const bytes=Buffer.alloc(65);if(fs.readSync(fd,bytes,0,65,0)!==65)process.exit(125);body=bytes.toString('utf8')}finally{fs.closeSync(fd)}
    if(body!==nonce+'\n')process.exit(125);
    const env={...process.env};if(env.PA_PI_START_NODE_OPTIONS)env.NODE_OPTIONS=env.PA_PI_START_NODE_OPTIONS;else delete env.NODE_OPTIONS;
    delete env.PA_PI_START_NODE_OPTIONS;
    try{process.execve(binary,[binary,...args],env)}catch{process.exit(125)}
  } catch(error) {if(error.code!=='ENOENT')process.exit(125)}
  if(Date.now()-started>=30000)process.exit(124);setTimeout(wait,10);
}wait();`;
export interface RuntimeStartGate {
  readonly file: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  release(): void;
}
export function createRuntimeStartGate(deploymentDirectory: string, args: readonly string[], env: NodeJS.ProcessEnv): RuntimeStartGate {
  const parent = lstatSync(deploymentDirectory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(deploymentDirectory) !== deploymentDirectory || parent.uid !== process.getuid?.()
    || (parent.mode & 0o022) !== 0 || typeof process.execve !== "function") throw new Error("native runtime-start gate unavailable");
  const candidates = (env.PATH ?? "").split(":").filter(isAbsolute).map(root => join(root, "pi"));
  const selected = candidates.find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
  if (!selected) throw new Error("native runtime-start executable unavailable");
  const binary = realpathSync(selected), stat = lstatSync(binary);
  if (!stat.isFile() || (stat.mode & 0o022) !== 0) throw new Error("native runtime-start executable identity rejected");
  const nonce = randomBytes(32).toString("hex"), directory = join(deploymentDirectory, `pi-start-${randomBytes(16).toString("hex")}`);
  mkdirSync(directory, { mode: 0o700 });
  const gate = join(directory, "release");
  const environment: NodeJS.ProcessEnv = { ...env, PA_PI_START_NODE_OPTIONS: env.NODE_OPTIONS ?? "" }; delete environment.NODE_OPTIONS;
  let released = false;
  return { file: process.execPath, args: ["--disable-warning=ExperimentalWarning", "-e", BOOTSTRAP, gate, nonce, binary, ...args], env: environment,
    release() {
      if (released) throw new Error("native runtime-start gate already released");
      const temporary = join(directory, "release.tmp");
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, `${nonce}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      linkSync(temporary, gate); unlinkSync(temporary);
      const dir = openSync(dirname(gate), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(dir); } finally { closeSync(dir); }
      released = true;
    } };
}
