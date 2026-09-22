const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeNikaTimeCookie,
  readCachedSessionCookie,
  writeCachedSessionCookie,
} = require("../lib/nikatime-session.cjs");

function validCookie(overrides = {}) {
  return {
    name: "authCookie",
    value: "test-session-value",
    domain: "app.nikatime.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function withTemporaryCache(run) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nikatime-cache-test-"),
  );
  const cachePath = path.join(directory, "session.json");
  try {
    run(cachePath);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
}

test.beforeEach(() => {
  delete process.env.NIKATIME_DISABLE_SESSION_CACHE;
});

test.afterEach(() => {
  delete process.env.NIKATIME_DISABLE_SESSION_CACHE;
});

test("session cache round-trips with owner-only permissions", () => {
  withTemporaryCache((cachePath) => {
    const expected = normalizeNikaTimeCookie(validCookie());
    writeCachedSessionCookie(expected, cachePath);

    assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
    assert.deepEqual(readCachedSessionCookie(cachePath), expected);
  });
});

test("reading a session cache repairs overly broad permissions", () => {
  withTemporaryCache((cachePath) => {
    writeCachedSessionCookie(validCookie(), cachePath);
    fs.chmodSync(cachePath, 0o644);

    assert.equal(readCachedSessionCookie(cachePath).value, "test-session-value");
    assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
  });
});

test("expired cached sessions are ignored", () => {
  withTemporaryCache((cachePath) => {
    writeCachedSessionCookie(validCookie({ expires: 1 }), cachePath);
    assert.equal(readCachedSessionCookie(cachePath), null);
  });
});

test("session caching can be disabled without touching the cache path", () => {
  withTemporaryCache((cachePath) => {
    process.env.NIKATIME_DISABLE_SESSION_CACHE = "1";
    writeCachedSessionCookie(validCookie(), cachePath);

    assert.equal(fs.existsSync(cachePath), false);
    assert.equal(readCachedSessionCookie(cachePath), null);
  });
});

test("cache validation rejects the wrong domain or weakened flags", () => {
  assert.throws(
    () => normalizeNikaTimeCookie(validCookie({ domain: "example.com" })),
    /invalid NikaTime cookie/,
  );
  assert.throws(
    () => normalizeNikaTimeCookie(validCookie({ httpOnly: false })),
    /invalid NikaTime cookie/,
  );
  assert.throws(
    () => normalizeNikaTimeCookie(validCookie({ secure: false })),
    /invalid NikaTime cookie/,
  );
});

test("malformed cache data is ignored without exposing its contents", () => {
  withTemporaryCache((cachePath) => {
    fs.writeFileSync(cachePath, "not-json", { mode: 0o600 });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    try {
      assert.equal(readCachedSessionCookie(cachePath), null);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Ignoring the local NikaTime session cache/);
    assert.doesNotMatch(warnings[0], /test-session-value/);
  });
});
