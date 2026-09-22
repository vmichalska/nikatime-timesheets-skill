const { API_ORIGIN } = require("./config.cjs");
const { isAuthFailure, parseMaybeJson } = require("./date-utils.cjs");

function createNikaTimeClient(period, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required");
  }

  async function apiFetch(
    pathname,
    { method = "GET", body, cookieValue } = {},
  ) {
    const headers = { Cookie: `authCookie=${cookieValue}` };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json;charset=UTF-8";
    }
    const response = await fetchImpl(`${API_ORIGIN}${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "follow",
    });
    const text = await response.text();
    return {
      status: response.status,
      body: parseMaybeJson(text),
      finalUrl: response.url,
    };
  }

  function periodQuery(targetUser) {
    const start = period.start.replaceAll("-", "");
    const end = period.end.replaceAll("-", "");
    return (
      `dateStart=${start}&dateEnd=${end}` +
      `&targetUser=${encodeURIComponent(targetUser)}`
    );
  }

  async function directSession(cookieValue) {
    return apiFetch("/api/web/session", { cookieValue });
  }

  async function directWorkloadOnce(cookieValue) {
    const session = await directSession(cookieValue);
    const userId = session.body?.result?.user?.userId;
    if (!userId || session.status !== 200 || session.body?.ok !== true) {
      return {
        status: session.status,
        body: session.body,
        finalUrl: session.finalUrl,
      };
    }
    return apiFetch(`/api/web/user/workload?${periodQuery(userId)}`, {
      cookieValue,
    });
  }

  async function directDropdown(cookieValue, userId) {
    return apiFetch(`/api/web/project/common/dropdown?${periodQuery(userId)}`, {
      cookieValue,
    });
  }

  async function submitPlan(cookieValue, plan) {
    return apiFetch("/api/web/records", {
      method: "POST",
      body: plan,
      cookieValue,
    });
  }

  async function deleteDates(cookieValue, dates, targetUser) {
    return apiFetch("/api/web/records", {
      method: "DELETE",
      body: dates.map((date) => ({
        date: date.replaceAll("-", ""),
        targetUser,
      })),
      cookieValue,
    });
  }

  return {
    apiFetch,
    deleteDates,
    directDropdown,
    directSession,
    directWorkloadOnce,
    submitPlan,
  };
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

module.exports = { createNikaTimeClient, isValidWorkloadResult };
