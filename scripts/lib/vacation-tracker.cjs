const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  SOURCE_CHROME_LOCAL_STORAGE,
  VACATION_TRACKER_GRAPHQL_URL,
  VACATION_TRACKER_ORIGIN,
  VACATION_TRACKER_PROFILE_DIR,
  VACATION_TRACKER_PROFILE_URL,
} = require("./config.cjs");
const { loadClassicLevel, loadPlaywright } = require("./dependencies.cjs");
const {
  datesInRange,
  isExactIsoDate,
  localIsoDate,
  parseMaybeJson,
} = require("./date-utils.cjs");

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
      return {
        clientId,
        username,
        idToken,
        refreshToken,
        source: "chrome-local-storage",
      };
    }
  }

  throw new Error(
    `No Vacation Tracker Cognito session was found in Chrome. Sign in at ${VACATION_TRACKER_PROFILE_URL} and rerun.`,
  );
}

async function readVacationTrackerChromeSession() {
  if (!fs.existsSync(SOURCE_CHROME_LOCAL_STORAGE)) {
    throw new Error(
      `Chrome local storage was not found at ${SOURCE_CHROME_LOCAL_STORAGE}`,
    );
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
      if (!localStorageKey.startsWith("CognitoIdentityServiceProvider.")) {
        continue;
      }
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
    throw new Error(
      `Could not decode the stored Vacation Tracker session: ${error.message}`,
    );
  }
}

async function refreshVacationTrackerToken(
  session,
  { force = false, fetchImpl = globalThis.fetch } = {},
) {
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
    throw new Error(
      `Could not identify Vacation Tracker's Cognito endpoint: ${error.message}`,
    );
  }

  const response = await fetchImpl(cognitoEndpoint, {
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
      return vacationTrackerSessionFromStorage(
        new Map(Object.entries(storedEntries)),
      );
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

async function vacationTrackerGraphql(
  idToken,
  variables,
  fetchImpl = globalThis.fetch,
) {
  const response = await fetchImpl(VACATION_TRACKER_GRAPHQL_URL, {
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

function vacationTrackerMonthSummary(user, period) {
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
      if (
        !prior ||
        (normalized.daysList || []).length > (prior.daysList || []).length
      ) {
        requestsById.set(request.id, normalized);
      }
    }
  }

  const workWeek = new Set(
    (
      user.workWeek?.length
        ? user.workWeek
        : user.location?.workWeek || [1, 2, 3, 4, 5]
    ).map(Number),
  );
  const leaveRequests = [];
  const days = [];
  for (const request of requestsById.values()) {
    if (String(request.status).toUpperCase() !== "APPROVED") continue;
    const exactDays = (request.daysList || [])
      .map((day) => ({
        date: String(day.day || "").slice(0, 10),
        hours: Number.isFinite(Number(day.leaveHours))
          ? Number(day.leaveHours)
          : null,
        workingHours: Number.isFinite(Number(day.workingHoursInDay))
          ? Number(day.workingHoursInDay)
          : null,
      }))
      .filter((day) => isExactIsoDate(day.date));

    const requestDays = exactDays.length
      ? exactDays
      : datesInRange(request.startDate, request.endDate)
          .filter((date) =>
            workWeek.has(new Date(`${date}T12:00:00Z`).getUTCDay()),
          )
          .map((date) => ({ date, hours: null, workingHours: null }));
    const monthDays = requestDays.filter(
      (day) => day.date >= period.start && day.date <= period.end,
    );
    if (monthDays.length === 0) continue;

    const leaveType = request.leaveType?.name || "Time off";
    leaveRequests.push({
      requestId: request.id,
      leaveType,
      status: "APPROVED",
      startDate: request.startDate,
      endDate: request.endDate,
      isPartDay: Boolean(request.isPartDay),
      days: monthDays,
    });
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
  days.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.leaveType.localeCompare(b.leaveType),
  );
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
      `Could not read Vacation Tracker leaves (HTTP ${result.status}): ` +
        JSON.stringify(result.body?.errors || result.body),
    );
  }
  const user = result.body?.data?.getUser;
  if (!user?.id) throw new Error("Vacation Tracker returned no signed-in user");
  return { user, tokenRefreshed: tokenState.refreshed };
}

async function runVacations(period) {
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

  const summary = vacationTrackerMonthSummary(loaded.user, period);
  console.log(
    JSON.stringify(
      {
        source: "Vacation Tracker",
        sourceUrl: VACATION_TRACKER_PROFILE_URL,
        month: period.label,
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

module.exports = {
  decodeChromeLocalStorageValue,
  decodeJwtPayload,
  refreshVacationTrackerToken,
  runVacations,
  vacationTrackerMonthSummary,
  vacationTrackerSessionFromStorage,
};
