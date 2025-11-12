"use strict";
const HARD_PAGE_CAP = 20;
const FETCH_TIMEOUT = 15000;

function buildAuthHeaders(token) {
  if (!token) return {};
  if (token.startsWith("glpat-")) return { "Private-Token": token };
  if (token === "$CI_JOB_TOKEN" || token.startsWith("gljob-"))
    return { "JOB-TOKEN": token };
  return { Authorization: `Bearer ${token}` };
}

async function safeFetch(url, opts = {}, attempt = 0) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const txt = await res.text().catch(() => "");
    if (res.status === 429 || res.status >= 500) {
      const raHeader = Number(res.headers.get("retry-after"));
      const backoff = raHeader
        ? raHeader * 1000
        : Math.min(32000, 1000 * 2 ** attempt);
      if (attempt < 5) {
        await sleep(backoff);
        return safeFetch(url, opts, attempt + 1);
      }
    }
    if (!res.ok)
      throw new Error(`HTTP ${res.status} ${url} :: ${txt.slice(0, 200)}`);
    return { res, txt };
  } finally {
    clearTimeout(id);
  }
}

async function glGetOnce(BASE_URL, TOKEN, path, query = {}) {
  const u = new URL(`${BASE_URL}/api/v4${path}`);
  if (!("per_page" in query)) query.per_page = 100;

  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) {
      v.forEach((item) => u.searchParams.append(k, String(item)));
    } else if (v !== undefined && v !== null) {
      u.searchParams.set(k, String(v));
    }
  }

  // ✅ اینجاست که باید توکن رو تو هدر ست کنی
  const headers = {
    ...buildAuthHeaders(TOKEN),
    "Content-Type": "application/json",
  };

  const { res, txt } = await safeFetch(u, {
    headers,
  });

  let body;
  try {
    body = txt ? JSON.parse(txt) : [];
  } catch {
    body = [];
  }

  return {
    body,
    headers: {
      nextPage: res.headers.get("x-next-page"),
      page: res.headers.get("x-page"),
      totalPages: res.headers.get("x-total-pages"),
      ratelimitRemaining:
        res.headers.get("ratelimit-remaining") ||
        res.headers.get("x-ratelimit-remaining"),
    },
  };
}


async function glGetAll(
  BASE_URL,
  TOKEN,
  path,
  query = {},
  hardCap = HARD_PAGE_CAP
) {
  let page = 1;
  const out = [];
  while (page <= hardCap) {
    const { body, headers } = await glGetOnce(BASE_URL, TOKEN, path, {
      ...query,
      page,
    });
    if (Array.isArray(body)) out.push(...body);
    else if (body) out.push(body);
    const next = Number(headers.nextPage || 0);
    if (!next) break;
    page = next;
  }
  return out;
}

module.exports = { glGetOnce, glGetAll, buildAuthHeaders };
