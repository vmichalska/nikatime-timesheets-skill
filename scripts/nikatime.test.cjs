const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

delete process.env.NIKATIME_DISABLE_SESSION_CACHE;

const {
  normalizeNikaTimeCookie,
  parseArgs,
  readCachedSessionCookie,
  writeCachedSessionCookie,
} = require("./nikatime.cjs");

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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nikatime-cache-test-"));
  const cachePath = path.join(directory, "session.json");
  try {
    run(cachePath);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
}

test("default Chrome import is explicit", () => {
  assert.equal(parseArgs(["show", "--month", "2026-09"]).importChrome, false);
  assert.equal(
    parseArgs(["show", "--month", "2026-09", "--import-chrome"]).importChrome,
    true,
  );
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
    try {
      writeCachedSessionCookie(validCookie(), cachePath);
      assert.equal(fs.existsSync(cachePath), false);
      assert.equal(readCachedSessionCookie(cachePath), null);
    } finally {
      delete process.env.NIKATIME_DISABLE_SESSION_CACHE;
    }
  });
});

test("cache validation rejects the wrong domain or weakened cookie flags", () => {
  assert.throws(
    () => normalizeNikaTimeCookie(validCookie({ domain: "example.com" })),
    /invalid NikaTime cookie/,
  );
  assert.throws(
    () => normalizeNikaTimeCookie(validCookie({ httpOnly: false })),
    /invalid NikaTime cookie/,
  );
});
