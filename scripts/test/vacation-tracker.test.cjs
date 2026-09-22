const assert = require("node:assert/strict");
const test = require("node:test");

const { createPeriod } = require("../lib/date-utils.cjs");
const {
  decodeChromeLocalStorageValue,
  decodeJwtPayload,
  refreshVacationTrackerToken,
  vacationTrackerMonthSummary,
  vacationTrackerSessionFromStorage,
} = require("../lib/vacation-tracker.cjs");

function jwt(claims) {
  return [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

test("decodes both Chrome local-storage string encodings", () => {
  assert.equal(
    decodeChromeLocalStorageValue(
      Buffer.concat([Buffer.from([0]), Buffer.from("hello", "utf16le")]),
    ),
    "hello",
  );
  assert.equal(
    decodeChromeLocalStorageValue(
      Buffer.concat([Buffer.from([1]), Buffer.from("hello", "utf8")]),
    ),
    "hello",
  );
  assert.throws(
    () => decodeChromeLocalStorageValue(Buffer.from([2, 1])),
    /Unsupported Chrome local-storage encoding/,
  );
});

test("extracts a complete Cognito session from Chrome entries", () => {
  const prefix = "CognitoIdentityServiceProvider.client.user";
  const session = vacationTrackerSessionFromStorage(
    new Map([
      ["CognitoIdentityServiceProvider.client.LastAuthUser", "user"],
      [`${prefix}.idToken`, "id-token"],
      [`${prefix}.refreshToken`, "refresh-token"],
    ]),
  );
  assert.deepEqual(session, {
    clientId: "client",
    username: "user",
    idToken: "id-token",
    refreshToken: "refresh-token",
    source: "chrome-local-storage",
  });
});

test("JWT decoding and fresh-token reuse avoid network access", async () => {
  const idToken = jwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    iss: "https://cognito-idp.us-east-1.amazonaws.com/pool",
  });
  assert.equal(decodeJwtPayload(idToken).exp > 0, true);

  let fetchCalls = 0;
  const result = await refreshVacationTrackerToken(
    { idToken, clientId: "client", refreshToken: "refresh" },
    {
      fetchImpl: async () => {
        fetchCalls += 1;
      },
    },
  );
  assert.deepEqual(result, { token: idToken, refreshed: false });
  assert.equal(fetchCalls, 0);
});

test("expired Cognito tokens are refreshed against their issuer", async () => {
  const session = {
    idToken: jwt({
      exp: 1,
      iss: "https://cognito-idp.us-east-1.amazonaws.com/pool",
    }),
    clientId: "client",
    refreshToken: "refresh",
  };
  const calls = [];
  const result = await refreshVacationTrackerToken(session, {
    fetchImpl: async (...args) => {
      calls.push(args);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ AuthenticationResult: { IdToken: "new-token" } }),
      };
    },
  });

  assert.deepEqual(result, { token: "new-token", refreshed: true });
  assert.equal(session.idToken, "new-token");
  assert.equal(
    calls[0][0],
    "https://cognito-idp.us-east-1.amazonaws.com/",
  );
  assert.deepEqual(JSON.parse(calls[0][1].body).AuthParameters, {
    REFRESH_TOKEN: "refresh",
  });
});

test("monthly summary deduplicates requests and calculates leave portions", () => {
  const duplicateWithoutDetails = {
    id: "leave-1",
    status: "APPROVED",
    startDate: "2026-09-22",
    endDate: "2026-09-22",
    isPartDay: true,
    leaveType: { name: "Vacation" },
    daysList: [],
  };
  const duplicateWithDetails = {
    ...duplicateWithoutDetails,
    daysList: [
      { day: "2026-09-22", leaveHours: 4, workingHoursInDay: 8 },
    ],
  };
  const denied = {
    id: "leave-2",
    status: "DENIED",
    startDate: "2026-09-23",
    endDate: "2026-09-23",
    leaveType: { name: "Vacation" },
  };
  const user = {
    workWeek: [1, 2, 3, 4, 5],
    upcomingLeaves: [duplicateWithoutDetails, denied],
    history: [duplicateWithDetails],
    today: [],
  };

  const summary = vacationTrackerMonthSummary(
    user,
    createPeriod("2026-09"),
  );
  assert.equal(summary.leaveRequests.length, 1);
  assert.equal(summary.approvedLeaveHours, 4);
  assert.deepEqual(summary.days, [
    {
      date: "2026-09-22",
      leaveType: "Vacation",
      hours: 4,
      workingHours: 8,
      portion: 0.5,
      fullDay: false,
      requestId: "leave-1",
    },
  ]);
});

test("fallback leave ranges respect workweek and month boundaries", () => {
  const summary = vacationTrackerMonthSummary(
    {
      workWeek: [1, 2, 3, 4, 5],
      upcomingLeaves: [
        {
          id: "leave-1",
          status: "APPROVED",
          startDate: "2026-08-31",
          endDate: "2026-09-06",
          isPartDay: false,
          leaveType: { name: "Vacation" },
        },
      ],
    },
    createPeriod("2026-09"),
  );
  assert.deepEqual(
    summary.days.map((day) => day.date),
    ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
  );
  assert.equal(summary.days.every((day) => day.fullDay), true);
});
