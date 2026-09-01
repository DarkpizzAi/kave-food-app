/* Kave Food, Phase 2: GitHub Contents API client.

   No app logic. Typed get / put against one private repo. The app pushes the
   token in with github.setToken(); nothing here reads localStorage or the
   store. Errors are plain Error objects with a `.gh` kind:

     offline | unauthorized | notFound | conflict | rateLimited | http

   rateLimited carries `.resetAt` (epoch ms). notModified is not an error:
   getFile returns { notModified: true } on a 304.
*/
"use strict";

const github = {
  config: {
    owner: "DarkpizzAi",
    repo: "kave-hub",
    branch: "main",
    listPath: "food/data/shopping-list.json",
    recipesPath: "food/data/recipes.json",
  },
  // GitHub's suggested minimum seconds between polls, if it ever sends one
  pollInterval: 60,
};

(() => {
  const API = "https://api.github.com";
  let token = "";

  github.setToken = (t) => { token = (t || "").trim(); };
  github.hasToken = () => !!token;

  /* ---- base64 <-> UTF-8 (the API wraps its base64 at 60 cols) ---- */
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob((b64 || "").replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  github._b64 = { encode: b64encode, decode: b64decode }; // exposed for tests

  function ghError(kind, extra) {
    const e = new Error((extra && extra.message) || kind);
    e.gh = kind;
    if (extra) Object.assign(e, extra);
    return e;
  }

  function contentsUrl(path, withRef) {
    const c = github.config;
    const base = `${API}/repos/${c.owner}/${c.repo}/contents/${path}`;
    return withRef ? `${base}?ref=${encodeURIComponent(c.branch)}` : base;
  }

  async function request(method, url, body, etag) {
    if (!token) throw ghError("unauthorized", { message: "no token set" });
    const headers = {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (etag) headers["If-None-Match"] = etag;
    if (body) headers["Content-Type"] = "application/json";

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
    } catch (e) {
      throw ghError("offline", { cause: e });
    }

    const poll = Number(res.headers.get("X-Poll-Interval"));
    if (poll > 0) github.pollInterval = Math.max(60, poll);

    if (res.status === 304 || res.ok) return res;

    if (res.status === 401) throw ghError("unauthorized", { status: 401 });
    if (res.status === 404) throw ghError("notFound", { status: 404 });
    if (res.status === 409) throw ghError("conflict", { status: 409 });
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("X-RateLimit-Remaining");
      const retryAfter = Number(res.headers.get("Retry-After"));
      const reset = Number(res.headers.get("X-RateLimit-Reset")) * 1000;
      if (remaining === "0" || retryAfter > 0 || res.status === 429) {
        throw ghError("rateLimited", {
          status: res.status,
          resetAt: retryAfter > 0
            ? Date.now() + retryAfter * 1000
            : (reset || Date.now() + 60000),
        });
      }
      // 403 with rate limit left = a permission / SSO problem, not throttling
      throw ghError("unauthorized", { status: 403 });
    }

    let message = "";
    try { message = (await res.json()).message; } catch (e) { /* no body */ }
    throw ghError("http", { status: res.status, message: message || ("HTTP " + res.status) });
  }

  /* ---- public ---- */

  // { json, sha, etag } on 200, { notModified: true } on 304
  github.getFile = async (path, opts) => {
    const res = await request("GET", contentsUrl(path, true), null, opts && opts.etag);
    if (res.status === 304) return { notModified: true };
    const body = await res.json();
    return {
      json: JSON.parse(b64decode(body.content)),
      sha: body.sha,
      etag: res.headers.get("ETag") || null,
    };
  };

  // value is committed as JSON.stringify(value, null, 1) + "\n" (matches the
  // seed tooling, so the app's commits diff cleanly). Returns { sha, commit }.
  github.putFile = async (path, value, sha, message) => {
    const payload = {
      message: message || ("update " + path),
      content: b64encode(JSON.stringify(value, null, 1) + "\n"),
      branch: github.config.branch,
    };
    if (sha) payload.sha = sha;
    const res = await request("PUT", contentsUrl(path, false), payload);
    const out = await res.json();
    return { sha: out.content && out.content.sha, commit: out.commit && out.commit.sha };
  };

  // { login } - used only for the "connected as" check in Settings
  github.getUser = async () => {
    const res = await request("GET", API + "/user");
    const u = await res.json();
    return { login: u.login };
  };
})();
