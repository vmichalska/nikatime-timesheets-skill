#!/usr/bin/env node

/*
 * NikaTime timesheet helper.
 *
 * - Reuses NikaTime's HttpOnly authCookie from a private local session cache
 *   and talks to the API directly (no browser) whenever that session is valid.
 * - Recovers or renews the session through a dedicated Chrome profile, then
 *   persists the refreshed cookie with owner-only permissions for later runs.
 * - Imports the default Chrome profile only when explicitly requested, since
 *   decrypting that profile can trigger a macOS Keychain password prompt.
 * - `inspect` always drives a real browser: its purpose is discovering the
 *   actual API calls the Overview page makes, which requires watching real
 *   network traffic.
 * - `vacations` snapshots Chrome local storage and reads approved Vacation
 *   Tracker leave through its first-party GraphQL API. Playwright is used only
 *   if direct Cognito token renewal cannot recover the session.
 * - Defaults to a dry run. It writes records only with --apply.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

function loadPlaywright() {
  const candidates = [
    process.env.NIKATIME_PLAYWRIGHT_PATH,
    "playwright",
    path.join(__dirname, "node_modules", "playwright"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }

  throw new Error(
    "Playwright is unavailable. Set NIKATIME_PLAYWRIGHT_PATH or install Playwright locally.",
  );
}

function loadClassicLevel() {
  const candidates = [
    process.env.NIKATIME_CLASSIC_LEVEL_PATH,
    "classic-level",
    path.join(__dirname, "node_modules", "classic-level"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const loaded = require(candidate);
      return loaded.ClassicLevel || loaded;
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }

  throw new Error(
    "classic-level is unavailable. Run `cd scripts && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev`.",
  );
}

let PERIOD_START;
let PERIOD_END;
let OVERVIEW_URL;
let PERIOD_LABEL;
const API_ORIGIN = "https://app.nikatime.com";
const SLACK_LOGIN_URL = "https://app.nikatime.com/auth/v3/slack-login";
const VACATION_TRACKER_ORIGIN = "https://app.vacationtracker.io";
const VACATION_TRACKER_PROFILE_URL =
  `${VACATION_TRACKER_ORIGIN}/app/my-profile?activeTab=leaves`;
const VACATION_TRACKER_GRAPHQL_URL =
  "https://graphql.app.vacationtracker.io/graphql";
const NIKATIME_STATE_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "nikatime-timesheets",
);
const PROFILE_DIR =
  process.env.NIKATIME_BROWSER_PROFILE ||
  path.join(NIKATIME_STATE_DIR, "chrome-profile");
const SESSION_CACHE_PATH =
  process.env.NIKATIME_SESSION_CACHE ||
  path.join(NIKATIME_STATE_DIR, "session.json");
const SESSION_CACHE_VERSION = 1;
const VACATION_TRACKER_PROFILE_DIR =
  process.env.VACATIONTRACKER_BROWSER_PROFILE ||
  path.join(
    os.homedir(),
    ".local",
    "share",
    "nikatime-timesheets",
    "vacationtracker-chrome-profile",
  );
const SOURCE_CHROME_COOKIE_DB =
  process.env.NIKATIME_CHROME_COOKIE_DB ||
  path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "Default",
    "Cookies",
  );
const SOURCE_CHROME_LOCAL_STORAGE =
  process.env.VACATIONTRACKER_CHROME_LOCAL_STORAGE ||
  path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "Default",
    "Local Storage",
    "leveldb",
  );

function usage() {
  console.log(`Usage:
  node nikatime.cjs inspect --month YYYY-MM
  node nikatime.cjs projects --month YYYY-MM
  node nikatime.cjs show --month YYYY-MM [--date YYYY-MM-DD]
  node nikatime.cjs vacations --month YYYY-MM
  node nikatime.cjs batch --month YYYY-MM --file ENTRIES.json [--apply]
  node nikatime.cjs replace --month YYYY-MM --file ENTRIES.json [--apply]
  node nikatime.cjs fill --month YYYY-MM --project-id PROJECT_ID [--date YYYY-MM-DD] [--hours 8] [--note TEXT] [--apply]

Commands:
  inspect   Sign in if needed and summarize the month without writing anything.
  projects  List project IDs available to the month's entry form.
  show      Print the records already on file for one date, or every date in
            the month, with project names resolved. Read-only; never opens a
            browser beyond normal session renewal. Run this before batch or
            replace to see what is already there.
  vacations Read the signed-in user's approved Vacation Tracker leave for the
            month, including exact full-day and partial-day hours. Read-only.
  batch     Fill dates from a JSON array. Dry-run unless --apply is present.
  replace   Preview or replace all records on the manifest's single date.
  fill      Calculate gaps for the month's weekdays. Dry-run unless --apply is present.

Options:
  --project-id ID  NikaTime project ID to receive the missing hours.
  --month MONTH      Required month, formatted YYYY-MM.
  --date DATE       Limit the plan to one date, formatted YYYY-MM-DD.
  --hours NUMBER   Daily target. Defaults to NikaTime's workdayDuration.
  --note TEXT      Optional note added to every new record.
  --apply          Submit the planned records, then reload and verify.
  --headed         For inspect only: force a visible Chrome window even if
                   the session looks valid.
  --import-chrome  Explicitly import NikaTime's session from the default Chrome
                   profile. This can trigger a macOS Keychain password prompt.

projects, show, batch, replace, and fill talk to NikaTime directly over HTTPS
using an authCookie kept in a private owner-only session cache. On a cache miss,
a dedicated reusable Chrome profile recovers the session headlessly; a visible
window opens only if Slack login is required. Importing the default Chrome
profile is opt-in because its Safe Storage key can prompt for the macOS
password. inspect always opens the dedicated Chrome profile (headless by
default, visible if renewal is needed or --headed is passed), since discovering
the live API calls requires watching real browser network traffic.

vacations reads Vacation Tracker's Cognito session from a snapshot of Chrome's
local storage, refreshes it directly when needed, and queries the first-party
GraphQL API over HTTPS. It uses Playwright only as a last-resort login fallback.`);
}

function parseArgs(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { command: "inspect", help: true };
  }
  const result = {
    command: argv[0] || "inspect",
    apply: false,
    headed: false,
    importChrome: false,
    projectId: undefined,
    month: undefined,
    file: undefined,
    date: undefined,
    hours: undefined,
    note: "",
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") result.apply = true;
    else if (arg === "--headed") result.headed = true;
    else if (arg === "--import-chrome") result.importChrome = true;
    else if (arg === "--project-id") result.projectId = argv[++index];
    else if (arg === "--month") result.month = argv[++index];
    else if (arg === "--file") result.file = argv[++index];
    else if (arg === "--date") result.date = argv[++index];
    else if (arg === "--hours") result.hours = Number(argv[++index]);
    else if (arg === "--note") result.note = argv[++index];
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(result.hours) && result.hours !== undefined) {
    throw new Error("--hours must be a number");
  }
  if (result.hours !== undefined && (result.hours <= 0 || result.hours > 24)) {
    throw new Error("--hours must be greater than 0 and no more than 24");
  }
  if (result.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(result.date)) {
    throw new Error("--date must use YYYY-MM-DD");
  }
  return result;
}

function configurePeriod(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) {
    throw new Error("--month is required and must use YYYY-MM");
  }
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  PERIOD_START = `${month}-01`;
  PERIOD_END = `${month}-${String(lastDay).padStart(2, "0")}`;
  PERIOD_LABEL = month;
  const from = `01/${String(monthNumber).padStart(2, "0")}/${year}`;
  const to = `${String(lastDay).padStart(2, "0")}/${String(monthNumber).padStart(2, "0")}/${year}`;
  OVERVIEW_URL = `https://app.nikatime.com/overview/me?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

function isNikaTimeApiUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.hostname.endsWith("nikatime.com") && url.pathname.startsWith("/api/")
    );
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

function isExactIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function localIsoDate(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function decodeChromeLocalStorageValue(value) {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new Error("Chrome local storage contained an empty value");
  }
  if (value[0] === 0) return value.subarray(1).toString("utf16le");
  if (value[0] === 1) return value.subarray(1).toString("utf8");
  throw new Error(`Unsupported Chrome local-storage encoding: ${value[0]}`);
}

function vacationTrackerSessionFromStorage(entries) {
  const clientIds = new Set();
  for (const key of entries.keys()) {
    const match = key.match(
      /^CognitoIdentityServiceProvider\.([^.]+)\.LastAuthUser$/,
    );
    if (match) clientIds.add(match[1]);
  }

  for (const clientId of clientIds) {
    const username = entries.get(
      `CognitoIdentityServiceProvider.${clientId}.LastAuthUser`,
    );
    if (!username) continue;
    const tokenPrefix = `CognitoIdentityServiceProvider.${clientId}.${username}`;
    const idToken = entries.get(`${tokenPrefix}.idToken`);
    const refreshToken = entries.get(`${tokenPrefix}.refreshToken`);
    if (idToken) {
      return { clientId, username, idToken, refreshToken, source: "chrome-local-storage" };
    }
  }

  throw new Error(
    `No Vacation Tracker Cognito session was found in Chrome. Sign in at ${VACATION_TRACKER_PROFILE_URL} and rerun.`,
  );
}

async function readVacationTrackerChromeSession() {
  if (!fs.existsSync(SOURCE_CHROME_LOCAL_STORAGE)) {
    throw new Error(`Chrome local storage was not found at ${SOURCE_CHROME_LOCAL_STORAGE}`);
  }

  const ClassicLevel = loadClassicLevel();
  const snapshotDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vacationtracker-local-storage-"),
  );
  let database;
  try {
    fs.cpSync(SOURCE_CHROME_LOCAL_STORAGE, snapshotDir, { recursive: true });
    try {
      fs.unlinkSync(path.join(snapshotDir, "LOCK"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    database = new ClassicLevel(snapshotDir, {
      keyEncoding: "buffer",
      valueEncoding: "buffer",
      readOnly: true,
    });
    await database.open();

    const storagePrefix = `_${VACATION_TRACKER_ORIGIN}\0\x01`;
    const entries = new Map();
    for await (const [rawKey, rawValue] of database.iterator()) {
      const key = rawKey.toString("utf8");
      if (!key.startsWith(storagePrefix)) continue;
      const localStorageKey = key.slice(storagePrefix.length);
      if (!localStorageKey.startsWith("CognitoIdentityServiceProvider.")) continue;
      entries.set(localStorageKey, decodeChromeLocalStorageValue(rawValue));
    }
    return vacationTrackerSessionFromStorage(entries);
  } finally {
    if (database?.status === "open") await database.close();
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) throw new Error("token does not have three parts");
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (error) {
    throw new Error(`Could not decode the stored Vacation Tracker session: ${error.message}`);
  }
}

async function refreshVacationTrackerToken(session, { force = false } = {}) {
  const claims = decodeJwtPayload(session.idToken);
  const expiresAt = Number(claims.exp || 0) * 1000;
  if (!force && expiresAt > Date.now() + 60_000) {
    return { token: session.idToken, refreshed: false };
  }
  if (!session.refreshToken) {
    throw new Error("The Vacation Tracker session has no refresh token");
  }

  let cognitoEndpoint;
  try {
    const issuer = new URL(claims.iss);
    if (!issuer.hostname.startsWith("cognito-idp.")) {
      throw new Error("unexpected token issuer");
    }
    cognitoEndpoint = `${issuer.origin}/`;
  } catch (error) {
    throw new Error(`Could not identify Vacation Tracker's Cognito endpoint: ${error.message}`);
  }

  const response = await fetch(cognitoEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: session.clientId,
      AuthParameters: { REFRESH_TOKEN: session.refreshToken },
    }),
  });
  const body = parseMaybeJson(await response.text());
  const token = body?.AuthenticationResult?.IdToken;
  if (!response.ok || !token) {
    const code = body?.__type || body?.code || `HTTP ${response.status}`;
    throw new Error(`Vacation Tracker token refresh failed (${code})`);
  }
  session.idToken = token;
  return { token, refreshed: true };
}

async function readVacationTrackerBrowserSession() {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(VACATION_TRACKER_PROFILE_DIR, { recursive: true, mode: 0o700 });

  async function launchAndRead(headless, timeout) {
    const context = await chromium.launchPersistentContext(
      VACATION_TRACKER_PROFILE_DIR,
      { channel: "chrome", headless, viewport: null },
    );
    try {
      const page = context.pages()[0] || (await context.newPage());
      await page.goto(VACATION_TRACKER_PROFILE_URL, {
        waitUntil: "commit",
        timeout: 60_000,
      });
      await page.waitForFunction(
        () =>
          Object.keys(localStorage).some((key) =>
            /^CognitoIdentityServiceProvider\.[^.]+\.LastAuthUser$/.test(key),
          ),
        undefined,
        { timeout },
      );
      const storedEntries = await page.evaluate(() =>
        Object.fromEntries(
          Object.keys(localStorage)
            .filter((key) => key.startsWith("CognitoIdentityServiceProvider."))
            .map((key) => [key, localStorage.getItem(key)]),
        ),
      );
      return vacationTrackerSessionFromStorage(new Map(Object.entries(storedEntries)));
    } finally {
      await context.close();
    }
  }

  try {
    const session = await launchAndRead(true, 15_000);
    session.source = "browser-profile";
    return session;
  } catch {
    console.log(
      "Vacation Tracker needs a fresh login; opening a visible Chrome window. Complete sign-in there to continue.",
    );
  }

  try {
    const session = await launchAndRead(false, 300_000);
    session.source = "interactive-browser-login";
    return session;
  } catch {
    throw new Error(
      `Vacation Tracker login did not complete within five minutes. Sign in at ${VACATION_TRACKER_PROFILE_URL} and rerun.`,
    );
  }
}

const VACATION_TRACKER_LEAVES_QUERY = `
  query NikaTimeVacationLeaves($id: String!, $date: String) {
    getUser(id: $id) {
      id
      name
      workWeek
      location {
        timezone
        workWeek
      }
      upcomingLeaves(date: $date) {
        id
        status
        startDate
        endDate
        isPartDay
        partDayStartHour
        partDayEndHour
        partDay { startHour startMinute endHour endMinute }
        workingDays
        hasWorkingHoursSchedule
        daysList { day leaveHours workingHoursInDay }
        leaveType { id name }
      }
      history(date: $date) {
        id
        status
        startDate
        endDate
        isPartDay
        partDayStartHour
        partDayEndHour
        partDay { startHour startMinute endHour endMinute }
        workingDays
        hasWorkingHoursSchedule
        daysList { day leaveHours workingHoursInDay }
        leaveType { id name }
      }
      today(date: $date) {
        id
        startDate
        endDate
        isPartDay
        partDayStartHour
        partDayEndHour
        partDay { startHour startMinute endHour endMinute }
        workingDays
        hasWorkingHoursSchedule
        daysList { day leaveHours workingHoursInDay }
        leaveType { id name }
      }
    }
  }
`;

async function vacationTrackerGraphql(idToken, variables) {
  const response = await fetch(VACATION_TRACKER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: idToken,
    },
    body: JSON.stringify({ query: VACATION_TRACKER_LEAVES_QUERY, variables }),
  });
  const body = parseMaybeJson(await response.text());
  return { status: response.status, body };
}

function isVacationTrackerAuthFailure(result) {
  const details = JSON.stringify(result.body || {});
  return (
    result.status === 401 ||
    result.status === 403 ||
    /unauthori[sz]ed|not authorized|token.*expired|invalid token/i.test(details)
  );
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

function vacationTrackerMonthSummary(user) {
  const requestsById = new Map();
  const sources = [
    ["upcoming", user.upcomingLeaves || []],
    ["history", user.history || []],
    ["today", user.today || []],
  ];
  for (const [source, requests] of sources) {
    for (const request of requests) {
      const normalized = {
        ...request,
        status: request.status || "APPROVED",
        source,
      };
      const prior = requestsById.get(request.id);
      if (!prior || (normalized.daysList || []).length > (prior.daysList || []).length) {
        requestsById.set(request.id, normalized);
      }
    }
  }

  const workWeek = new Set(
    (user.workWeek?.length ? user.workWeek : user.location?.workWeek || [1, 2, 3, 4, 5])
      .map(Number),
  );
  const leaveRequests = [];
  const days = [];
  for (const request of requestsById.values()) {
    if (String(request.status).toUpperCase() !== "APPROVED") continue;
    const exactDays = (request.daysList || [])
      .map((day) => ({
        date: String(day.day || "").slice(0, 10),
        hours: Number.isFinite(Number(day.leaveHours)) ? Number(day.leaveHours) : null,
        workingHours: Number.isFinite(Number(day.workingHoursInDay))
          ? Number(day.workingHoursInDay)
          : null,
      }))
      .filter((day) => isExactIsoDate(day.date));

    const requestDays = exactDays.length
      ? exactDays
      : datesInRange(request.startDate, request.endDate)
          .filter((date) => workWeek.has(new Date(`${date}T12:00:00Z`).getUTCDay()))
          .map((date) => ({ date, hours: null, workingHours: null }));
    const monthDays = requestDays.filter(
      (day) => day.date >= PERIOD_START && day.date <= PERIOD_END,
    );
    if (monthDays.length === 0) continue;

    const leaveType = request.leaveType?.name || "Time off";
    const summaryRequest = {
      requestId: request.id,
      leaveType,
      status: "APPROVED",
      startDate: request.startDate,
      endDate: request.endDate,
      isPartDay: Boolean(request.isPartDay),
      days: monthDays,
    };
    leaveRequests.push(summaryRequest);
    for (const day of monthDays) {
      const portion =
        day.hours != null && day.workingHours > 0
          ? Number((day.hours / day.workingHours).toFixed(4))
          : null;
      days.push({
        date: day.date,
        leaveType,
        hours: day.hours,
        workingHours: day.workingHours,
        portion,
        fullDay: portion != null ? portion >= 1 : !request.isPartDay,
        requestId: request.id,
      });
    }
  }

  leaveRequests.sort((a, b) => a.startDate.localeCompare(b.startDate));
  days.sort((a, b) => a.date.localeCompare(b.date) || a.leaveType.localeCompare(b.leaveType));
  return {
    leaveRequests,
    days,
    approvedLeaveHours: Number(
      days.reduce((sum, day) => sum + (day.hours || 0), 0).toFixed(2),
    ),
  };
}

async function loadVacationTrackerLeaves(session) {
  let tokenState;
  try {
    tokenState = await refreshVacationTrackerToken(session);
  } catch (error) {
    error.vacationTrackerSessionFailure = true;
    throw error;
  }
  let result = await vacationTrackerGraphql(tokenState.token, {
    id: session.username,
    date: localIsoDate(),
  });
  if (isVacationTrackerAuthFailure(result)) {
    try {
      tokenState = await refreshVacationTrackerToken(session, { force: true });
    } catch (error) {
      error.vacationTrackerSessionFailure = true;
      throw error;
    }
    result = await vacationTrackerGraphql(tokenState.token, {
      id: session.username,
      date: localIsoDate(),
    });
  }
  if (isVacationTrackerAuthFailure(result)) {
    const error = new Error("Vacation Tracker rejected the renewed session");
    error.vacationTrackerSessionFailure = true;
    throw error;
  }
  if (result.status < 200 || result.status >= 300 || result.body?.errors) {
    throw new Error(
      `Could not read Vacation Tracker leaves (HTTP ${result.status}): ${JSON.stringify(result.body?.errors || result.body)}`,
    );
  }
  const user = result.body?.data?.getUser;
  if (!user?.id) throw new Error("Vacation Tracker returned no signed-in user");
  return { user, tokenRefreshed: tokenState.refreshed };
}

async function runVacations() {
  let session;
  let loaded;
  let directError;
  try {
    session = await readVacationTrackerChromeSession();
  } catch (error) {
    directError = error;
  }

  if (session) {
    try {
      loaded = await loadVacationTrackerLeaves(session);
    } catch (error) {
      if (!error.vacationTrackerSessionFailure) throw error;
      directError = error;
    }
  }

  if (!loaded) {
    if (process.env.VACATIONTRACKER_SKIP_BROWSER_FALLBACK === "1") {
      throw directError;
    }
    console.warn(
      `Could not reuse Chrome's Vacation Tracker session directly: ${directError.message}`,
    );
    session = await readVacationTrackerBrowserSession();
    loaded = await loadVacationTrackerLeaves(session);
  }

  const summary = vacationTrackerMonthSummary(loaded.user);
  console.log(
    JSON.stringify(
      {
        source: "Vacation Tracker",
        sourceUrl: VACATION_TRACKER_PROFILE_URL,
        month: PERIOD_LABEL,
        user: { id: loaded.user.id, name: loaded.user.name },
        authentication: {
          source: session.source,
          tokenRefreshed: loaded.tokenRefreshed,
          browserUsed: session.source !== "chrome-local-storage",
        },
        requestCount: summary.leaveRequests.length,
        approvedLeaveHours: summary.approvedLeaveHours,
        leaveRequests: summary.leaveRequests,
        days: summary.days,
      },
      null,
      2,
    ),
  );
}

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
    projectId: String(source === "payload" ? record.projectId : record.project_id),
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
  return { ok: missing.length === 0 && unexpected.length === 0, expected, actual, missing, unexpected };
}

async function completeSlackLogin(page) {
  console.log("NikaTime session is missing or expired; starting Slack login...");
  await page.goto(SLACK_LOGIN_URL, { waitUntil: "commit", timeout: 60_000 });

  try {
    await page.waitForURL(
      (url) =>
        url.hostname === "app.nikatime.com" &&
        !url.pathname.startsWith("/auth/") &&
        !url.pathname.startsWith("/error"),
      { timeout: 300_000 },
    );
  } catch {
    throw new Error(
      "Slack login did not complete within five minutes. Complete credentials/MFA in the opened Chrome window and rerun.",
    );
  }
}

function readChromeCookieRecord() {
  if (process.platform !== "darwin" || !fs.existsSync(SOURCE_CHROME_COOKIE_DB)) {
    return null;
  }

  const program = String.raw`
import base64, json, os, shutil, sqlite3, sys, tempfile
source = sys.argv[1]
fd, copy = tempfile.mkstemp(prefix="nikatime-cookie-", suffix=".sqlite")
os.close(fd)
try:
    shutil.copy2(source, copy)
    con = sqlite3.connect(copy)
    row = con.execute("""
        select host_key, path, is_secure, is_httponly, samesite, expires_utc,
               encrypted_value
        from cookies
        where host_key = 'app.nikatime.com' and name = 'authCookie'
        order by expires_utc desc
        limit 1
    """).fetchone()
    version_row = con.execute(
        "select value from meta where key = 'version'"
    ).fetchone()
    con.close()
    if row is None:
        print("null")
    else:
        host, path, secure, httponly, samesite, expires_utc, encrypted = row
        print(json.dumps({
            "host": host,
            "path": path,
            "secure": bool(secure),
            "httpOnly": bool(httponly),
            "sameSite": samesite,
            "expires": (expires_utc / 1000000) - 11644473600,
            "encrypted": base64.b64encode(encrypted).decode("ascii"),
            "schemaVersion": int(version_row[0]) if version_row else 0,
        }))
finally:
    os.unlink(copy)
`;

  const output = execFileSync("python3", ["-c", program, SOURCE_CHROME_COOKIE_DB], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

function decryptChromeCookie(record) {
  const encrypted = Buffer.from(record.encrypted, "base64");
  if (encrypted.subarray(0, 3).toString("ascii") !== "v10") {
    throw new Error("Unsupported Chrome cookie encryption format");
  }

  const safeStoragePassword = execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "Chrome Safe Storage"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  const key = crypto.pbkdf2Sync(
    safeStoragePassword,
    "saltysalt",
    1003,
    16,
    "sha1",
  );
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    key,
    Buffer.alloc(16, 0x20),
  );
  let plaintext = Buffer.concat([
    decipher.update(encrypted.subarray(3)),
    decipher.final(),
  ]);

  if (record.schemaVersion >= 24 && plaintext.length >= 32) {
    const expectedHostHash = crypto.createHash("sha256").update(record.host).digest();
    if (plaintext.subarray(0, 32).equals(expectedHostHash)) {
      plaintext = plaintext.subarray(32);
    }
  }
  return plaintext.toString("utf8");
}

function normalizeNikaTimeCookie(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Session cache does not contain a cookie object");
  }
  const domain = String(candidate.domain || "").replace(/^\./, "");
  if (
    candidate.name !== "authCookie" ||
    domain !== "app.nikatime.com" ||
    typeof candidate.value !== "string" ||
    candidate.value.length === 0 ||
    candidate.secure !== true ||
    candidate.httpOnly !== true
  ) {
    throw new Error("Session cache contains an invalid NikaTime cookie");
  }

  const cookie = {
    name: "authCookie",
    value: candidate.value,
    domain: candidate.domain,
    path: candidate.path || "/",
    secure: true,
    httpOnly: true,
  };
  if (Number.isFinite(candidate.expires) && candidate.expires > 0) {
    cookie.expires = candidate.expires;
  }
  if (["None", "Lax", "Strict"].includes(candidate.sameSite)) {
    cookie.sameSite = candidate.sameSite;
  }
  return cookie;
}

function sessionCacheEnabled() {
  return process.env.NIKATIME_DISABLE_SESSION_CACHE !== "1";
}

function readCachedSessionCookie(cachePath = SESSION_CACHE_PATH) {
  if (!sessionCacheEnabled()) return null;

  let fd;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(cachePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Session cache is not a regular file");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("Session cache is not owned by the current user");
    }
    if ((stat.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);

    const payload = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (payload.version !== SESSION_CACHE_VERSION) {
      throw new Error(`Unsupported session cache version: ${payload.version}`);
    }
    const cookie = normalizeNikaTimeCookie(payload.cookie);
    if (cookie.expires && cookie.expires <= Date.now() / 1000) return null;
    return cookie;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Ignoring the local NikaTime session cache: ${error.message}`);
    }
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeCachedSessionCookie(candidate, cachePath = SESSION_CACHE_PATH) {
  if (!sessionCacheEnabled()) return;

  const cookie = normalizeNikaTimeCookie(candidate);
  const cacheDirectory = path.dirname(cachePath);
  fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    cacheDirectory,
    `.${path.basename(cachePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const payload = `${JSON.stringify({
    version: SESSION_CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    cookie,
  }, null, 2)}\n`;

  let fd;
  try {
    fd = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryPath, cachePath);
    fs.chmodSync(cachePath, 0o600);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw new Error(`Could not persist the NikaTime session cache: ${error.message}`);
  }
}

function persistSessionCookie(candidate) {
  try {
    writeCachedSessionCookie(candidate);
    return true;
  } catch (error) {
    console.warn(error.message);
    return false;
  }
}

function prepareExistingChromeCookie() {
  try {
    const record = readChromeCookieRecord();
    if (!record) return null;
    const value = decryptChromeCookie(record);
    if (!value) return null;

    const cookie = {
      name: "authCookie",
      value,
      domain: record.host,
      path: record.path || "/",
      secure: record.secure,
      httpOnly: record.httpOnly,
    };
    if (Number.isFinite(record.expires) && record.expires > 0) {
      cookie.expires = record.expires;
    }
    if (record.sameSite === 0) cookie.sameSite = "None";
    else if (record.sameSite === 1) cookie.sameSite = "Lax";
    else if (record.sameSite === 2) cookie.sameSite = "Strict";
    return normalizeNikaTimeCookie(cookie);
  } catch (error) {
    console.warn(`Could not read Chrome's NikaTime session: ${error.message}`);
    return null;
  }
}

function prepareInitialSession(args) {
  const importRequested =
    args.importChrome ||
    (
      process.env.NIKATIME_IMPORT_CHROME === "1" &&
      process.env.NIKATIME_SKIP_CHROME_IMPORT !== "1"
    );
  if (importRequested) {
    const cookie = prepareExistingChromeCookie();
    if (cookie) return { cookie, source: "default-chrome" };
    console.warn("No reusable NikaTime session was imported from the default Chrome profile.");
  }

  const cookie = readCachedSessionCookie();
  return { cookie, source: cookie ? "session-cache" : null };
}

async function seedBrowserSession(context, cookie) {
  if (!cookie) return false;
  await context.addCookies([cookie]);
  console.log("Seeded the dedicated browser with a reusable NikaTime session (value hidden).");
  return true;
}

async function loadWorkloadOnce(page) {
  const responsePromise = page
    .waitForResponse((response) => isOverviewWorkload(response.url()), {
      timeout: 30_000,
    })
    .catch(() => null);

  await page.goto(OVERVIEW_URL, { waitUntil: "commit", timeout: 60_000 });
  const response = await responsePromise;

  if (!response) {
    return {
      status: 0,
      body: null,
      finalUrl: page.url(),
      error: "The Overview page did not request its workload endpoint.",
    };
  }

  const text = await response.text();
  return {
    status: response.status(),
    body: parseMaybeJson(text),
    finalUrl: page.url(),
  };
}

async function loadWorkload(page, context) {
  let result = await loadWorkloadOnce(page);
  const redirectedToSignIn = /www\.nikatime\.com\/sign-in/i.test(result.finalUrl);

  if (
    redirectedToSignIn ||
    result.status === 0 ||
    isAuthFailure(result.status, result.body)
  ) {
    await completeSlackLogin(page);
    result = await loadWorkloadOnce(page);
  }

  if (isAuthFailure(result.status, result.body)) {
    await completeSlackLogin(page);
    result = await loadWorkloadOnce(page);
  }

  if (
    result.status < 200 ||
    result.status >= 300 ||
    !result.body ||
    result.body.ok !== true
  ) {
    throw new Error(
      `Could not load ${PERIOD_LABEL} workload (HTTP ${result.status}): ${JSON.stringify(result.body || result.error)}`,
    );
  }

  return result.body.result;
}

async function readContextAuthCookie(context) {
  const cookies = await context.cookies("https://app.nikatime.com");
  const candidate = cookies.find((item) => item.name === "authCookie");
  return candidate ? normalizeNikaTimeCookie(candidate) : null;
}

async function printCookieMetadata(context) {
  const cookie = await readContextAuthCookie(context);
  if (!cookie) {
    console.log("authCookie: not present");
    return null;
  }

  console.log("authCookie:", {
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expires:
      cookie.expires > 0
        ? new Date(cookie.expires * 1000).toISOString()
        : "browser session",
  });
  return cookie;
}

function printDirectCookieMetadata(session) {
  const cookie = session.cookie;
  if (!cookie) {
    console.log("authCookie: not present");
    return;
  }
  console.log("authCookie:", {
    source: session.source,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expires:
      cookie.expires > 0
        ? new Date(cookie.expires * 1000).toISOString()
        : "browser session",
  });
}

function summarize(workload) {
  const records = Array.isArray(workload.records) ? workload.records : [];
  const hoursByDate = new Map();
  for (const record of records) {
    hoursByDate.set(
      record.date,
      (hoursByDate.get(record.date) || 0) + Number(record.hours || 0),
    );
  }

  const periodWeekdays = weekdays(PERIOD_START, PERIOD_END);
  const total = periodWeekdays.reduce(
    (sum, date) => sum + (hoursByDate.get(date) || 0),
    0,
  );
  return { records, hoursByDate, periodWeekdays, total };
}

function buildPlan(workload, projectId, targetHours, note, selectedDate) {
  const { records, hoursByDate, periodWeekdays } = summarize(workload);
  const maxOrderByDate = new Map();
  for (const record of records) {
    maxOrderByDate.set(
      record.date,
      Math.max(maxOrderByDate.get(record.date) ?? -1, Number(record.order ?? -1)),
    );
  }

  const targetDates = selectedDate
    ? periodWeekdays.filter((date) => date === selectedDate)
    : periodWeekdays;
  if (selectedDate && targetDates.length === 0) {
    throw new Error(`${selectedDate} is not a weekday in ${PERIOD_LABEL}`);
  }

  return targetDates.flatMap((date) => {
    const existing = hoursByDate.get(date) || 0;
    const missing = Number(Math.max(0, targetHours - existing).toFixed(2));
    if (missing === 0) return [];
    return [
      {
        projectId,
        hours: missing,
        // The private web endpoint uses compact yyyyMMdd even though its
        // published schema labels this field as an ISO date.
        date: date.replaceAll("-", ""),
        notes: note,
        order: (maxOrderByDate.get(date) ?? -1) + 1,
        targetUser: workload.userId,
      },
    ];
  });
}

function buildBatchPlan(workload, entries, defaultHours) {
  const { records, hoursByDate, periodWeekdays } = summarize(workload);
  const weekdaysSet = new Set(periodWeekdays);
  const maxOrderByDate = new Map();
  for (const record of records) {
    maxOrderByDate.set(
      record.date,
      Math.max(maxOrderByDate.get(record.date) ?? -1, Number(record.order ?? -1)),
    );
  }
  const seen = new Set();
  return entries.flatMap((rawEntry, index) => {
    const entry = validateEntry(rawEntry, index, { requireHours: false, defaultHours });
    if (!weekdaysSet.has(entry.date)) throw new Error(`Invalid ${PERIOD_LABEL} weekday: ${entry.date}`);
    if (seen.has(entry.date)) throw new Error(`Duplicate batch date: ${entry.date}`);
    seen.add(entry.date);
    const target = entry.hours;
    const missing = Number(Math.max(0, target - (hoursByDate.get(entry.date) || 0)).toFixed(2));
    if (missing === 0) return [];
    return [{
      projectId: entry.projectId,
      hours: missing,
      date: entry.date.replaceAll("-", ""),
      notes: entry.notes,
      order: (maxOrderByDate.get(entry.date) ?? -1) + 1,
      targetUser: workload.userId,
    }];
  });
}

// --- Direct HTTP client (no browser) -----------------------------------
//
// Every read/write NikaTime's own frontend makes goes through same-origin
// fetch() calls that carry only the authCookie for authentication (no CSRF
// token, no Origin/Referer check observed). These mirror those calls
// exactly, using a cookie value from the private session cache, the dedicated
// browser profile, or an explicit default-Chrome import.

async function apiFetch(pathname, { method = "GET", body, cookieValue } = {}) {
  const headers = { Cookie: `authCookie=${cookieValue}` };
  if (body !== undefined) headers["Content-Type"] = "application/json;charset=UTF-8";
  const response = await fetch(`${API_ORIGIN}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "follow",
  });
  const text = await response.text();
  return { status: response.status, body: parseMaybeJson(text), finalUrl: response.url };
}

function periodQuery(targetUser) {
  const start = PERIOD_START.replaceAll("-", "");
  const end = PERIOD_END.replaceAll("-", "");
  return `dateStart=${start}&dateEnd=${end}&targetUser=${encodeURIComponent(targetUser)}`;
}

async function directSession(cookieValue) {
  return apiFetch("/api/web/session", { cookieValue });
}

async function directWorkloadOnce(cookieValue) {
  const session = await directSession(cookieValue);
  const userId = session.body?.result?.user?.userId;
  if (!userId || session.status !== 200 || session.body?.ok !== true) {
    return { status: session.status, body: session.body, finalUrl: session.finalUrl };
  }
  return apiFetch(`/api/web/user/workload?${periodQuery(userId)}`, { cookieValue });
}

function isValidWorkloadResult(result) {
  return (
    result.status >= 200 &&
    result.status < 300 &&
    result.body != null &&
    result.body.ok === true &&
    !isAuthFailure(result.status, result.body)
  );
}

async function directDropdown(cookieValue, userId) {
  return apiFetch(`/api/web/project/common/dropdown?${periodQuery(userId)}`, { cookieValue });
}

async function submitPlan(cookieValue, plan) {
  return apiFetch("/api/web/records", { method: "POST", body: plan, cookieValue });
}

async function deleteDates(cookieValue, dates, targetUser) {
  return apiFetch("/api/web/records", {
    method: "DELETE",
    body: dates.map((date) => ({ date: date.replaceAll("-", ""), targetUser })),
    cookieValue,
  });
}

function replacementPayload(workload, entries) {
  const validated = entries.map((entry, index) =>
    validateEntry(entry, index, { requireHours: true }),
  );
  const dates = [...new Set(validated.map((entry) => entry.date))];
  if (dates.length !== 1) throw new Error("replace currently requires exactly one date");
  if (!weekdays(PERIOD_START, PERIOD_END).includes(dates[0])) {
    throw new Error(`Invalid ${PERIOD_LABEL} weekday: ${dates[0]}`);
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
  return (workload.records || []).filter((record) => record.date === date).map((record) => ({
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
  const dates = [...new Set(
    plan.map((record) =>
      `${record.date.slice(0, 4)}-${record.date.slice(4, 6)}-${record.date.slice(6, 8)}`,
    ),
  )];
  const baseline = dates.flatMap((date) => backupDate(workload, date));
  return { dates, records: [...baseline, ...plan] };
}

// --- Browser fallback (for `inspect`, cache recovery, and interactive renewal) --

async function establishBrowserSession(seedCookie, { forceHeaded = false } = {}) {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });

  const apiCalls = [];
  function attachApiListener(ctx) {
    ctx.on("request", (request) => {
      if (!isNikaTimeApiUrl(request.url())) return;
      apiCalls.push({
        method: request.method(),
        url: request.url(),
        body: request.postData() ? parseMaybeJson(request.postData()) : undefined,
      });
    });
  }
  async function launchContext(headless) {
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless,
      viewport: null,
    });
    attachApiListener(ctx);
    return ctx;
  }

  let headless = !forceHeaded;
  let context = await launchContext(headless);
  let page = context.pages()[0] || (await context.newPage());
  if (seedCookie) {
    await seedBrowserSession(context, seedCookie);
  }

  let workload;
  if (headless) {
    const probe = await loadWorkloadOnce(page);
    const needsInteractiveLogin =
      /www\.nikatime\.com\/sign-in/i.test(probe.finalUrl) ||
      probe.status === 0 ||
      isAuthFailure(probe.status, probe.body);
    if (needsInteractiveLogin) {
      console.log(
        "The reusable NikaTime session could not authenticate; opening a visible Chrome window to finish Slack login.",
      );
      await context.close();
      headless = false;
      context = await launchContext(headless);
      page = context.pages()[0] || (await context.newPage());
      workload = await loadWorkload(page, context);
    } else if (
      probe.status < 200 ||
      probe.status >= 300 ||
      !probe.body ||
      probe.body.ok !== true
    ) {
      workload = await loadWorkload(page, context);
    } else {
      workload = probe.body.result;
    }
  } else {
    workload = await loadWorkload(page, context);
  }

  return { context, page, apiCalls, workload };
}

async function renewCookieViaBrowser() {
  const { context } = await establishBrowserSession(null);
  try {
    const cookie = await readContextAuthCookie(context);
    if (!cookie) {
      throw new Error("Session established in Chrome but no authCookie was set; cannot continue.");
    }
    persistSessionCookie(cookie);
    return cookie;
  } finally {
    await context.close();
  }
}

async function restoreDate(session, ensureWorkload, workload, date, backup) {
  try {
    const current = await ensureWorkload();
    const currentComparison = comparePlan(current, backup, {
      exactDates: true,
      dates: [date],
    });
    if (currentComparison.ok) return { restored: true };

    let cleanup = await deleteDates(session.cookie.value, [date], workload.userId);
    if (isAuthFailure(cleanup.status, cleanup.body)) {
      await ensureWorkload();
      cleanup = await deleteDates(session.cookie.value, [date], workload.userId);
    }
    if (!responseSucceeded(cleanup)) {
      return {
        restored: false,
        error: `cleanup failed (HTTP ${cleanup.status}): ${JSON.stringify(cleanup.body)}`,
      };
    }
    if (backup.length > 0) {
      let restoration = await submitPlan(session.cookie.value, backup);
      if (isAuthFailure(restoration.status, restoration.body)) {
        await ensureWorkload();
        const renewedCleanup = await deleteDates(session.cookie.value, [date], workload.userId);
        if (!responseSucceeded(renewedCleanup)) {
          return {
            restored: false,
            error: `renewed cleanup failed (HTTP ${renewedCleanup.status}): ${JSON.stringify(renewedCleanup.body)}`,
          };
        }
        restoration = await submitPlan(session.cookie.value, backup);
      }
      if (!responseSucceeded(restoration)) {
        return {
          restored: false,
          error: `restore failed (HTTP ${restoration.status}): ${JSON.stringify(restoration.body)}`,
        };
      }
    }
    const verified = await ensureWorkload();
    const comparison = comparePlan(verified, backup, { exactDates: true, dates: [date] });
    if (!comparison.ok) {
      return { restored: false, error: `restore verification mismatch: ${JSON.stringify(comparison)}` };
    }
    return { restored: true };
  } catch (error) {
    return { restored: false, error: error.message || String(error) };
  }
}

async function fetchProjectList(cookieValue, userId) {
  const dropdown = await directDropdown(cookieValue, userId);
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

async function directListProjects(cookieValue, userId) {
  const projects = await fetchProjectList(cookieValue, userId);
  console.log(JSON.stringify(projects, null, 2));
}

function projectNameMap(projects) {
  const map = new Map();
  for (const project of projects) map.set(String(project.id), project.name);
  return map;
}

// Existing records on a date, in the shape `batch`/`replace` warnings and
// `show` both print: human-readable project names alongside the raw IDs, so
// an agent can tell at a glance whether a "day already has 8 hours" actually
// means the day is correctly labeled, or is filled under the wrong project.
function describeExistingRecords(workload, nameMap, date) {
  return (workload.records || [])
    .filter((record) => !date || record.date === date)
    .slice()
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .map((record) => ({
      date: record.date,
      projectId: String(record.project_id),
      projectName: nameMap.get(String(record.project_id)) || "(project no longer in dropdown)",
      hours: Number(record.hours),
      notes: record.info || "",
    }));
}

async function runShow(session, workload, date) {
  const projects = await fetchProjectList(session.cookie.value, workload.userId);
  const nameMap = projectNameMap(projects);

  if (date) {
    const records = describeExistingRecords(workload, nameMap, date);
    const totalHours = records.reduce((sum, record) => sum + record.hours, 0);
    console.log(JSON.stringify({ date, totalHours, records }, null, 2));
    return;
  }

  const { periodWeekdays } = summarize(workload);
  const allRecords = describeExistingRecords(workload, nameMap);
  const recordsByDate = new Map();
  for (const record of allRecords) {
    if (!recordsByDate.has(record.date)) recordsByDate.set(record.date, []);
    recordsByDate.get(record.date).push(record);
  }
  const days = periodWeekdays.map((weekday) => {
    const records = recordsByDate.get(weekday) || [];
    return {
      date: weekday,
      totalHours: records.reduce((sum, record) => sum + record.hours, 0),
      records,
    };
  });
  console.log(JSON.stringify({ month: PERIOD_LABEL, days }, null, 2));
}

// `batch` only ever fills the gap between a date's existing total hours and
// the target; it never inspects *which* project those existing hours are
// under. That makes it silently inert on a date that is already full but
// mislabeled — the exact failure mode that motivated this warning: a day
// logged under the wrong project stayed wrong until a `replace` dry run was
// used as an ad hoc diagnostic to notice it. Surface that case loudly instead
// of leaving it to be discovered by accident.
function batchSkipWarnings(workload, entries, defaultHours, nameMap) {
  const { hoursByDate } = summarize(workload);
  const warnings = [];
  entries.forEach((rawEntry, index) => {
    const entry = validateEntry(rawEntry, index, { requireHours: false, defaultHours });
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

async function runInspect(args, initialSession) {
  let seedCookie = initialSession.cookie;
  if (seedCookie) {
    const probe = await directWorkloadOnce(seedCookie.value);
    if (!isValidWorkloadResult(probe)) seedCookie = null;
  }
  const { context, apiCalls, workload } = await establishBrowserSession(seedCookie, {
    forceHeaded: args.headed,
  });
  try {
    const cookie = await printCookieMetadata(context);
    if (cookie) persistSessionCookie(cookie);

    const summary = summarize(workload);
    const configuredTarget = Number(workload.workdayDuration || 8);
    validateHours(configuredTarget, "NikaTime workdayDuration");
    console.log(`${PERIOD_LABEL} summary:`, {
      userId: workload.userId,
      name: workload.name,
      weekdays: summary.periodWeekdays.length,
      enteredHours: summary.total,
      workdayDuration: configuredTarget,
      expectedHours: summary.periodWeekdays.length * configuredTarget,
    });

    console.log("Observed NikaTime API calls (cookies and headers omitted):");
    console.log(JSON.stringify(apiCalls, null, 2));
  } finally {
    await context.close();
  }
}

async function runDirectCommand(args, initialSession) {
  const session = {
    cookie: initialSession.cookie || null,
    source: initialSession.source,
  };

  async function renewSession() {
    session.cookie = await renewCookieViaBrowser();
    session.source = "browser-profile";
    return session.cookie;
  }

  async function ensureWorkload() {
    if (session.cookie) {
      const probe = await directWorkloadOnce(session.cookie.value);
      if (isValidWorkloadResult(probe)) {
        if (session.source === "default-chrome") persistSessionCookie(session.cookie);
        return probe.body.result;
      }
    }
    await renewSession();
    const result = await directWorkloadOnce(session.cookie.value);
    if (!isValidWorkloadResult(result)) {
      throw new Error(
        `Could not load ${PERIOD_LABEL} workload (HTTP ${result.status}): ${JSON.stringify(result.body)}`,
      );
    }
    return result.body.result;
  }

  const workload = await ensureWorkload();
  printDirectCookieMetadata(session);

  const summary = summarize(workload);
  const configuredTarget = Number(workload.workdayDuration || 8);
  validateHours(configuredTarget, "NikaTime workdayDuration");
  console.log(`${PERIOD_LABEL} summary:`, {
    userId: workload.userId,
    name: workload.name,
    weekdays: summary.periodWeekdays.length,
    enteredHours: summary.total,
    workdayDuration: configuredTarget,
    expectedHours: summary.periodWeekdays.length * configuredTarget,
  });

  if (args.command === "projects") {
    await directListProjects(session.cookie.value, workload.userId);
    return;
  }

  if (args.command === "show") {
    await runShow(session, workload, args.date);
    return;
  }

  async function submit(plan) {
    let result = await submitPlan(session.cookie.value, plan);
    if (isAuthFailure(result.status, result.body)) {
      await renewSession();
      result = await submitPlan(session.cookie.value, plan);
    }
    return result;
  }

  async function del(dates, targetUser) {
    let result = await deleteDates(session.cookie.value, dates, targetUser);
    if (isAuthFailure(result.status, result.body)) {
      await renewSession();
      result = await deleteDates(session.cookie.value, dates, targetUser);
    }
    return result;
  }

  if (args.command === "batch") {
    const entries = JSON.parse(fs.readFileSync(path.resolve(args.file), "utf8"));
    if (!Array.isArray(entries)) throw new Error("Batch file must contain a JSON array");
    const projects = await fetchProjectList(session.cookie.value, workload.userId);
    const warnings = batchSkipWarnings(workload, entries, configuredTarget, projectNameMap(projects));
    if (warnings.length > 0) {
      console.warn(
        "WARNING: batch fills hour gaps only and cannot relabel a date that is already full under a " +
          "different project. The following dates already have their target hours entered under a " +
          "different project and will be left untouched. Use `replace` for these dates instead:",
      );
      console.warn(JSON.stringify(warnings, null, 2));
    }
    const plan = buildBatchPlan(workload, entries, configuredTarget);
    const expectedState = expectedAfterAdd(workload, plan);
    console.log(JSON.stringify({ dryRun: !args.apply, recordCount: plan.length, records: plan }, null, 2));
    if (!args.apply || plan.length === 0) {
      console.log(args.apply ? "Nothing to add." : "Dry run only; no NikaTime records were changed.");
      return;
    }
    const submission = await submit(plan);
    if (!responseSucceeded(submission)) {
      throw new Error(`NikaTime rejected the batch (HTTP ${submission.status}): ${JSON.stringify(submission.body)}`);
    }
    const verified = await ensureWorkload();
    const remaining = buildBatchPlan(verified, entries, configuredTarget);
    const comparison = comparePlan(verified, expectedState.records, {
      exactDates: true,
      dates: expectedState.dates,
    });
    console.log("Verification:", {
      remainingRecords: remaining.length,
      exactRecordsPresent: comparison.ok,
    });
    if (remaining.length || !comparison.ok) {
      throw new Error(`Batch verification mismatch: ${JSON.stringify({ remaining, comparison })}`);
    }
    return;
  }

  if (args.command === "replace") {
    const entries = JSON.parse(fs.readFileSync(path.resolve(args.file), "utf8"));
    if (!Array.isArray(entries) || entries.length === 0) throw new Error("Replacement file must contain entries");
    const plan = replacementPayload(workload, entries);
    const date = entries[0].date;
    const backup = backupDate(workload, date);
    console.log(JSON.stringify({ dryRun: !args.apply, date, previous: backup, replacement: plan }, null, 2));
    if (!args.apply) {
      console.log("Dry run only; no NikaTime records were changed.");
      return;
    }
    let comparison;
    try {
      const deletion = await del([date], workload.userId);
      if (!responseSucceeded(deletion)) {
        throw new Error(`NikaTime rejected the date deletion (HTTP ${deletion.status}): ${JSON.stringify(deletion.body)}`);
      }
      const submission = await submit(plan);
      if (!responseSucceeded(submission)) {
        throw new Error(`NikaTime rejected the replacement (HTTP ${submission.status}): ${JSON.stringify(submission.body)}`);
      }
      const verified = await ensureWorkload();
      comparison = comparePlan(verified, plan, { exactDates: true, dates: [date] });
      if (!comparison.ok) {
        throw new Error(`Replacement verification mismatch: ${JSON.stringify(comparison)}`);
      }
    } catch (error) {
      const restoration = await restoreDate(session, ensureWorkload, workload, date, backup);
      if (restoration.restored) {
        throw new Error(`${error.message || error}; previous records were verified restored.`);
      }
      throw new Error(`URGENT: replacement and automatic restoration both failed for ${date}. Review NikaTime manually. Cause: ${error.message || error}; restoration: ${restoration.error}`);
    }
    console.log("Verification:", {
      date,
      records: comparison.actual,
      totalHours: plan.reduce((sum, entry) => sum + entry.hours, 0),
    });
    return;
  }

  // fill
  const targetHours = args.hours ?? configuredTarget;
  validateHours(targetHours, "fill");
  const plan = buildPlan(
    workload,
    args.projectId,
    targetHours,
    args.note,
    args.date,
  );
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
    if (!args.apply) console.log("Dry run only; no NikaTime records were changed.");
    else console.log("Nothing to add.");
    return;
  }

  let appliedPlan = plan;
  let appliedBaseline = workload;
  const submission = await submitPlan(session.cookie.value, plan);
  if (isAuthFailure(submission.status, submission.body)) {
    console.log("Session expired before submission; renewing and rebuilding the plan.");
    await renewSession();
    const refreshed = await ensureWorkload();
    const refreshedPlan = buildPlan(
      refreshed,
      args.projectId,
      targetHours,
      args.note,
      args.date,
    );
    appliedPlan = refreshedPlan;
    appliedBaseline = refreshed;
    const retry = await submitPlan(session.cookie.value, refreshedPlan);
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

  const verified = await ensureWorkload();
  const remaining = buildPlan(
    verified,
    args.projectId,
    targetHours,
    args.note,
    args.date,
  );
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
    console.error(`Verification mismatch for ${PERIOD_LABEL}: ${JSON.stringify(comparison)}. Review the calendar before rerunning.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (
    ![
      "inspect",
      "projects",
      "show",
      "vacations",
      "batch",
      "replace",
      "fill",
    ].includes(args.command)
  ) {
    usage();
    throw new Error(`Unknown command: ${args.command}`);
  }
  if (args.command === "fill" && !args.projectId) {
    throw new Error("fill requires --project-id");
  }
  if (args.command === "batch" && !args.file) throw new Error("batch requires --file");
  if (args.command === "replace" && !args.file) throw new Error("replace requires --file");
  configurePeriod(args.month);
  if (args.date && (args.date < PERIOD_START || args.date > PERIOD_END)) {
    throw new Error(`--date must fall within ${PERIOD_LABEL}`);
  }
  if (args.date && !isExactIsoDate(args.date)) {
    throw new Error("--date must be a real date formatted YYYY-MM-DD");
  }
  if (args.command === "vacations") {
    await runVacations();
    return;
  }
  if (args.command === "fill") {
    validateProjectId(args.projectId, "fill");
    validateNotes(args.note, "fill");
  }

  // Routine commands never query Chrome Safe Storage. They use the private
  // session cache first and recover through the dedicated browser profile on a
  // miss. Importing the default Chrome profile is an explicit opt-in because
  // macOS can require the user's password for that Keychain access.
  const initialSession = prepareInitialSession(args);

  if (args.command === "inspect") {
    await runInspect(args, initialSession);
    return;
  }

  await runDirectCommand(args, initialSession);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  normalizeNikaTimeCookie,
  parseArgs,
  readCachedSessionCookie,
  writeCachedSessionCookie,
};
