// Opt-in local projection only. Raw names, output and exception bodies stay out.
const number = value => Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) / 1000 : null;
export function projectCase(event, ordinal) {
  const d = event.data;
  return { event: 'case-end', case: ordinal, outcome: d.skip ? 'skipped' : d.todo ? 'todo' : d.details?.error?.failureType === 'cancelledByParent' ? 'cancelled' : event.type === 'test:fail' ? 'failed' : 'passed',
    line: number(d.line), column: number(d.column), durationMs: number(d.details?.duration_ms) };
}
export default async function* report(source) {
  let ordinal = 0, failureDetails = 0;
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0 }, slowest = [];
  for await (const event of source) {
    if (!['test:pass', 'test:fail'].includes(event.type)) continue;
    // Suite wrappers are not additional cases.
    if (event.data.details?.type === 'suite') continue;
    const record = projectCase(event, ++ordinal);
    counts[record.outcome]++;
    slowest.push(record);
    slowest.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
    slowest.length = Math.min(slowest.length, 5);
    if (record.outcome === 'failed' && failureDetails++ < 20) yield `${JSON.stringify(record)}\n`;
  }
  yield `${JSON.stringify({ event: 'cases-end', counts, failureDetailsOmitted: Math.max(0, counts.failed - 20), slowest })}\n`;
}
