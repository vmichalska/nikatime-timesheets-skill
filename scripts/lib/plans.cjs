const { isExactIsoDate, weekdays } = require("./date-utils.cjs");

function validateProjectId(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} projectId must be a non-empty string`);
  }
  return value;
}

function validateHours(value, label) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    throw new Error(`${label} hours must be greater than 0 and no more than 24`);
  }
  return hours;
}

function validateNotes(value, label) {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${label} notes must be a string`);
  }
  return value ?? "";
}

function validateEntry(entry, index, { requireHours, defaultHours }) {
  const label = `Entry ${index + 1}`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${label} must be a JSON object`);
  }
  if (!isExactIsoDate(entry.date)) {
    throw new Error(`${label} date must be a real date formatted YYYY-MM-DD`);
  }
  const projectId = validateProjectId(entry.projectId, label);
  if (requireHours && entry.hours === undefined) {
    throw new Error(`${label} hours are required`);
  }
  const hours = validateHours(entry.hours ?? defaultHours, label);
  const notes = validateNotes(entry.notes, label);
  return { date: entry.date, projectId, hours, notes };
}

function responseSucceeded(response) {
  return (
    response.status >= 200 &&
    response.status < 300 &&
    response.body?.ok !== false
  );
}

function normalizedRecord(record, source) {
  const compactDate = source === "payload" ? record.date : undefined;
  const date = compactDate
    ? `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`
    : record.date;
  return {
    date,
    projectId: String(
      source === "payload" ? record.projectId : record.project_id,
    ),
    hours: Number(Number(record.hours).toFixed(2)),
    notes: String(source === "payload" ? record.notes ?? "" : record.info ?? ""),
  };
}

function recordKey(record) {
  return JSON.stringify([
    record.date,
    record.projectId,
    record.hours.toFixed(2),
    record.notes,
  ]);
}

function comparePlan(workload, plan, { exactDates = false, dates = [] } = {}) {
  const expected = plan.map((record) => normalizedRecord(record, "payload"));
  const relevantDates = new Set([
    ...dates,
    ...expected.map((record) => record.date),
  ]);
  const actual = (workload.records || [])
    .map((record) => normalizedRecord(record, "workload"))
    .filter((record) => relevantDates.has(record.date));
  const remainingCounts = new Map();
  for (const record of actual) {
    const key = recordKey(record);
    remainingCounts.set(key, (remainingCounts.get(key) || 0) + 1);
  }

  const missing = [];
  for (const record of expected) {
    const key = recordKey(record);
    const available = remainingCounts.get(key) || 0;
    if (available === 0) missing.push(record);
    else remainingCounts.set(key, available - 1);
  }

  const unexpected = [];
  if (exactDates) {
    for (const record of actual) {
      const key = recordKey(record);
      const extra = remainingCounts.get(key) || 0;
      if (extra > 0) {
        unexpected.push(record);
        remainingCounts.set(key, extra - 1);
      }
    }
  }
  return {
    ok: missing.length === 0 && unexpected.length === 0,
    expected,
    actual,
    missing,
    unexpected,
  };
}

function summarize(workload, period) {
  const records = Array.isArray(workload.records) ? workload.records : [];
  const hoursByDate = new Map();
  for (const record of records) {
    hoursByDate.set(
      record.date,
      (hoursByDate.get(record.date) || 0) + Number(record.hours || 0),
    );
  }

  const periodWeekdays = weekdays(period.start, period.end);
  const total = periodWeekdays.reduce(
    (sum, date) => sum + (hoursByDate.get(date) || 0),
    0,
  );
  return { records, hoursByDate, periodWeekdays, total };
}

function maxOrderByDate(records) {
  const result = new Map();
  for (const record of records) {
    result.set(
      record.date,
      Math.max(result.get(record.date) ?? -1, Number(record.order ?? -1)),
    );
  }
  return result;
}

function buildPlan(workload, projectId, targetHours, note, selectedDate, period) {
  const { records, hoursByDate, periodWeekdays } = summarize(workload, period);
  const orderByDate = maxOrderByDate(records);
  const targetDates = selectedDate
    ? periodWeekdays.filter((date) => date === selectedDate)
    : periodWeekdays;

  if (selectedDate && targetDates.length === 0) {
    throw new Error(`${selectedDate} is not a weekday in ${period.label}`);
  }

  return targetDates.flatMap((date) => {
    const existing = hoursByDate.get(date) || 0;
    const missing = Number(Math.max(0, targetHours - existing).toFixed(2));
    if (missing === 0) return [];
    return [
      {
        projectId,
        hours: missing,
        // The private endpoint uses compact yyyyMMdd despite its ISO schema.
        date: date.replaceAll("-", ""),
        notes: note,
        order: (orderByDate.get(date) ?? -1) + 1,
        targetUser: workload.userId,
      },
    ];
  });
}

function buildBatchPlan(workload, entries, defaultHours, period) {
  const { records, hoursByDate, periodWeekdays } = summarize(workload, period);
  const weekdaysSet = new Set(periodWeekdays);
  const orderByDate = maxOrderByDate(records);
  const seen = new Set();

  return entries.flatMap((rawEntry, index) => {
    const entry = validateEntry(rawEntry, index, {
      requireHours: false,
      defaultHours,
    });
    if (!weekdaysSet.has(entry.date)) {
      throw new Error(`Invalid ${period.label} weekday: ${entry.date}`);
    }
    if (seen.has(entry.date)) {
      throw new Error(`Duplicate batch date: ${entry.date}`);
    }
    seen.add(entry.date);

    const missing = Number(
      Math.max(0, entry.hours - (hoursByDate.get(entry.date) || 0)).toFixed(2),
    );
    if (missing === 0) return [];
    return [
      {
        projectId: entry.projectId,
        hours: missing,
        date: entry.date.replaceAll("-", ""),
        notes: entry.notes,
        order: (orderByDate.get(entry.date) ?? -1) + 1,
        targetUser: workload.userId,
      },
    ];
  });
}

function replacementPayload(workload, entries, period) {
  const validated = entries.map((entry, index) =>
    validateEntry(entry, index, { requireHours: true }),
  );
  const dates = [...new Set(validated.map((entry) => entry.date))];
  if (dates.length !== 1) {
    throw new Error("replace currently requires exactly one date");
  }
  if (!weekdays(period.start, period.end).includes(dates[0])) {
    throw new Error(`Invalid ${period.label} weekday: ${dates[0]}`);
  }
  const totalHours = validated.reduce((sum, entry) => sum + entry.hours, 0);
  if (totalHours > 24) {
    throw new Error(`Replacement hours total ${totalHours}; the maximum is 24`);
  }
  return validated.map((entry, order) => ({
    projectId: entry.projectId,
    hours: entry.hours,
    date: entry.date.replaceAll("-", ""),
    notes: entry.notes,
    order,
    targetUser: workload.userId,
  }));
}

function backupDate(workload, date) {
  return (workload.records || [])
    .filter((record) => record.date === date)
    .map((record) => ({
      projectId: record.project_id,
      hours: Number(record.hours),
      date: date.replaceAll("-", ""),
      notes: record.info || "",
      order: Number(record.order || 0),
      targetUser: workload.userId,
      ...(record.task_id ? { taskId: record.task_id } : {}),
    }));
}

function expectedAfterAdd(workload, plan) {
  const dates = [
    ...new Set(
      plan.map(
        (record) =>
          `${record.date.slice(0, 4)}-${record.date.slice(4, 6)}-${record.date.slice(6, 8)}`,
      ),
    ),
  ];
  const baseline = dates.flatMap((date) => backupDate(workload, date));
  return { dates, records: [...baseline, ...plan] };
}

function projectNameMap(projects) {
  const map = new Map();
  for (const project of projects) map.set(String(project.id), project.name);
  return map;
}

function describeExistingRecords(workload, nameMap, date) {
  return (workload.records || [])
    .filter((record) => !date || record.date === date)
    .slice()
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .map((record) => ({
      date: record.date,
      projectId: String(record.project_id),
      projectName:
        nameMap.get(String(record.project_id)) ||
        "(project no longer in dropdown)",
      hours: Number(record.hours),
      notes: record.info || "",
    }));
}

function batchSkipWarnings(workload, entries, defaultHours, nameMap, period) {
  const { hoursByDate } = summarize(workload, period);
  const warnings = [];
  entries.forEach((rawEntry, index) => {
    const entry = validateEntry(rawEntry, index, {
      requireHours: false,
      defaultHours,
    });
    const existingHours = hoursByDate.get(entry.date) || 0;
    if (existingHours < entry.hours) return;

    const existingRecords = describeExistingRecords(workload, nameMap, entry.date);
    const alreadyUnderRequestedProject = existingRecords.some(
      (record) => record.projectId === entry.projectId,
    );
    if (alreadyUnderRequestedProject) return;
    warnings.push({
      date: entry.date,
      requestedProjectId: entry.projectId,
      requestedProjectName: nameMap.get(entry.projectId) || "(unknown project)",
      existingHours,
      existingRecords,
    });
  });
  return warnings;
}

module.exports = {
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
  validateNotes,
  validateProjectId,
};
