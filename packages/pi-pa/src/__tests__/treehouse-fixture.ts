import { TreehouseClient as RuntimeTreehouseClient, SUPPORTED_TREEHOUSE_VERSION, type TreehouseClientOptions } from "../treehouse.js";

/** Existing JSON/admission fixtures supply the declared version; preflight failure
 * and executable selection are exercised separately in treehouse-runtime.test.ts. */
export class TreehouseClient extends RuntimeTreehouseClient {
  constructor(options: TreehouseClientOptions = {}) {
    const run = options.run;
    super(run ? { ...options, run: (args, cwd) => args[0] === "--version"
      ? { status: 0, stdout: Buffer.from(`v${SUPPORTED_TREEHOUSE_VERSION}\n`), stderr: Buffer.alloc(0) }
      : run(args, cwd) } : options);
  }
}
