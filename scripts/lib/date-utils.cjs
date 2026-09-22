function createPeriod(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) {
    throw new Error("--month is required and must use YYYY-MM");
  }

  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const start = `${month}-01`;
  const end = `${month}-${String(lastDay).padStart(2, "0")}`;
  const from = `01/${String(monthNumber).padStart(2, "0")}/${year}`;
  const to = `${String(lastDay).padStart(2, "0")}/${String(monthNumber).padStart(2, "0")}/${year}`;

  return Object.freeze({
    label: month,
    start,
    end,
    overviewUrl:
      `https://app.nikatime.com/overview/me?from=${encodeURIComponent(from)}` +
      `&to=${encodeURIComponent(to)}`,
  });
}

function isNikaTimeApiUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname.endsWith("nikatime.com") && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function isOverviewWorkload(rawUrl) {
  try {
    return new URL(rawUrl).pathname === "/api/web/user/workload";
  } catch {
    return false;
  }
}

function isAuthFailure(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body || {});
  return (
    status === 401 ||
    status === 403 ||
    (status === 400 && /authCookie|access_denied/i.test(text)) ||
    /"message"\s*:\s*"access_denied"/i.test(text)
  );
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function weekdays(start, end) {
  const days = [];
  const cursor = new Date(`${start}T12:00:00Z`);
  const finish = new Date(`${end}T12:00:00Z`);
  while (cursor <= finish) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      days.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function datesInRange(start, end) {
  if (!isExactIsoDate(start) || !isExactIsoDate(end) || end < start) return [];
  const dates = [];
  const cursor = new Date(`${start}T12:00:00Z`);
  const finish = new Date(`${end}T12:00:00Z`);
  while (cursor <= finish) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function isExactIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T12:00:00Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function localIsoDate(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

module.exports = {
  createPeriod,
  datesInRange,
  isAuthFailure,
  isExactIsoDate,
  isNikaTimeApiUrl,
  isOverviewWorkload,
  localIsoDate,
  parseMaybeJson,
  weekdays,
};
