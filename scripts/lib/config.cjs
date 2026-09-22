const os = require("node:os");
const path = require("node:path");

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
  path.join(NIKATIME_STATE_DIR, "vacationtracker-chrome-profile");
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

module.exports = {
  API_ORIGIN,
  PROFILE_DIR,
  SESSION_CACHE_PATH,
  SESSION_CACHE_VERSION,
  SLACK_LOGIN_URL,
  SOURCE_CHROME_COOKIE_DB,
  SOURCE_CHROME_LOCAL_STORAGE,
  VACATION_TRACKER_GRAPHQL_URL,
  VACATION_TRACKER_ORIGIN,
  VACATION_TRACKER_PROFILE_DIR,
  VACATION_TRACKER_PROFILE_URL,
};
