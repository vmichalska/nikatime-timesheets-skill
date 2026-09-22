const assert = require("node:assert/strict");
const test = require("node:test");

const { createPeriod } = require("../lib/date-utils.cjs");
const {
  createNikaTimeClient,
  isValidWorkloadResult,
} = require("../lib/nikatime-api.cjs");

function response(status, body, url = "https://app.nikatime.com/result") {
  return {
    status,
    url,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

test("workload lookup uses the session user and compact period dates", async () => {
  const calls = [];
  const responses = [
    response(200, { ok: true, result: { user: { userId: "user/one" } } }),
    response(200, { ok: true, result: { records: [] } }),
  ];
  const client = createNikaTimeClient(createPeriod("2026-09"), async (...args) => {
    calls.push(args);
    return responses.shift();
  });

  const result = await client.directWorkloadOnce("secret-cookie");

  assert.equal(result.body.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "https://app.nikatime.com/api/web/session");
  assert.equal(calls[0][1].headers.Cookie, "authCookie=secret-cookie");
  assert.match(calls[1][0], /dateStart=20260901/);
  assert.match(calls[1][0], /dateEnd=20260930/);
  assert.match(calls[1][0], /targetUser=user%2Fone/);
});

test("record writes serialize the exact payload and method", async () => {
  const calls = [];
  const client = createNikaTimeClient(createPeriod("2026-09"), async (...args) => {
    calls.push(args);
    return response(200, { ok: true });
  });
  const plan = [{ date: "20260922", projectId: "p", hours: 8, notes: "" }];

  await client.submitPlan("cookie", plan);
  await client.deleteDates("cookie", ["2026-09-22"], "user-1");

  assert.equal(calls[0][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[0][1].body), plan);
  assert.equal(calls[1][1].method, "DELETE");
  assert.deepEqual(JSON.parse(calls[1][1].body), [
    { date: "20260922", targetUser: "user-1" },
  ]);
});

test("API responses retain non-JSON bodies for useful errors", async () => {
  const client = createNikaTimeClient(
    createPeriod("2026-09"),
    async () => response(502, "gateway unavailable"),
  );
  const result = await client.apiFetch("/api/test", { cookieValue: "cookie" });
  assert.equal(result.body, "gateway unavailable");
});

test("workload validity rejects auth failures and malformed successes", () => {
  assert.equal(
    isValidWorkloadResult({ status: 200, body: { ok: true, result: {} } }),
    true,
  );
  assert.equal(
    isValidWorkloadResult({ status: 401, body: { ok: false } }),
    false,
  );
  assert.equal(isValidWorkloadResult({ status: 200, body: null }), false);
});
