/** Private bounded Node test events. No report-supplied pass flags accepted. */
export default async function* report(source) {
  for await (const event of source) {
    if (!["test:pass", "test:fail", "test:summary"].includes(event.type)) continue;
    const d = event.data;
    const data = { name: d.name, skip: d.skip, todo: d.todo, file: d.file, success: d.success, counts: d.counts,
      details: d.details ? { type: d.details.type, duration_ms: d.details.duration_ms,
        ...(d.details.error ? { error: { code: d.details.error.code, failureType: d.details.error.failureType, message: String(d.details.error.message ?? "").slice(0, 4096), stack: String(d.details.error.stack ?? "").slice(0, 8192) } } : {}) } : undefined };
    const line = JSON.stringify({ type: event.type, data });
    if (Buffer.byteLength(line) > 32768) throw new Error("qualification event exceeded bound");
    yield `${line}\n`;
  }
}
