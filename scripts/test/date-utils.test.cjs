const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createPeriod,
  datesInRange,
  isAuthFailure,
  isExactIsoDate,
  parseMaybeJson,
  weekdays,
} = require("../lib/date-utils.cjs");

test("creates immutable month periods, including leap years", () => {
  assert.deepEqual(createPeriod("2024-02"), {
    label: "2024-02",
    start: "2024-02-01",
    end: "2024-02-29",
    overviewUrl:
      "https://app.nikatime.com/overview/me?from=01%2F02%2F2024&to=29%2F02%2F2024",
  });
  assert.throws(() => createPeriod("2026-13"), /must use YYYY-MM/);
  assert.equal(Object.isFrozen(createPeriod("2026-09")), true);
});

test("date helpers reject impossible dates and omit weekends", () => {
  assert.equal(isExactIsoDate("2026-02-29"), false);
  assert.equal(isExactIsoDate("2024-02-29"), true);
  assert.deepEqual(weekdays("2026-09-04", "2026-09-07"), [
    "2026-09-04",
    "2026-09-07",
  ]);
  assert.deepEqual(datesInRange("2026-09-29", "2026-10-01"), [
    "2026-09-29",
    "2026-09-30",
    "2026-10-01",
  ]);
});

test("auth failures recognize status codes and API error bodies", () => {
  assert.equal(isAuthFailure(401, {}), true);
  assert.equal(isAuthFailure(400, { message: "access_denied" }), true);
  assert.equal(isAuthFailure(500, { message: "server error" }), false);
});

test("JSON parsing preserves non-JSON response text", () => {
  assert.deepEqual(parseMaybeJson('{"ok":true}'), { ok: true });
  assert.equal(parseMaybeJson("gateway unavailable"), "gateway unavailable");
});
