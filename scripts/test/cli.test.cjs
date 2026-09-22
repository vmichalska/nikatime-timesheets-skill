const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseArgs,
  validateArgs,
  validateCommand,
} = require("../lib/cli.cjs");
const { createPeriod } = require("../lib/date-utils.cjs");

test("parses the complete fill command", () => {
  assert.deepEqual(
    parseArgs([
      "fill",
      "--month",
      "2026-09",
      "--project-id",
      "project-1",
      "--date",
      "2026-09-22",
      "--hours",
      "7.5",
      "--note",
      "Provided by user",
      "--apply",
    ]),
    {
      command: "fill",
      apply: true,
      headed: false,
      importChrome: false,
      projectId: "project-1",
      month: "2026-09",
      file: undefined,
      date: "2026-09-22",
      hours: 7.5,
      note: "Provided by user",
    },
  );
});

test("default Chrome import remains explicit", () => {
  assert.equal(parseArgs(["show", "--month", "2026-09"]).importChrome, false);
  assert.equal(
    parseArgs(["show", "--month", "2026-09", "--import-chrome"])
      .importChrome,
    true,
  );
});

test("rejects unknown options and invalid hour values", () => {
  assert.throws(() => parseArgs(["show", "--wat"]), /Unknown argument/);
  assert.throws(
    () => parseArgs(["fill", "--hours", "many"]),
    /must be a number/,
  );
  assert.throws(
    () => parseArgs(["fill", "--hours", "25"]),
    /no more than 24/,
  );
});

test("validates command-specific requirements and date boundaries", () => {
  const period = createPeriod("2026-09");
  assert.throws(
    () => validateArgs(parseArgs(["fill", "--month", "2026-09"]), period),
    /requires --project-id/,
  );
  assert.throws(
    () => validateArgs(parseArgs(["batch", "--month", "2026-09"]), period),
    /requires --file/,
  );
  assert.throws(
    () =>
      validateArgs(
        parseArgs(["show", "--month", "2026-09", "--date", "2026-10-01"]),
        period,
      ),
    /must fall within 2026-09/,
  );
});

test("rejects unknown commands before month validation", () => {
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.throws(
      () => validateCommand(parseArgs(["unknown"])),
      /Unknown command: unknown/,
    );
  } finally {
    console.log = originalLog;
  }
});
