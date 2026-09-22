const fs = require("node:fs");
const path = require("node:path");

const { isAuthFailure } = require("./date-utils.cjs");
const { createNikaTimeClient, isValidWorkloadResult } = require("./nikatime-api.cjs");
const {
  establishBrowserSession,
  persistSessionCookie,
  printCookieMetadata,
  printDirectCookieMetadata,
  renewCookieViaBrowser,
} = require("./nikatime-session.cjs");
const {
  backupDate,
  batchSkipWarnings,
  buildBatchPlan,
  buildPlan,
  comparePlan,
  describeExistingRecords,
  expectedAfterAdd,
  projectNameMap,
  replacementPayload,
  responseSucceeded,
  summarize,
  validateEntry,
  validateHours,
} = require("./plans.cjs");

function printWorkloadSummary(workload, period) {
  const summary = summarize(workload, period);
  const configuredTarget = Number(workload.workdayDuration || 8);
  validateHours(configuredTarget, "NikaTime workdayDuration");
  console.log(`${period.label} summary:`, {
    userId: workload.userId,
    name: workload.name,
    weekdays: summary.periodWeekdays.length,
    enteredHours: summary.total,
    workdayDuration: configuredTarget,
    expectedHours: summary.periodWeekdays.length * configuredTarget,
  });
  return { configuredTarget, summary };
}

function createSessionController(
  period,
  client,
  initialSession,
  {
    renewCookie = renewCookieViaBrowser,
    persistCookie = persistSessionCookie,
  } = {},
) {
  const session = {
    cookie: initialSession.cookie || null,
    source: initialSession.source,
  };

  async function renew() {
    session.cookie = await renewCookie(period);
    session.source = "browser-profile";
    return session.cookie;
  }

  async function ensureWorkload() {
    if (session.cookie) {
      const probe = await client.directWorkloadOnce(session.cookie.value);
      if (isValidWorkloadResult(probe)) {
        if (session.source === "default-chrome") persistCookie(session.cookie);
        return probe.body.result;
      }
    }

    await renew();
    const result = await client.directWorkloadOnce(session.cookie.value);
    if (!isValidWorkloadResult(result)) {
      throw new Error(
        `Could not load ${period.label} workload (HTTP ${result.status}): ` +
          JSON.stringify(result.body),
      );
    }
    return result.body.result;
  }

  return { ensureWorkload, renew, session };
}

async function withAuthRetry(controller, operation) {
  let result = await operation();
  if (isAuthFailure(result.status, result.body)) {
    await controller.renew();
    result = await operation();
  }
  return result;
}

function readManifest(file, label, { requireEntries = false } = {}) {
  const entries = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  if (!Array.isArray(entries) || (requireEntries && entries.length === 0)) {
    throw new Error(
      requireEntries
        ? `${label} file must contain entries`
        : `${label} file must contain a JSON array`,
    );
  }
  return entries;
}

async function fetchProjectList(client, cookieValue, userId) {
  const dropdown = await client.directDropdown(cookieValue, userId);
  if (
    dropdown.status < 200 ||
    dropdown.status >= 300 ||
    dropdown.body?.ok === false
  ) {
    throw new Error(
      `Could not list projects (HTTP ${dropdown.status}): ${JSON.stringify(dropdown.body)}`,
    );
  }

  const projects = [];
  for (const group of dropdown.body?.result || []) {
    for (const [key, value] of Object.entries(group.options || {})) {
      projects.push({
        group: group.header,
        id: value.id || key,
        name: value.name,
        timeOff: value.pto,
      });
    }
  }
  return projects;
}

async function runProjects({ client, controller, workload }) {
  const projects = await fetchProjectList(
    client,
    controller.session.cookie.value,
    workload.userId,
  );
  console.log(JSON.stringify(projects, null, 2));
}

async function runShow({ args, client, controller, period, workload }) {
  const projects = await fetchProjectList(
    client,
    controller.session.cookie.value,
    workload.userId,
  );
  const nameMap = projectNameMap(projects);

  if (args.date) {
    const records = describeExistingRecords(workload, nameMap, args.date);
    const totalHours = records.reduce((sum, record) => sum + record.hours, 0);
    console.log(JSON.stringify({ date: args.date, totalHours, records }, null, 2));
    return;
  }

  const { periodWeekdays } = summarize(workload, period);
  const allRecords = describeExistingRecords(workload, nameMap);
  const recordsByDate = new Map();
  for (const record of allRecords) {
    if (!recordsByDate.has(record.date)) recordsByDate.set(record.date, []);
    recordsByDate.get(record.date).push(record);
  }
  const days = periodWeekdays.map((date) => {
    const records = recordsByDate.get(date) || [];
    return {
      date,
      totalHours: records.reduce((sum, record) => sum + record.hours, 0),
      records,
    };
  });
  console.log(JSON.stringify({ month: period.label, days }, null, 2));
}

async function runBatch({
  args,
  client,
  configuredTarget,
  controller,
  period,
  workload,
}) {
  const entries = readManifest(args.file, "Batch");
  const projects = await fetchProjectList(
    client,
    controller.session.cookie.value,
    workload.userId,
  );
  const warnings = batchSkipWarnings(
    workload,
    entries,
    configuredTarget,
    projectNameMap(projects),
    period,
  );
  if (warnings.length > 0) {
    console.warn(
      "WARNING: batch fills hour gaps only and cannot relabel a date that is already full under a " +
        "different project. The following dates already have their target hours entered under a " +
        "different project and will be left untouched. Use `replace` for these dates instead:",
    );
    console.warn(JSON.stringify(warnings, null, 2));
  }

  const plan = buildBatchPlan(workload, entries, configuredTarget, period);
  const expectedState = expectedAfterAdd(workload, plan);
  console.log(
    JSON.stringify(
      { dryRun: !args.apply, recordCount: plan.length, records: plan },
      null,
      2,
    ),
  );
  if (!args.apply || plan.length === 0) {
    console.log(
      args.apply
        ? "Nothing to add."
        : "Dry run only; no NikaTime records were changed.",
    );
    return;
  }

  const submission = await withAuthRetry(controller, () =>
    client.submitPlan(controller.session.cookie.value, plan),
  );
  if (!responseSucceeded(submission)) {
    throw new Error(
      `NikaTime rejected the batch (HTTP ${submission.status}): ${JSON.stringify(submission.body)}`,
    );
  }

  const verified = await controller.ensureWorkload();
  const remaining = buildBatchPlan(verified, entries, configuredTarget, period);
  const comparison = comparePlan(verified, expectedState.records, {
    exactDates: true,
    dates: expectedState.dates,
  });
  console.log("Verification:", {
    remainingRecords: remaining.length,
    exactRecordsPresent: comparison.ok,
  });
  if (remaining.length || !comparison.ok) {
    throw new Error(
      `Batch verification mismatch: ${JSON.stringify({ remaining, comparison })}`,
    );
  }
}

async function restoreDate(
  controller,
  client,
  workload,
  date,
  backup,
) {
  try {
    const current = await controller.ensureWorkload();
    const currentComparison = comparePlan(current, backup, {
      exactDates: true,
      dates: [date],
    });
    if (currentComparison.ok) return { restored: true };

    let cleanup = await client.deleteDates(
      controller.session.cookie.value,
      [date],
      workload.userId,
    );
    if (isAuthFailure(cleanup.status, cleanup.body)) {
      await controller.ensureWorkload();
      cleanup = await client.deleteDates(
        controller.session.cookie.value,
        [date],
        workload.userId,
      );
    }
    if (!responseSucceeded(cleanup)) {
      return {
        restored: false,
        error: `cleanup failed (HTTP ${cleanup.status}): ${JSON.stringify(cleanup.body)}`,
      };
    }

    if (backup.length > 0) {
      let restoration = await client.submitPlan(
        controller.session.cookie.value,
        backup,
      );
      if (isAuthFailure(restoration.status, restoration.body)) {
        await controller.ensureWorkload();
        const renewedCleanup = await client.deleteDates(
          controller.session.cookie.value,
          [date],
          workload.userId,
        );
        if (!responseSucceeded(renewedCleanup)) {
          return {
            restored: false,
            error:
              `renewed cleanup failed (HTTP ${renewedCleanup.status}): ` +
              JSON.stringify(renewedCleanup.body),
          };
        }
        restoration = await client.submitPlan(
          controller.session.cookie.value,
          backup,
        );
      }
      if (!responseSucceeded(restoration)) {
        return {
          restored: false,
          error: `restore failed (HTTP ${restoration.status}): ${JSON.stringify(restoration.body)}`,
        };
      }
    }

    const verified = await controller.ensureWorkload();
    const comparison = comparePlan(verified, backup, {
      exactDates: true,
      dates: [date],
    });
    if (!comparison.ok) {
      return {
        restored: false,
        error: `restore verification mismatch: ${JSON.stringify(comparison)}`,
      };
    }
    return { restored: true };
  } catch (error) {
    return { restored: false, error: error.message || String(error) };
  }
}

async function runReplace({ args, client, controller, period, workload }) {
  const entries = readManifest(args.file, "Replacement", {
    requireEntries: true,
  });
  const plan = replacementPayload(workload, entries, period);
  const date = entries[0].date;
  const backup = backupDate(workload, date);
  console.log(
    JSON.stringify(
      { dryRun: !args.apply, date, previous: backup, replacement: plan },
      null,
      2,
    ),
  );
  if (!args.apply) {
    console.log("Dry run only; no NikaTime records were changed.");
    return;
  }

  let comparison;
  try {
    const deletion = await withAuthRetry(controller, () =>
      client.deleteDates(
        controller.session.cookie.value,
        [date],
        workload.userId,
      ),
    );
    if (!responseSucceeded(deletion)) {
      throw new Error(
        `NikaTime rejected the date deletion (HTTP ${deletion.status}): ${JSON.stringify(deletion.body)}`,
      );
    }

    const submission = await withAuthRetry(controller, () =>
      client.submitPlan(controller.session.cookie.value, plan),
    );
    if (!responseSucceeded(submission)) {
      throw new Error(
        `NikaTime rejected the replacement (HTTP ${submission.status}): ${JSON.stringify(submission.body)}`,
      );
    }

    const verified = await controller.ensureWorkload();
    comparison = comparePlan(verified, plan, {
      exactDates: true,
      dates: [date],
    });
    if (!comparison.ok) {
      throw new Error(
        `Replacement verification mismatch: ${JSON.stringify(comparison)}`,
      );
    }
  } catch (error) {
    const restoration = await restoreDate(
      controller,
      client,
      workload,
      date,
      backup,
    );
    if (restoration.restored) {
      throw new Error(
        `${error.message || error}; previous records were verified restored.`,
      );
    }
    throw new Error(
      `URGENT: replacement and automatic restoration both failed for ${date}. ` +
        `Review NikaTime manually. Cause: ${error.message || error}; ` +
        `restoration: ${restoration.error}`,
    );
  }

  console.log("Verification:", {
    date,
    records: comparison.actual,
    totalHours: plan.reduce((sum, entry) => sum + entry.hours, 0),
  });
}

async function runFill({
  args,
  client,
  configuredTarget,
  controller,
  period,
  workload,
}) {
  const targetHours = args.hours ?? configuredTarget;
  validateHours(targetHours, "fill");
  const build = (currentWorkload) =>
    buildPlan(
      currentWorkload,
      args.projectId,
      targetHours,
      args.note,
      args.date,
      period,
    );
  const plan = build(workload);
  const plannedHours = plan.reduce((sum, record) => sum + record.hours, 0);
  console.log(
    JSON.stringify(
      {
        dryRun: !args.apply,
        projectId: args.projectId,
        targetHours,
        recordCount: plan.length,
        plannedHours,
        records: plan,
      },
      null,
      2,
    ),
  );

  if (!args.apply || plan.length === 0) {
    console.log(
      args.apply
        ? "Nothing to add."
        : "Dry run only; no NikaTime records were changed.",
    );
    return;
  }

  let appliedPlan = plan;
  let appliedBaseline = workload;
  const submission = await client.submitPlan(
    controller.session.cookie.value,
    plan,
  );
  if (isAuthFailure(submission.status, submission.body)) {
    console.log("Session expired before submission; renewing and rebuilding the plan.");
    await controller.renew();
    const refreshed = await controller.ensureWorkload();
    const refreshedPlan = build(refreshed);
    appliedPlan = refreshedPlan;
    appliedBaseline = refreshed;
    const retry = await client.submitPlan(
      controller.session.cookie.value,
      refreshedPlan,
    );
    if (!responseSucceeded(retry)) {
      throw new Error(
        `NikaTime rejected the renewed submission (HTTP ${retry.status}): ${JSON.stringify(retry.body)}`,
      );
    }
  } else if (!responseSucceeded(submission)) {
    throw new Error(
      `NikaTime rejected the submission (HTTP ${submission.status}): ${JSON.stringify(submission.body)}`,
    );
  }

  const verified = await controller.ensureWorkload();
  const remaining = build(verified);
  const remainingHours = remaining.reduce((sum, record) => sum + record.hours, 0);
  const expectedState = expectedAfterAdd(appliedBaseline, appliedPlan);
  const comparison = comparePlan(verified, expectedState.records, {
    exactDates: true,
    dates: expectedState.dates,
  });
  console.log("Verification:", {
    remainingWeekdays: remaining.length,
    remainingHours,
    exactRecordsPresent: comparison.ok,
  });
  if (remaining.length !== 0 || !comparison.ok) {
    process.exitCode = 2;
    console.error(
      `Verification mismatch for ${period.label}: ${JSON.stringify(comparison)}. ` +
        "Review the calendar before rerunning.",
    );
  }
}

async function runInspect(args, initialSession, period) {
  const client = createNikaTimeClient(period);
  let seedCookie = initialSession.cookie;
  if (seedCookie) {
    const probe = await client.directWorkloadOnce(seedCookie.value);
    if (!isValidWorkloadResult(probe)) seedCookie = null;
  }

  const { context, apiCalls, workload } = await establishBrowserSession(
    period,
    seedCookie,
    { forceHeaded: args.headed },
  );
  try {
    const cookie = await printCookieMetadata(context);
    if (cookie) persistSessionCookie(cookie);
    printWorkloadSummary(workload, period);
    console.log("Observed NikaTime API calls (cookies and headers omitted):");
    console.log(JSON.stringify(apiCalls, null, 2));
  } finally {
    await context.close();
  }
}

async function runDirectCommand(args, initialSession, period) {
  const client = createNikaTimeClient(period);
  const controller = createSessionController(period, client, initialSession);
  const workload = await controller.ensureWorkload();
  printDirectCookieMetadata(controller.session);
  const { configuredTarget } = printWorkloadSummary(workload, period);
  const context = {
    args,
    client,
    configuredTarget,
    controller,
    period,
    workload,
  };

  const handlers = {
    projects: runProjects,
    show: runShow,
    batch: runBatch,
    replace: runReplace,
    fill: runFill,
  };
  await handlers[args.command](context);
}

module.exports = {
  createSessionController,
  fetchProjectList,
  readManifest,
  runDirectCommand,
  runInspect,
  withAuthRetry,
};
