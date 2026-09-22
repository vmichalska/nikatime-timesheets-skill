const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  PROFILE_DIR,
  SESSION_CACHE_PATH,
  SESSION_CACHE_VERSION,
  SLACK_LOGIN_URL,
  SOURCE_CHROME_COOKIE_DB,
} = require("./config.cjs");
const { loadPlaywright } = require("./dependencies.cjs");
const {
  isAuthFailure,
  isNikaTimeApiUrl,
  isOverviewWorkload,
  parseMaybeJson,
} = require("./date-utils.cjs");

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

  const output = execFileSync(
    "python3",
    ["-c", program, SOURCE_CHROME_COOKIE_DB],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
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
    const expectedHostHash = crypto
      .createHash("sha256")
      .update(record.host)
      .digest();
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
  const payload = `${JSON.stringify(
    {
      version: SESSION_CACHE_VERSION,
      updatedAt: new Date().toISOString(),
      cookie,
    },
    null,
    2,
  )}\n`;

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
    (process.env.NIKATIME_IMPORT_CHROME === "1" &&
      process.env.NIKATIME_SKIP_CHROME_IMPORT !== "1");
  if (importRequested) {
    const cookie = prepareExistingChromeCookie();
    if (cookie) return { cookie, source: "default-chrome" };
    console.warn(
      "No reusable NikaTime session was imported from the default Chrome profile.",
    );
  }

  const cookie = readCachedSessionCookie();
  return { cookie, source: cookie ? "session-cache" : null };
}

async function seedBrowserSession(context, cookie) {
  if (!cookie) return false;
  await context.addCookies([cookie]);
  console.log(
    "Seeded the dedicated browser with a reusable NikaTime session (value hidden).",
  );
  return true;
}

async function loadWorkloadOnce(page, period) {
  const responsePromise = page
    .waitForResponse((response) => isOverviewWorkload(response.url()), {
      timeout: 30_000,
    })
    .catch(() => null);

  await page.goto(period.overviewUrl, { waitUntil: "commit", timeout: 60_000 });
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

async function loadWorkload(page, period) {
  let result = await loadWorkloadOnce(page, period);
  const redirectedToSignIn = /www\.nikatime\.com\/sign-in/i.test(
    result.finalUrl,
  );

  if (
    redirectedToSignIn ||
    result.status === 0 ||
    isAuthFailure(result.status, result.body)
  ) {
    await completeSlackLogin(page);
    result = await loadWorkloadOnce(page, period);
  }

  if (isAuthFailure(result.status, result.body)) {
    await completeSlackLogin(page);
    result = await loadWorkloadOnce(page, period);
  }

  if (
    result.status < 200 ||
    result.status >= 300 ||
    !result.body ||
    result.body.ok !== true
  ) {
    throw new Error(
      `Could not load ${period.label} workload (HTTP ${result.status}): ` +
        JSON.stringify(result.body || result.error),
    );
  }
  return result.body.result;
}

async function readContextAuthCookie(context) {
  const cookies = await context.cookies("https://app.nikatime.com");
  const candidate = cookies.find((item) => item.name === "authCookie");
  return candidate ? normalizeNikaTimeCookie(candidate) : null;
}

function cookieMetadata(cookie, source) {
  return {
    ...(source ? { source } : {}),
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expires:
      cookie.expires > 0
        ? new Date(cookie.expires * 1000).toISOString()
        : "browser session",
  };
}

async function printCookieMetadata(context) {
  const cookie = await readContextAuthCookie(context);
  if (!cookie) {
    console.log("authCookie: not present");
    return null;
  }
  console.log("authCookie:", cookieMetadata(cookie));
  return cookie;
}

function printDirectCookieMetadata(session) {
  if (!session.cookie) {
    console.log("authCookie: not present");
    return;
  }
  console.log(
    "authCookie:",
    cookieMetadata(session.cookie, session.source),
  );
}

async function establishBrowserSession(
  period,
  seedCookie,
  { forceHeaded = false } = {},
) {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });

  const apiCalls = [];
  function attachApiListener(context) {
    context.on("request", (request) => {
      if (!isNikaTimeApiUrl(request.url())) return;
      apiCalls.push({
        method: request.method(),
        url: request.url(),
        body: request.postData()
          ? parseMaybeJson(request.postData())
          : undefined,
      });
    });
  }

  async function launchContext(headless) {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless,
      viewport: null,
    });
    attachApiListener(context);
    return context;
  }

  let headless = !forceHeaded;
  let context = await launchContext(headless);
  let page = context.pages()[0] || (await context.newPage());
  if (seedCookie) await seedBrowserSession(context, seedCookie);

  let workload;
  if (headless) {
    const probe = await loadWorkloadOnce(page, period);
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
      workload = await loadWorkload(page, period);
    } else if (
      probe.status < 200 ||
      probe.status >= 300 ||
      !probe.body ||
      probe.body.ok !== true
    ) {
      workload = await loadWorkload(page, period);
    } else {
      workload = probe.body.result;
    }
  } else {
    workload = await loadWorkload(page, period);
  }

  return { context, page, apiCalls, workload };
}

async function renewCookieViaBrowser(period) {
  const { context } = await establishBrowserSession(period, null);
  try {
    const cookie = await readContextAuthCookie(context);
    if (!cookie) {
      throw new Error(
        "Session established in Chrome but no authCookie was set; cannot continue.",
      );
    }
    persistSessionCookie(cookie);
    return cookie;
  } finally {
    await context.close();
  }
}

module.exports = {
  establishBrowserSession,
  normalizeNikaTimeCookie,
  persistSessionCookie,
  prepareInitialSession,
  printCookieMetadata,
  printDirectCookieMetadata,
  readCachedSessionCookie,
  renewCookieViaBrowser,
  writeCachedSessionCookie,
};
