import { getDb } from "../../registry/db.js";
import { shortlistFixture } from "../auto-shortlist-fixture.js";
const db = getDb(process.argv[2]!);
try {
  const f = shortlistFixture(db);
  if (process.argv[3] === "reasoning") f.store.reserve(f.input, f.host);
  else if (process.argv[3] === "choice") {
    const head = f.store.head()!; Object.assign(f.context, f.store.cycle(head.cycleId).context);
    f.setNow("2026-11-14T03:02:00.000Z"); await f.store.choose(head.version, f.host);
  }
  else { const entry = f.snapshot.entries[0]!; f.store.items.select(entry, "/synthetic/runtime", () => entry, () => {}); }
  process.exitCode = 0;
} catch { process.exitCode = 2; }
finally { db.close(); }
