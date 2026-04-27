import test from "node:test";
import assert from "node:assert/strict";
import { formatLocalShort, nowUtc, parseTimestamp } from "../time.js";

test("nowUtc stores UTC ISO with Z suffix", () => {
  const value = nowUtc(new Date("2026-04-27T07:41:10.123Z"));
  assert.equal(value, "2026-04-27T07:41:10.123Z");
  assert.match(value, /Z$/);
});

test("parseTimestamp accepts UTC and legacy local-offset timestamps", () => {
  const utc = parseTimestamp("2026-04-27T07:41:10.000Z");
  const localOffset = parseTimestamp("2026-04-27T14:41:10+07:00");
  assert.equal(utc.getTime(), localOffset.getTime());
  assert.throws(() => parseTimestamp("not-a-date"), RangeError);
});

test("formatLocalShort renders the host local offset", () => {
  const previousTz = process.env["TZ"];
  try {
    process.env["TZ"] = "UTC";
    assert.equal(formatLocalShort("2026-04-27T07:41:10.000Z"), "2026-04-27 07:41:10 +00:00");

    process.env["TZ"] = "Asia/Bangkok";
    assert.equal(formatLocalShort("2026-04-27T07:41:10.000Z"), "2026-04-27 14:41:10 +07:00");

    process.env["TZ"] = "Asia/Kathmandu";
    assert.equal(formatLocalShort("2026-04-27T07:41:10.000Z"), "2026-04-27 13:26:10 +05:45");
  } finally {
    if (previousTz === undefined) delete process.env["TZ"];
    else process.env["TZ"] = previousTz;
  }
});
