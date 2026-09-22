const assert = require("node:assert/strict");
const test = require("node:test");

const { createPeriod } = require("../lib/date-utils.cjs");
const {
  backupDate,
  batchSkipWarnings,
  buildBatchPlan,
  buildPlan,
  comparePlan,
  expectedAfterAdd,
  projectNameMap,
  replacementPayload,
  summarize,
  validateEntry,
} = require("../lib/plans.cjs");

const period = createPeriod("2026-09");

function workload(records = []) {
  return {
    userId: "user-1",
    workdayDuration: 8,
    records,
  };
}

function record(date, projectId, hours, order = 0, info = "") {
  return {
    date,
    project_id: projectId,
    hours,
    order,
    info,
  };
}

test("summarizes only the selected period", () => {
  const summary = summarize(
    workload([
      record("2026-09-01", "a", 4),
      record("2026-09-01", "b", 2),
      record("2026-10-01", "a", 8),
    ]),
    period,
  );

  assert.equal(summary.periodWeekdays.length, 22);
  assert.equal(summary.hoursByDate.get("2026-09-01"), 6);
  assert.equal(summary.total, 6);
});

test("fill planning adds only the missing hours with the next order", () => {
  const current = workload([
    record("2026-09-01", "existing", 3, 0),
    record("2026-09-01", "existing-2", 1.5, 2),
  ]);
  assert.deepEqual(
    buildPlan(current, "target", 8, "", "2026-09-01", period),
    [
      {
        projectId: "target",
        hours: 3.5,
        date: "20260901",
        notes: "",
        order: 3,
        targetUser: "user-1",
      },
    ],
  );
  assert.throws(
    () => buildPlan(current, "target", 8, "", "2026-09-05", period),
    /not a weekday/,
  );
});

test("batch planning validates dates, defaults hours, and rejects duplicates", () => {
  const current = workload([record("2026-09-01", "existing", 2)]);
  const plan = buildBatchPlan(
    current,
    [
      { date: "2026-09-01", projectId: "target" },
      { date: "2026-09-02", projectId: "target", hours: 6 },
    ],
    8,
    period,
  );
  assert.deepEqual(plan.map(({ date, hours, notes }) => ({ date, hours, notes })), [
    { date: "20260901", hours: 6, notes: "" },
    { date: "20260902", hours: 6, notes: "" },
  ]);
  assert.throws(
    () =>
      buildBatchPlan(
        current,
        [
          { date: "2026-09-02", projectId: "target" },
          { date: "2026-09-02", projectId: "target" },
        ],
        8,
        period,
      ),
    /Duplicate batch date/,
  );
});

test("replacement planning requires one weekday and no more than 24 hours", () => {
  const current = workload();
  assert.deepEqual(
    replacementPayload(
      current,
      [
        { date: "2026-09-22", projectId: "a", hours: 3 },
        { date: "2026-09-22", projectId: "b", hours: 5 },
      ],
      period,
    ).map(({ projectId, hours, order, notes }) => ({
      projectId,
      hours,
      order,
      notes,
    })),
    [
      { projectId: "a", hours: 3, order: 0, notes: "" },
      { projectId: "b", hours: 5, order: 1, notes: "" },
    ],
  );
  assert.throws(
    () =>
      replacementPayload(
        current,
        [{ date: "2026-09-20", projectId: "a", hours: 8 }],
        period,
      ),
    /Invalid 2026-09 weekday/,
  );
  assert.throws(
    () =>
      replacementPayload(
        current,
        [
          { date: "2026-09-22", projectId: "a", hours: 13 },
          { date: "2026-09-22", projectId: "b", hours: 12 },
        ],
        period,
      ),
    /maximum is 24/,
  );
});

test("exact comparison detects missing, extra, and duplicate records", () => {
  const current = workload([
    record("2026-09-22", "a", 4),
    record("2026-09-22", "a", 4, 1),
  ]);
  const expected = [
    {
      date: "20260922",
      projectId: "a",
      hours: 4,
      notes: "",
      order: 0,
      targetUser: "user-1",
    },
  ];
  assert.equal(comparePlan(current, expected).ok, true);
  const exact = comparePlan(current, expected, {
    exactDates: true,
    dates: ["2026-09-22"],
  });
  assert.equal(exact.ok, false);
  assert.equal(exact.unexpected.length, 1);
});

test("backup and expected state preserve existing records", () => {
  const current = workload([
    { ...record("2026-09-22", "old", 2, 0, "user note"), task_id: "task-1" },
  ]);
  const backup = backupDate(current, "2026-09-22");
  assert.deepEqual(backup[0], {
    projectId: "old",
    hours: 2,
    date: "20260922",
    notes: "user note",
    order: 0,
    targetUser: "user-1",
    taskId: "task-1",
  });
  const added = {
    projectId: "new",
    hours: 6,
    date: "20260922",
    notes: "",
    order: 1,
    targetUser: "user-1",
  };
  assert.deepEqual(expectedAfterAdd(current, [added]), {
    dates: ["2026-09-22"],
    records: [...backup, added],
  });
});

test("batch warns when a full day is under a different project", () => {
  const current = workload([record("2026-09-22", "wrong", 8)]);
  const names = projectNameMap([
    { id: "wrong", name: "Wrong" },
    { id: "right", name: "Right" },
  ]);
  const warnings = batchSkipWarnings(
    current,
    [{ date: "2026-09-22", projectId: "right" }],
    8,
    names,
    period,
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].requestedProjectName, "Right");
  assert.equal(warnings[0].existingRecords[0].projectName, "Wrong");
});

test("entry validation rejects invalid shapes and preserves explicit notes", () => {
  assert.throws(
    () => validateEntry([], 0, { requireHours: false, defaultHours: 8 }),
    /must be a JSON object/,
  );
  assert.deepEqual(
    validateEntry(
      {
        date: "2026-09-22",
        projectId: "project",
        hours: 8,
        notes: "User supplied",
      },
      0,
      { requireHours: true },
    ),
    {
      date: "2026-09-22",
      projectId: "project",
      hours: 8,
      notes: "User supplied",
    },
  );
});
