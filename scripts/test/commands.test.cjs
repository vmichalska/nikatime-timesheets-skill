const assert = require("node:assert/strict");
const test = require("node:test");

const { createSessionController, withAuthRetry } = require("../lib/commands.cjs");
const { createPeriod } = require("../lib/date-utils.cjs");

const period = createPeriod("2026-09");

function validWorkloadResult(cookieValue) {
  return {
    status: 200,
    body: {
      ok: true,
      result: { userId: "user", records: [], cookieValue },
    },
  };
}

test("session controller reuses a valid cached session", async () => {
  const seen = [];
  const client = {
    directWorkloadOnce: async (cookieValue) => {
      seen.push(cookieValue);
      return validWorkloadResult(cookieValue);
    },
  };
  let renewals = 0;
  const controller = createSessionController(
    period,
    client,
    { cookie: { value: "cached" }, source: "session-cache" },
    {
      renewCookie: async () => {
        renewals += 1;
        return { value: "renewed" };
      },
    },
  );

  const workload = await controller.ensureWorkload();
  assert.equal(workload.cookieValue, "cached");
  assert.deepEqual(seen, ["cached"]);
  assert.equal(renewals, 0);
});

test("session controller renews once after a rejected cached session", async () => {
  const seen = [];
  const client = {
    directWorkloadOnce: async (cookieValue) => {
      seen.push(cookieValue);
      if (cookieValue === "expired") {
        return { status: 401, body: { ok: false } };
      }
      return validWorkloadResult(cookieValue);
    },
  };
  let renewals = 0;
  const controller = createSessionController(
    period,
    client,
    { cookie: { value: "expired" }, source: "session-cache" },
    {
      renewCookie: async () => {
        renewals += 1;
        return { value: "renewed" };
      },
    },
  );

  const workload = await controller.ensureWorkload();
  assert.equal(workload.cookieValue, "renewed");
  assert.deepEqual(seen, ["expired", "renewed"]);
  assert.equal(renewals, 1);
  assert.equal(controller.session.source, "browser-profile");
});

test("default-Chrome imports are persisted only after successful validation", async () => {
  const persisted = [];
  const cookie = { value: "imported" };
  const controller = createSessionController(
    period,
    { directWorkloadOnce: async () => validWorkloadResult("imported") },
    { cookie, source: "default-chrome" },
    { persistCookie: (value) => persisted.push(value) },
  );

  await controller.ensureWorkload();
  assert.deepEqual(persisted, [cookie]);
});

test("auth retry renews once and reruns the operation", async () => {
  let attempts = 0;
  let renewals = 0;
  const controller = {
    renew: async () => {
      renewals += 1;
    },
  };
  const result = await withAuthRetry(controller, async () => {
    attempts += 1;
    return attempts === 1
      ? { status: 401, body: { ok: false } }
      : { status: 200, body: { ok: true } };
  });

  assert.equal(result.status, 200);
  assert.equal(attempts, 2);
  assert.equal(renewals, 1);
});
