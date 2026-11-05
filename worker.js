var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var DEFAULT_UPSTREAM_BASE = "https://agentrouter.org/v1";
const UPSTREAM_KEY_ENVS = ["UPSTREAM_API_KEY", "UPSTREAM_API_KEY_1"];
const SESSION_HEADER_NAMES = ["x-session-id", "session_id", "x-conversation-id", "conversation_id"];
const ROUTING_LOG_LIMIT = 20;
const D1_SCHEMA_VERSION = 1;
// BEGIN GENERATED D1 INITIALIZATION
const D1_INITIALIZATION = {
  "schema_version": 1,
  "source_sha256": "37052e6fee84f73f778f2a9a0c3bf35f10c6e8c7000519010b06c70254fa8f89",
  "statements": [
    "CREATE TABLE IF NOT EXISTS proxy_stats ( id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, session_requests INTEGER NOT NULL DEFAULT 0 CHECK (session_requests >= 0), default_requests INTEGER NOT NULL DEFAULT 0 CHECK (default_requests >= 0), created_at INTEGER NOT NULL );",
    "INSERT OR IGNORE INTO proxy_stats (id, schema_version, created_at) VALUES (1, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);",
    "CREATE TABLE IF NOT EXISTS proxy_key_state ( credential_hash TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0), success_calls INTEGER NOT NULL DEFAULT 0 CHECK (success_calls >= 0), error_calls INTEGER NOT NULL DEFAULT 0 CHECK (error_calls >= 0), cooldown_until INTEGER NOT NULL DEFAULT 0, cooldown_reason TEXT, cooldown_generation INTEGER NOT NULL DEFAULT 0, last_error_at INTEGER, last_error_status INTEGER, last_error_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK (success_calls + error_calls <= calls) );",
    "CREATE TABLE IF NOT EXISTS proxy_requests ( id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at INTEGER NOT NULL );",
    "CREATE INDEX IF NOT EXISTS proxy_requests_started ON proxy_requests (started_at);",
    "CREATE TABLE IF NOT EXISTS proxy_attempts ( id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES proxy_requests (id), credential_hash TEXT NOT NULL REFERENCES proxy_key_state (credential_hash), key_name TEXT NOT NULL, cooldown_generation INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'success', 'error')), http_status INTEGER, error_message TEXT, cooldown_until INTEGER NOT NULL DEFAULT 0, cooldown_reason TEXT, routing_json TEXT NOT NULL CHECK (json_valid(routing_json)) );",
    "CREATE INDEX IF NOT EXISTS proxy_attempts_started ON proxy_attempts (started_at);",
    "CREATE INDEX IF NOT EXISTS proxy_attempts_request ON proxy_attempts (request_id);",
    "CREATE INDEX IF NOT EXISTS proxy_attempts_pending ON proxy_attempts (credential_hash, started_at) WHERE outcome = 'pending';",
    "CREATE TRIGGER IF NOT EXISTS proxy_request_count AFTER INSERT ON proxy_requests BEGIN UPDATE proxy_stats SET session_requests = session_requests + (NEW.source <> 'default'), default_requests = default_requests + (NEW.source = 'default') WHERE id = 1; END;",
    "CREATE TRIGGER IF NOT EXISTS proxy_attempt_count AFTER INSERT ON proxy_attempts BEGIN UPDATE proxy_key_state SET calls = calls + 1, updated_at = MAX(updated_at, NEW.started_at) WHERE credential_hash = NEW.credential_hash; END;",
    "CREATE TRIGGER IF NOT EXISTS proxy_attempt_outcome AFTER UPDATE OF outcome ON proxy_attempts WHEN NEW.outcome <> OLD.outcome BEGIN UPDATE proxy_key_state SET success_calls = success_calls + (NEW.outcome = 'success') - (OLD.outcome = 'success'), error_calls = error_calls + (NEW.outcome = 'error') - (OLD.outcome = 'error'), last_error_status = CASE WHEN NEW.outcome = 'error' AND NEW.finished_at >= COALESCE(last_error_at, 0) THEN NEW.http_status ELSE last_error_status END, last_error_message = CASE WHEN NEW.outcome = 'error' AND NEW.finished_at >= COALESCE(last_error_at, 0) THEN NEW.error_message ELSE last_error_message END, last_error_at = CASE WHEN NEW.outcome = 'error' AND NEW.finished_at >= COALESCE(last_error_at, 0) THEN NEW.finished_at ELSE last_error_at END, updated_at = MAX(updated_at, NEW.finished_at) WHERE credential_hash = NEW.credential_hash; END;",
    "CREATE TRIGGER IF NOT EXISTS proxy_attempt_cooldown AFTER UPDATE OF outcome ON proxy_attempts WHEN NEW.outcome = 'error' AND OLD.outcome <> 'error' AND NEW.cooldown_until > 0 BEGIN UPDATE proxy_key_state SET cooldown_reason = CASE WHEN NEW.cooldown_until >= cooldown_until THEN NEW.cooldown_reason ELSE cooldown_reason END, cooldown_until = MAX(cooldown_until, NEW.cooldown_until) WHERE credential_hash = NEW.credential_hash AND cooldown_generation = NEW.cooldown_generation; END;"
  ]
};
// END GENERATED D1 INITIALIZATION
const DEFAULT_KEY_COOLDOWN_SECONDS = 300;
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const IN_FLIGHT_WINDOW_MS = 60 * 60 * 1000;
const ADMIN_COOKIE = "__Host-proxy-admin";
const ADMIN_SESSION_SECONDS = 3600;
// Only the instance label and response-to-attempt association are isolate-local.
const instanceInfo = { id: null, started_at: null };
const upstreamAttempts = new WeakMap();
// Clients send PROXY_API_KEY; platform keys are read only from Worker secrets.
var worker_default = {
  async fetch(request, env = {}, executionCtx) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    const proxyKey = typeof env.PROXY_API_KEY === "string" ? env.PROXY_API_KEY.trim() : "";
    if (!proxyKey) {
      return jsonError(500, "PROXY_API_KEY must be configured");
    }
    if (/\s/.test(proxyKey)) {
      return jsonError(500, "API keys must not contain whitespace or a Bearer prefix");
    }
    // Browser administration works before D1 has been initialized.
    const adminPath = ["/login", "/logout", "/init"].includes(pathname);
    const adminSession = (adminPath || pathname === "/health" && ["GET", "HEAD"].includes(request.method)) ?
      await readAdminSession(request, proxyKey) : null;
    if (pathname === "/login") return adminLogin(request, proxyKey, adminSession);
    if (pathname === "/logout") return adminLogout(request, proxyKey, adminSession);
    const authorization = request.headers.get("Authorization") || "";
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    const token = match?.[1] || (pathname === "/health" ? url.searchParams.get("token") : null);
    // Explicit API credentials take precedence; a browser cookie cannot authorize model calls.
    const cookieAuth = !authorization && !token && adminSession !== null;
    if (!cookieAuth && (!token || !await keysEqual(token, proxyKey))) {
      if (pathname === "/init" && !authorization && ["GET", "HEAD"].includes(request.method)) {
        return adminRedirect("/login");
      }
      const response = jsonError(401, "Invalid or missing API key", "authentication_error");
      response.headers.set("WWW-Authenticate", 'Bearer realm="proxy"');
      return response;
    }
    if (!instanceInfo.id) {
      instanceInfo.id = crypto.randomUUID();
      instanceInfo.started_at = new Date().toISOString();
    }
    if (pathname === "/init") {
      if (request.method === "GET" || request.method === "HEAD") {
        // Visiting or refreshing the page never writes to the database.
        if (!cookieAuth) return adminRedirect("/login");
        return adminInitPage(request, await adminCSRF(adminSession, proxyKey));
      }
      if (request.method !== "POST") {
        const response = jsonError(405, "Use GET, HEAD or POST for /init");
        response.headers.set("Allow", "GET, HEAD, POST, OPTIONS");
        return response;
      }
      const csrf = cookieAuth ? await adminCSRF(adminSession, proxyKey) : null;
      const failure = cookieAuth ? await validAdminForm(request, csrf) : null;
      if (failure) return adminForbiddenFor(failure, request);
      const context = { binding: env.DB, executionCtx, keys: [], proxyKey, requestId: crypto.randomUUID() };
      try {
        const response = await initializeDatabase(context, env.ASSETS);
        return cookieAuth ? adminInitPage(request, csrf, { result: await response.json() }) : response;
      } catch (error) {
        const response = stateErrorResponse(error);
        return cookieAuth ? adminInitPage(request, csrf, { error: (await response.json()).error.message, status: response.status }) : response;
      }
    }
    let keys;
    try {
      keys = configuredUpstreamKeys(env);
    } catch (error) {
      return jsonError(500, error.message);
    }
    const cooldownSeconds = Number(env.KEY_COOLDOWN_SECONDS ?? DEFAULT_KEY_COOLDOWN_SECONDS);
    if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 1 || cooldownSeconds > 86400) {
      return jsonError(500, "KEY_COOLDOWN_SECONDS must be an integer from 1 to 86400");
    }
    const upstreamKey = {
      keys, proxyKey, requestHeaders: request.headers, requestPath: pathname, requestMethod: request.method,
      binding: env.DB, executionCtx, cooldownSeconds,
      logToConsole: !["off", "false", "0"].includes(String(env.ROUTING_LOGS ?? "on").trim().toLowerCase())
    };
    if (pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        const response = jsonError(405, "Use GET or HEAD for /health");
        response.headers.set("Allow", "GET, HEAD, OPTIONS");
        return response;
      }
      await assignUpstreamKey(upstreamKey, request.headers, null, url.searchParams);
      try {
        return await healthResponse(upstreamKey, request.method === "HEAD");
      } catch (error) {
        const response = stateErrorResponse(error);
        response.headers.set("Cache-Control", "no-store");
        return request.method === "HEAD" ? new Response(null, response) : response;
      }
    }
    if (!keys.length) return jsonError(500, "Configure UPSTREAM_API_KEY or UPSTREAM_API_KEY_1");
    let upstreamBase;
    try {
      const base = new URL(env.UPSTREAM_BASE || DEFAULT_UPSTREAM_BASE);
      if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
        throw new Error("invalid upstream URL");
      }
      upstreamBase = base.toString().replace(/\/+$/, "");
    } catch {
      return jsonError(500, "UPSTREAM_BASE must be an HTTPS URL without credentials, query or fragment");
    }
    const upstreamApi = env.UPSTREAM_API || "auto";
    if (!["auto", "responses", "chat"].includes(upstreamApi)) {
      return jsonError(500, "UPSTREAM_API must be auto, responses, or chat");
    }
    if (request.method === "POST" && pathname === "/responses") {
      return handleResponses(request, upstreamBase, upstreamKey, upstreamApi);
    }
    if (request.method === "POST" && pathname === "/chat/completions") {
      return handleChatCompletions(request, upstreamBase, upstreamKey, upstreamApi);
    }
    await assignUpstreamKey(upstreamKey, request.headers);
    return passthrough(request, url, upstreamBase, upstreamKey);
  },
  async scheduled(_event, env = {}, executionCtx) {
    const context = { binding: env.DB, executionCtx, keys: [] };
    const db = await stateSession(context);
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    // All-time counters remain; only request/attempt history is removed.
    const results = await stateBatch(context, [
      db.prepare("SELECT schema_version FROM proxy_stats WHERE id = 1"),
      db.prepare("DELETE FROM proxy_attempts WHERE started_at < ? AND (SELECT schema_version FROM proxy_stats WHERE id = 1) = ?").bind(cutoff, D1_SCHEMA_VERSION),
      db.prepare("DELETE FROM proxy_requests WHERE started_at < ? AND NOT EXISTS (SELECT 1 FROM proxy_attempts WHERE request_id = proxy_requests.id) AND (SELECT schema_version FROM proxy_stats WHERE id = 1) = ?").bind(cutoff, D1_SCHEMA_VERSION)
    ], "history_cleanup");
    checkSchema(results[0]);
  }
};
function adminHeaders() {
  return {
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  };
}
function adminRedirect(location, cookie) {
  return new Response(null, { status: 303, headers: { ...adminHeaders(), Location: location,
    ...(cookie ? { "Set-Cookie": cookie } : {}) } });
}
function escapeAdminHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function adminHTML(title, content, status = 200, head = false) {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAdminHTML(title)} · 代理管理</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f7fa;color:#172435;font:16px/1.6 system-ui,-apple-system,sans-serif}
main{max-width:520px;margin:9vh auto;padding:32px;background:white;border:1px solid #dbe2ea;border-radius:16px}
h1{font-size:26px;margin:8px 0 16px}h2{font-size:20px}p{color:#506077}label{display:block;font-weight:600}
input{width:100%;margin:8px 0 18px;padding:12px;border:1px solid #8795a8;border-radius:8px;font:inherit}
button{display:inline-block;padding:11px 18px;border:0;border-radius:8px;background:#2457cf;color:white;font:inherit;cursor:pointer}
button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #8aaef8;outline-offset:3px}
a{color:#2457cf}.notice{padding:14px 18px;border-radius:8px;background:#eef8f2}.error{background:#fff0ed;color:#8f2920;overflow-wrap:anywhere}
nav{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e3e8ef;padding-bottom:16px;margin-bottom:24px}
nav button{background:#edf1f7;color:#34435b;padding:6px 12px}.eyebrow{font-size:13px;color:#68768a;margin:0}
@media(max-width:560px){main{margin:24px 16px;padding:24px}}
</style></head><body><main>${content}</main></body></html>`;
  return new Response(head ? null : html, { status, headers: { ...adminHeaders(), "Content-Type": "text/html; charset=utf-8" } });
}
async function adminMAC(proxyKey, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(proxyKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function readAdminSession(request, proxyKey) {
  const values = (request.headers.get("Cookie") || "").split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(ADMIN_COOKIE + "="));
  if (values.length !== 1) return null;
  const value = values[0].slice(ADMIN_COOKIE.length + 1);
  const match = /^(1\.(\d{10})\.[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(value);
  if (!match) return null;
  const expires = Number(match[2]);
  const now = Math.floor(Date.now() / 1000);
  if (expires <= now || expires > now + ADMIN_SESSION_SECONDS) return null;
  const signature = await adminMAC(proxyKey, "proxy-admin-session:" + new URL(request.url).origin + ":" + match[1]);
  return await keysEqual(match[3], signature) ? match[1] : null;
}
function adminCookie(value, maxAge = ADMIN_SESSION_SECONDS) {
  return `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
async function adminCSRF(session, proxyKey) {
  return adminMAC(proxyKey, "proxy-admin-csrf:" + session);
}
function sameOriginAdminPost(request) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site === "cross-site" || site === "same-site") return false;
  // Safari sends Origin: null (and some proxies strip it) on same-origin form
  // POSTs; Sec-Fetch-Site and the session-bound CSRF token carry the check.
  const origin = request.headers.get("Origin");
  return origin === null || origin === "null" || origin === new URL(request.url).origin;
}
async function readAdminForm(request) {
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get("Content-Type") || "")) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  try {
    const decoder = new TextDecoder();
    let body = "", size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) return new URLSearchParams(body + decoder.decode());
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); return null; }
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
async function validAdminForm(request, csrf) {
  if (!sameOriginAdminPost(request)) return "source";
  const form = await readAdminForm(request);
  return form?.getAll("csrf").length === 1 && await keysEqual(form.get("csrf"), csrf) ? null : "token";
}
function adminSourceDetail(request) {
  const header = (name) => request.headers.get(name) ?? "(缺失)";
  return ["请求来源=" + new URL(request.url).origin, "Origin=" + header("Origin"),
    "Sec-Fetch-Site=" + header("Sec-Fetch-Site"), "User-Agent=" + (header("User-Agent") || "(缺失)").slice(0, 120)].join(" · ");
}
function adminForbidden(detail) {
  return adminHTML("请求未通过验证", `<h1>请求未通过验证</h1><p>请返回登录页面后重试。</p>${
    detail ? `<p class="eyebrow">${escapeAdminHTML(detail)}</p>` : ""}<a href="/login">返回登录页面</a>`, 403);
}
function adminForbiddenFor(failure, request) {
  return adminForbidden(failure === "source" ? adminSourceDetail(request) : "会话已过期或表单令牌不匹配，请重新登录后再试。");
}
function adminMethodError() {
  const response = adminHTML("请求方法不支持", '<h1>请求方法不支持</h1>', 405);
  response.headers.set("Allow", "GET, HEAD, POST, OPTIONS");
  return response;
}
function adminLoginPage(request, error = "", status = 200) {
  return adminHTML("登录", `<p class="eyebrow">代理管理</p><h1>登录</h1><p>输入代理 Key，登录后即可初始化数据库。</p>
${error ? `<p class="notice error" role="alert">${escapeAdminHTML(error)}</p>` : ""}
<form method="post" action="/login"><label for="key">代理 Key</label>
<input id="key" name="key" type="password" autocomplete="current-password" required maxlength="4096" aria-describedby="key-help">
<p id="key-help">填写 PROXY_API_KEY 的值。</p><button type="submit">登录</button></form>`, status, request.method === "HEAD");
}
async function adminLogin(request, proxyKey, session) {
  if (["GET", "HEAD"].includes(request.method)) return session ? adminRedirect("/init") : adminLoginPage(request);
  if (request.method !== "POST") return adminMethodError();
  if (!sameOriginAdminPost(request)) return adminForbidden(adminSourceDetail(request));
  const form = await readAdminForm(request);
  if (!form || form.getAll("key").length !== 1) return adminLoginPage(request, "登录请求无效，请重新输入代理 Key。", 400);
  if (!await keysEqual(form.get("key").trim(), proxyKey)) return adminLoginPage(request, "代理 Key 不正确，请重试。", 401);
  const payload = `1.${Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS}.${crypto.randomUUID().replace(/-/g, "")}`;
  const signature = await adminMAC(proxyKey, "proxy-admin-session:" + new URL(request.url).origin + ":" + payload);
  return adminRedirect("/init", adminCookie(payload + "." + signature));
}
async function adminLogout(request, proxyKey, session) {
  if (request.method !== "POST") {
    const response = adminMethodError();
    response.headers.set("Allow", "POST, OPTIONS");
    return response;
  }
  if (!session) return adminRedirect("/login", adminCookie("", 0));
  const failure = await validAdminForm(request, await adminCSRF(session, proxyKey));
  if (failure) return adminForbiddenFor(failure, request);
  return adminRedirect("/login", adminCookie("", 0));
}
function adminInitPage(request, csrf, { result, error, status = 200 } = {}) {
  const csrfField = `<input type="hidden" name="csrf" value="${escapeAdminHTML(csrf)}">`;
  return adminHTML("初始化数据库", `<nav><a href="/init">代理管理</a><form method="post" action="/logout">${csrfField}<button type="submit">退出登录</button></form></nav>
<h1>初始化数据库</h1><p>首次使用时，请点击下方按钮完成初始化。重复初始化会保留已有数据。</p>
${result ? '<div class="notice" role="status"><h2>初始化完成</h2><p>已确认 4 张表和 4 个触发器，数据库已就绪。</p></div>' : ""}
${error ? `<div class="notice error" role="alert"><h2>初始化未完成</h2><p>请检查数据库绑定和部署配置后重试。</p><p>${escapeAdminHTML(error)}</p></div>` : ""}
<form method="post" action="/init">${csrfField}<button type="submit">${result ? "再次初始化" : "初始化数据库"}</button></form>
<p><a href="/health">查看运行状态</a></p>`, status, request.method === "HEAD");
}
function configuredUpstreamKeys(env) {
  const keys = [];
  for (let index = 0; index < UPSTREAM_KEY_ENVS.length; index++) {
    const name = UPSTREAM_KEY_ENVS[index];
    const value = env[name];
    if (value == null || value === "") continue;
    if (typeof value !== "string" || /\s/.test(value.trim())) throw new Error(`${name} must be a key string without whitespace or a Bearer prefix`);
    const secret = value.trim();
    if (secret) keys.push({ index, name, secret });
  }
  return keys;
}
function sessionIdentifier(headers, body, searchParams) {
  for (const name of SESSION_HEADER_NAMES) {
    const value = headers.get(name)?.trim();
    if (value) return { value, source: name };
  }
  try {
    const metadata = JSON.parse(headers.get("x-codex-turn-metadata") || "null");
    for (const name of ["thread_id", "threadId"]) {
      const value = typeof metadata?.[name] === "string" ? metadata[name].trim() : "";
      if (value) return { value, source: "x-codex-turn-metadata." + name };
    }
  } catch {}
  // Keep Codex metadata priority stable, with direct headers as a fallback.
  for (const name of ["thread-id", "thread_id", "session-id"]) {
    const value = headers.get(name)?.trim();
    if (value) return { value, source: name };
  }
  for (const name of ["session_id", "prompt_cache_key"]) {
    const value = searchParams?.get(name)?.trim();
    if (value) return { value, source: "query." + name };
  }
  for (const name of ["session_id", "sessionId", "conversation_id", "conversationId"]) {
    const value = typeof body?.metadata?.[name] === "string" ? body.metadata[name].trim() : "";
    if (value) return { value, source: "metadata." + name };
  }
  const value = typeof body?.prompt_cache_key === "string" ? body.prompt_cache_key.trim() : "";
  return value ? { value, source: "prompt_cache_key" } : null;
}
async function assignUpstreamKey(context, headers, body, searchParams) {
  const identifier = sessionIdentifier(headers, body, searchParams);
  context.routingSource = identifier?.source || "default";
  context.selectedKey = context.keys[0] || null;
  context.bodyFields = body ? Object.keys(body).slice(0, 32).map((name) => redactSecret(name, context).slice(0, 128)) : [];
  context.metadataFields = isObject(body?.metadata) ?
    Object.keys(body.metadata).slice(0, 32).map((name) => redactSecret(name, context).slice(0, 128)) : [];
  context.sessionFingerprint = null;
  if (identifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identifier.value));
    const bytes = new Uint8Array(digest);
    context.sessionFingerprint = Array.from(bytes.subarray(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (context.keys.length > 1) context.selectedKey = context.keys[bytes[bytes.length - 1] % context.keys.length];
  }
  context.preferredKey = context.selectedKey;
}
function routingAttemptLog(context, key, target, at) {
  const upstreamPath = new URL(target).pathname;
  const previous = context.lastRoutingAttempt;
  const reason = !previous ? (context.routingSource === "default" ? "default" : "session_hash") :
    previous.key !== key.name ? "key_failover" : previous.path !== upstreamPath ? "endpoint_fallback" : "retry";
  const log = {
    event: "upstream_routing", at: new Date(at).toISOString(), instance_id: instanceInfo.id,
    request_id: context.requestId, attempt: (context.attemptCount || 0) + 1, reason,
    method: context.requestMethod, path: context.requestPath, upstream_path: upstreamPath,
    user_agent: redactSecret(context.requestHeaders.get("User-Agent") || "", context).slice(0, 256),
    source: context.routingSource, session_fingerprint: context.sessionFingerprint,
    preferred_key: context.preferredKey?.name || null, selected_key: key.name,
    header_names: Array.from(context.requestHeaders.keys()).slice(0, 32).map((name) => redactSecret(name, context).slice(0, 128)),
    body_fields: context.bodyFields, metadata_fields: context.metadataFields
  };
  // Field values and full prompts are not included; redact secrets even from diagnostic strings.
  return JSON.stringify(log, (_name, value) => typeof value === "string" ? redactSecret(value, context) : value);
}
class D1StateError extends Error {}
class KeyCooldownError extends Error {
  constructor(retryAfter) {
    super("All eligible upstream keys are cooling down; retry later");
    this.retryAfter = retryAfter;
  }
}
async function initializeDatabase(context, assets) {
  const db = await stateSession(context);
  let initializer = D1_INITIALIZATION;
  let source = "embedded";
  if (assets != null) {
    try {
      if (typeof assets.fetch !== "function") throw new Error("Invalid Assets binding");
      const response = await assets.fetch(new Request("https://worker-assets.invalid/d1-init.json"));
      if (!response.ok) throw new Error("Missing initializer asset");
      initializer = await response.json();
      source = "assets";
    } catch {
      throw new D1StateError("Cannot read ASSETS/d1-init.json; deploy the assets directory with the Worker");
    }
  }
  if (initializer?.schema_version !== D1_SCHEMA_VERSION ||
      initializer?.source_sha256 !== D1_INITIALIZATION.source_sha256 ||
      !Array.isArray(initializer.statements) ||
      JSON.stringify(initializer.statements) !== JSON.stringify(D1_INITIALIZATION.statements)) {
    throw new D1StateError("D1 initializer asset is invalid or outdated; deploy matching worker.js and assets/d1-init.json");
  }
  // The deployment's complete statements keep trigger bodies intact. Request SQL is never used.
  const results = await stateBatch(context, [
    ...initializer.statements.map((statement) => db.prepare(statement)),
    db.prepare("SELECT schema_version FROM proxy_stats WHERE id = 1"),
    db.prepare(`SELECT type, COUNT(*) AS count FROM sqlite_master WHERE name IN (
      'proxy_stats', 'proxy_key_state', 'proxy_requests', 'proxy_attempts',
      'proxy_request_count', 'proxy_attempt_count', 'proxy_attempt_outcome', 'proxy_attempt_cooldown'
    ) AND type IN ('table', 'trigger') GROUP BY type`)
  ], "initialize_database");
  checkSchema(results[results.length - 2]);
  const counts = Object.fromEntries(results[results.length - 1].results.map((row) => [row.type, row.count]));
  if (counts.table !== 4 || counts.trigger !== 4) throw new D1StateError("D1 initialization is incomplete");
  return new Response(JSON.stringify({ status: "initialized", scope: "d1", schema_version: D1_SCHEMA_VERSION,
    source, tables: counts.table, triggers: counts.trigger }), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders() }
  });
}
async function stateSession(context) {
  if (context.db) return context.db;
  if (!context.binding || typeof context.binding.withSession !== "function") {
    throw new D1StateError("Bind a Cloudflare D1 database as DB, then log in at /login and initialize it at /init");
  }
  try {
    // Health and cooldown decisions must not start from a stale read replica.
    context.db = context.binding.withSession("first-primary");
    await Promise.all(context.keys.map(async (key) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key.secret));
      key.credentialHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }));
    return context.db;
  } catch {
    throw new D1StateError("DB must be a working Cloudflare D1 database binding");
  }
}
function logStateError(context, operation) {
  console.error(JSON.stringify({ event: "d1_state_error", at: new Date().toISOString(), operation,
    instance_id: instanceInfo.id, request_id: context.requestId || null, message: "D1 state operation failed" }));
}
async function stateBatch(context, statements, operation) {
  try {
    const results = await context.db.batch(statements);
    if (results.some((result) => result.success === false)) throw new Error("D1 batch failed");
    return results;
  } catch (error) {
    logStateError(context, operation);
    const message = /no such (?:table|column)|has no column/i.test(String(error?.message)) ?
      "D1 schema is missing or incompatible; log in at /login and initialize DB at /init" :
      "D1 state is unavailable; check the DB binding and database";
    throw new D1StateError(message);
  }
}
function checkSchema(result) {
  if (result.results?.[0]?.schema_version !== D1_SCHEMA_VERSION) {
    throw new D1StateError("D1 schema is missing or incompatible; log in at /login and initialize DB at /init");
  }
}
function stateErrorResponse(error) {
  const response = jsonError(error instanceof KeyCooldownError ? 429 : 503,
    error instanceof D1StateError || error instanceof KeyCooldownError ? error.message : "D1 state is unavailable",
    error instanceof KeyCooldownError ? "rate_limit_error" : "state_error");
  response.headers.set("Cache-Control", "no-store");
  if (error instanceof KeyCooldownError) response.headers.set("Retry-After", String(error.retryAfter));
  return response;
}
function fetchErrorResponse(error, context, prefix = "upstream fetch failed: ") {
  return error instanceof D1StateError || error instanceof KeyCooldownError ? stateErrorResponse(error) :
    jsonError(502, prefix + redactSecret(error?.message || String(error), context));
}
async function reserveUpstreamKey(context, target, requestedKey) {
  const db = await stateSession(context);
  const first = requestedKey || context.selectedKey;
  if (!first) throw new Error("No upstream API key configured");
  const candidates = [first];
  // Initial routing can bypass a shared cooldown. Explicit retries use only their alternate.
  if (!requestedKey && !context.lastRoutingAttempt) {
    const alternate = context.keys.find((key) => key.secret !== first.secret);
    if (alternate) candidates.push(alternate);
  }
  const now = Date.now();
  context.requestId ||= crypto.randomUUID();
  context.requestStartedAt ||= now;
  const attemptId = crypto.randomUUID();
  const log = routingAttemptLog(context, first, target, now);
  const reason = JSON.parse(log).reason;
  const hashes = [...new Set(context.keys.map((key) => key.credentialHash))];
  const placeholders = hashes.map(() => "?").join(", ");
  const candidateSql = candidates.map(() => "SELECT ? AS credential_hash, ? AS key_name, ? AS priority").join(" UNION ALL ");
  const eligibleSql = `SELECT candidates.credential_hash, candidates.key_name, state.cooldown_generation
    FROM (${candidateSql}) AS candidates
    JOIN proxy_key_state AS state ON state.credential_hash = candidates.credential_hash
    WHERE state.cooldown_until <= ? AND (SELECT schema_version FROM proxy_stats WHERE id = 1) = ?
    ORDER BY candidates.priority LIMIT 1`;
  const eligibleArgs = [...candidates.flatMap((key, index) => [key.credentialHash, key.name, index]), now, D1_SCHEMA_VERSION];
  const statements = [
    db.prepare("SELECT schema_version FROM proxy_stats WHERE id = 1"),
    ...hashes.map((hash) => db.prepare(`INSERT OR IGNORE INTO proxy_key_state (credential_hash, created_at, updated_at)
      SELECT ?, ?, ? WHERE (SELECT schema_version FROM proxy_stats WHERE id = 1) = ?`).bind(hash, now, now, D1_SCHEMA_VERSION)),
    db.prepare(`UPDATE proxy_key_state SET cooldown_until = 0, cooldown_reason = NULL,
      cooldown_generation = cooldown_generation + 1, updated_at = MAX(updated_at, ?)
      WHERE credential_hash IN (${placeholders}) AND cooldown_until > 0 AND cooldown_until <= ?
        AND (SELECT schema_version FROM proxy_stats WHERE id = 1) = ?`).bind(now, ...hashes, now, D1_SCHEMA_VERSION),
    db.prepare(`INSERT OR IGNORE INTO proxy_requests (id, source, started_at)
      SELECT ?, ?, ? WHERE EXISTS (${eligibleSql})`).bind(context.requestId, context.routingSource, context.requestStartedAt, ...eligibleArgs),
    db.prepare(`INSERT OR IGNORE INTO proxy_attempts
      (id, request_id, credential_hash, key_name, cooldown_generation, started_at, routing_json)
      SELECT ?, ?, eligible.credential_hash, eligible.key_name, eligible.cooldown_generation, ?,
        json_set(?, '$.selected_key', eligible.key_name, '$.reason', CASE WHEN eligible.key_name = ? THEN ? ELSE 'key_cooldown' END)
      FROM (${eligibleSql}) AS eligible`).bind(attemptId, context.requestId, now, log, first.name, reason, ...eligibleArgs),
    db.prepare("SELECT * FROM proxy_attempts WHERE id = ?").bind(attemptId),
    db.prepare(`SELECT credential_hash, cooldown_until FROM proxy_key_state WHERE credential_hash IN (${placeholders})`).bind(...hashes)
  ];
  // Selection, cooldown gating, reservation and counters are one atomic D1 batch.
  const results = await stateBatch(context, statements, "reserve_attempt");
  checkSchema(results[0]);
  const row = results[results.length - 2].results?.[0];
  if (!row) {
    const states = results[results.length - 1].results || [];
    const deadlines = states.filter((state) => candidates.some((key) => key.credentialHash === state.credential_hash))
      .map((state) => state.cooldown_until).filter((deadline) => deadline > now);
    if (!deadlines.length) throw new D1StateError("D1 key state is missing; initialize DB with worker.d1.sql");
    throw new KeyCooldownError(Math.max(1, Math.ceil((Math.min(...deadlines) - now) / 1000)));
  }
  const key = context.keys.find((key) => key.name === row.key_name);
  const storedLog = JSON.parse(row.routing_json);
  context.selectedKey = key;
  context.lastRoutingAttempt = { key: key.name, path: storedLog.upstream_path };
  context.attemptCount = storedLog.attempt;
  if (context.logToConsole) console.log(row.routing_json);
  return { id: attemptId, key, context, outcome: "pending", generation: row.cooldown_generation };
}
const KEY_FAILOVER_CODES = new Set([
  "rate_limit_exceeded", "rate_limited", "too_many_requests", "insufficient_quota",
  "insufficient_user_quota", "insufficient_token_quota", "quota_exceeded", "quota_exhausted",
  "token_quota_exhausted", "insufficient_balance", "insufficient_credits",
  "billing_hard_limit_reached", "billing_not_active", "invalid_api_key", "api_key_expired",
  "api_key_revoked", "api_key_disabled", "invalid_token", "token_expired", "token_revoked",
  "account_deactivated"
]);
function shouldFailoverKey(status, raw, context) {
  if (status === 401 || status === 429) return true;
  // HTTP-200 JSON/SSE errors can cool down a key without replaying the response.
  if (![200, 400, 402, 403].includes(status)) return false;
  let data;
  try { data = JSON.parse(raw); } catch {}
  const codes = [data?.error?.code, data?.error?.type, data?.response?.error?.code, data?.response?.error?.type, data?.code, data?.type];
  if (codes.some((code) => typeof code === "string" &&
      KEY_FAILOVER_CODES.has(redactSecret(code, context).trim().toLowerCase().replace(/[\s-]+/g, "_")))) return true;
  // Diagnostic metadata and echoed request fields are not evidence of a key failure.
  const detail = [data?.error?.message, data?.response?.error?.message, data?.message, data?.error, data?.response?.error, data].find((value) => typeof value === "string");
  const message = redactSecret(detail ?? (data === undefined ? raw : ""), context).toLowerCase();
  return /\b(?:insufficient (?:quota|balance|credits)|(?:quota|credits) (?:exceeded|exhausted|depleted)|(?:api[ _-]?key|token) (?:is )?(?:invalid|expired|revoked|disabled))\b/.test(message) ||
    /(?:额度|配额|余额)(?:已)?(?:不足|耗尽|用尽)|(?:api[ _-]?key|令牌|密钥)(?:已)?(?:无效|过期|失效|禁用)/i.test(message);
}
function cooldownDeadline(context, retryAfter, now) {
  const value = retryAfter?.trim() || "";
  if (/^\d+$/.test(value)) {
    const deadline = now + Number(value) * 1000;
    if (Number.isSafeInteger(deadline) && deadline <= 8640000000000000) return deadline;
  } else if (/^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)(?:,| )/i.test(value)) {
    const deadline = Date.parse(value);
    if (Number.isFinite(deadline)) return Math.max(now, deadline);
  }
  return now + context.cooldownSeconds * 1000;
}
function finishUpstreamAttempt(attempt, error, status = attempt?.httpStatus ?? null, raw = null) {
  if (!attempt || attempt.outcome === "error" || (!error && attempt.outcome !== "pending")) {
    return attempt?.pendingWrite || Promise.resolve();
  }
  const { context } = attempt;
  const now = Date.now();
  const outcome = error ? "error" : "success";
  const message = error ? redactSecret(error, context).slice(0, 1024) : null;
  const keyFailure = error && raw !== null && shouldFailoverKey(status, raw, context);
  const deadline = keyFailure ? cooldownDeadline(context, attempt.retryAfter, now) : 0;
  const reason = keyFailure ? (status === 401 ? "authentication_error" : status === 429 ? "rate_limit" : "quota_or_key_error") : null;
  attempt.outcome = outcome;
  // Serialize terminal/reclassification writes; failures cannot break successful model output.
  const write = (context.stateWrites || Promise.resolve()).then(async () => {
    await stateBatch(context, [context.db.prepare(`UPDATE proxy_attempts SET outcome = ?, finished_at = ?,
      http_status = ?, error_message = ?, cooldown_until = ?, cooldown_reason = ?
      WHERE id = ? AND (outcome = 'pending' OR (? = 'error' AND outcome = 'success'))`)
      .bind(outcome, now, status, message, deadline, reason, attempt.id, outcome)], "finish_attempt");
  }).catch(() => { attempt.persistenceError = true; });
  context.stateWrites = attempt.pendingWrite = write;
  context.executionCtx?.waitUntil(write);
  return write;
}
function recordUpstreamFailure(upstream, error) {
  return finishUpstreamAttempt(upstreamAttempts.get(upstream), error, upstream.status);
}
async function healthResponse(context, head) {
  const db = await stateSession(context);
  const { keys } = context;
  const now = Date.now();
  const hashes = [...new Set(keys.map((key) => key.credentialHash))];
  const keyFilter = hashes.length ? `credential_hash IN (${hashes.map(() => "?").join(", ")})` : "0";
  const results = await stateBatch(context, [
    db.prepare("SELECT * FROM proxy_stats WHERE id = 1"),
    db.prepare(`SELECT * FROM proxy_key_state WHERE ${keyFilter}`).bind(...hashes),
    db.prepare(`SELECT credential_hash, COUNT(*) AS in_flight FROM proxy_attempts
      WHERE ${keyFilter} AND outcome = 'pending' AND started_at >= ? GROUP BY credential_hash`).bind(...hashes, now - IN_FLIGHT_WINDOW_MS),
    db.prepare(`SELECT routing_json FROM (
      SELECT rowid AS ordinal, started_at, routing_json FROM proxy_attempts ORDER BY started_at DESC, rowid DESC LIMIT ?
    ) ORDER BY started_at, ordinal`).bind(ROUTING_LOG_LIMIT)
  ], "health");
  checkSchema(results[0]);
  const stats = results[0].results[0];
  const states = new Map(results[1].results.map((row) => [row.credential_hash, row]));
  const pending = new Map(results[2].results.map((row) => [row.credential_hash, row.in_flight]));
  const available = (key) => (states.get(key.credentialHash)?.cooldown_until || 0) <= now;
  const ordered = [context.preferredKey, ...keys.filter((key) => key !== context.preferredKey)].filter(Boolean);
  const selected = ordered.find(available);
  const status = !keys.length ? "error" : !selected ? "unavailable" : keys.every(available) ? "ok" : "degraded";
  const body = {
    status,
    scope: "d1",
    storage: { binding: "DB", schema_version: D1_SCHEMA_VERSION },
    instance: { ...instanceInfo },
    routing: { mode: "session_hash", source: context.routingSource,
      preferred_key: context.preferredKey?.name || null, selected_key: selected?.name || null },
    routing_stats: { session_requests: stats.session_requests, default_requests: stats.default_requests },
    routing_logs: results[3].results.map((row) => JSON.parse(row.routing_json)),
    keys: UPSTREAM_KEY_ENVS.map((name) => {
      const key = keys.find((key) => key.name === name);
      const state = key ? states.get(key.credentialHash) : null;
      const inFlight = key ? pending.get(key.credentialHash) || 0 : 0;
      const calls = state?.calls || 0, successes = state?.success_calls || 0, errors = state?.error_calls || 0;
      const retryAfter = key ? Math.max(0, Math.ceil(((state?.cooldown_until || 0) - now) / 1000)) : 0;
      const duplicate = key && keys.find((other) => other.index < key.index && other.credentialHash === key.credentialHash);
      return { name, key_configured: !!key, calls, success_calls: successes, error_calls: errors,
        last_error: state?.last_error_at == null ? null : { status: state.last_error_status,
          message: redactSecret(state.last_error_message, context), at: new Date(state.last_error_at).toISOString() },
        in_flight: inFlight, unknown_calls: Math.max(0, calls - successes - errors - inFlight),
        available: !!key && retryAfter === 0,
        cooldown_until: state?.cooldown_until ? new Date(state.cooldown_until).toISOString() : null,
        cooldown_reason: retryAfter ? state.cooldown_reason : null, retry_after_seconds: retryAfter,
        ...(duplicate ? { duplicate_of: duplicate.name } : {}) };
    })
  };
  return new Response(head ? null : JSON.stringify(body, null, 2), {
    status: selected ? 200 : 503,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(),
      ...(!selected && keys.length ? { "Retry-After": String(Math.max(1, Math.ceil((Math.min(...keys.map((key) => states.get(key.credentialHash)?.cooldown_until || 0)) - now) / 1000))) } : {}) }
  });
}
async function keysEqual(actual, expected) {
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const a = new Uint8Array(actualHash);
  const b = new Uint8Array(expectedHash);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
__name(keysEqual, "keysEqual");
async function readGenerationBody(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new Error("Invalid JSON body");
  }
  if (!isObject(body)) throw new Error("Request body must be a JSON object");
  if (typeof body.model !== "string" || !body.model.trim()) throw new Error("model must be a non-empty string");
  if (body.stream != null && typeof body.stream !== "boolean") throw new Error("stream must be a boolean");
  return body;
}
__name(readGenerationBody, "readGenerationBody");
function postGeneration(request, upstreamBase, upstreamKey, endpoint, body) {
  return fetchUpstream(`${upstreamBase}/${endpoint}`, {
    method: "POST", headers: buildUpstreamHeaders(request.headers, upstreamKey, body.stream === true),
    body: JSON.stringify(body), redirect: "manual", signal: request.signal
  }, upstreamKey, endpoint);
}
__name(postGeneration, "postGeneration");
function upstreamErrorMessage(raw, context) {
  try {
    const data = JSON.parse(raw);
    return data.error?.message || data.message || (typeof data.error === "string" ? data.error :
      JSON.stringify(data, (_name, value) => typeof value === "string" ? redactSecret(value, context) : value));
  } catch {
    return raw;
  }
}
async function fetchUpstream(target, init, context, protocol) {
  if (init.signal?.aborted) throw init.signal.reason || new Error("Request aborted before upstream fetch");
  let upstream, attempt = await reserveUpstreamKey(context, target);
  for (;;) {
    if (init.signal?.aborted) {
      await finishUpstreamAttempt(attempt, "Client cancelled before upstream connection");
      throw init.signal.reason || new Error("Request aborted before upstream fetch");
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${attempt.key.secret}`);
    try {
      upstream = await fetch(target, { ...init, headers });
    } catch (error) {
      await finishUpstreamAttempt(attempt, error.message || String(error));
      throw error;
    }
    attempt.httpStatus = upstream.status;
    attempt.retryAfter = upstream.headers.get("Retry-After");
    upstreamAttempts.set(upstream, attempt);
    const notModified = upstream.status === 304 && ["GET", "HEAD"].includes(init.method);
    if (upstream.status >= 300 && upstream.status < 400 && !notModified) {
      await finishUpstreamAttempt(attempt, "Upstream redirects are not supported", upstream.status);
      return upstream;
    }
    if (upstream.ok || notModified) break;
    let raw = "", message = `Upstream HTTP ${upstream.status}`;
    try {
      raw = await upstream.clone().text();
      if (raw) message = upstreamErrorMessage(raw, context);
    } catch {
      message = "Failed to read upstream error response";
    }
    await finishUpstreamAttempt(attempt, message, upstream.status, raw);
    const alternate = context.keys.find((key) => key.secret !== attempt.key.secret);
    if (attempt.persistenceError || context.keyFailoverUsed || !alternate || init.signal?.aborted || !shouldFailoverKey(upstream.status, raw, context)) return upstream;
    // Multipart uploads and other streaming request bodies cannot be safely replayed.
    if (init.body instanceof ReadableStream) return upstream;
    let replacement;
    try {
      replacement = await reserveUpstreamKey(context, target, alternate);
    } catch (error) {
      // Keep the real upstream error if the alternate is already blocked or D1 cannot reserve it.
      if (error instanceof KeyCooldownError || error instanceof D1StateError) return upstream;
      throw error;
    }
    context.keyFailoverUsed = true;
    await cancelUpstreamBody(upstream);
    attempt = replacement;
  }
  if (!upstream.body) {
    await finishUpstreamAttempt(attempt);
    return upstream;
  }
  const reader = upstream.body.getReader();
  const type = upstream.headers.get("Content-Type")?.toLowerCase() || "";
  const sse = type.startsWith("text/event-stream");
  const json = type.includes("application/json");
  const decoder = sse || json ? new TextDecoder() : null;
  const parser = sse ? createSSEParser() : null;
  let jsonText = "";
  function observe(value, done) {
    if (attempt.outcome !== "pending") return;
    const text = decoder ? decoder.decode(value, { stream: !done }) : "";
    if (sse) {
      for (const frame of parser.push(text, done)) {
        if (!frame.data || frame.event === "ping") continue;
        if (frame.data.trim() === "[DONE]") {
          if (protocol !== "responses") finishUpstreamAttempt(attempt);
          continue;
        }
        let event;
        try {
          event = JSON.parse(frame.data);
        } catch {
          finishUpstreamAttempt(attempt, "Upstream returned invalid SSE JSON", upstream.status);
          continue;
        }
        const eventType = event?.type || frame.event;
        if (event?.error || event?.response?.error || eventType === "error" || eventType === "response.failed" || eventType === "response.cancelled") {
          finishUpstreamAttempt(attempt, event?.error?.message || event?.response?.error?.message || event?.message || "Upstream stream failed", upstream.status, frame.data);
        } else if (eventType === "response.completed" || eventType === "response.incomplete") {
          finishUpstreamAttempt(attempt);
        }
      }
    } else if (json && jsonText !== null) {
      // Bound the diagnostic buffer; response bytes are always passed through.
      jsonText = jsonText.length + text.length <= 65536 ? jsonText + text : null;
    }
    if (done && attempt.outcome === "pending") {
      if (sse && protocol) {
        finishUpstreamAttempt(attempt, "Upstream stream ended before its terminal event", upstream.status);
        return;
      }
      if (json && jsonText !== null) {
        try {
          const data = JSON.parse(jsonText);
          if (data?.error || data?.status === "failed") {
            finishUpstreamAttempt(attempt, data.error?.message || upstreamErrorMessage(jsonText, context) || "Upstream request failed", upstream.status, jsonText);
            return;
          }
        } catch {
          finishUpstreamAttempt(attempt, "Upstream returned invalid JSON", upstream.status);
          return;
        }
      }
      finishUpstreamAttempt(attempt);
    }
  }
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        observe(value, done);
        if (done) {
          reader.releaseLock();
          await attempt.pendingWrite;
          controller.close();
        } else {
          controller.enqueue(value);
          if (attempt.outcome !== "pending") await attempt.pendingWrite;
        }
      } catch (error) {
        if (attempt.outcome === "pending") await finishUpstreamAttempt(attempt, error.message || String(error), upstream.status);
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel() {
      const write = attempt.outcome === "pending" ? finishUpstreamAttempt(attempt, "Client cancelled before upstream completion", upstream.status) : attempt.pendingWrite;
      try { await reader.cancel(); } finally { reader.releaseLock(); }
      await write;
    }
  });
  const response = new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
  upstreamAttempts.set(response, attempt);
  return response;
}
async function endpointUnsupported(upstream, endpoint) {
  if (![400, 404, 405, 501].includes(upstream.status)) return false;
  let text;
  try {
    text = (await upstream.clone().text()).toLowerCase();
    try {
      const data = JSON.parse(text);
      text = data.error?.message || data.message || text;
    } catch {
    }
  } catch {
    return false;
  }
  if (/unsupported (?:parameter|field|argument)|invalid (?:parameter|argument)|(?:参数|字段).{0,30}不支持|不支持.{0,10}(?:参数|字段)/.test(text)) return false;
  const path = endpoint === "responses" ? "(?:/v1)?/responses" : "(?:/v1)?/chat/completions";
  const unsupported = "(?:does not support|doesn't support|not supported|unsupported|不支持)";
  if (new RegExp(`${unsupported}[^.,;\\n]{0,60}${path}|${path}[^.,;\\n]{0,60}${unsupported}`).test(text)) return true;
  // Endpoint fallback is separate from key failover; keep it limited to unsupported endpoints.
  if ([404, 405, 501].includes(upstream.status) && !/model|模型/.test(text)) {
    return new RegExp(path).test(text) || /endpoint|route|method not allowed|not implemented/.test(text) ||
      /^\s*(?:404\s*)?not found\s*$/.test(text);
  }
  return false;
}
__name(endpointUnsupported, "endpointUnsupported");
async function forwardGeneration(upstream, upstreamKey) {
  if (upstream.status >= 300 && upstream.status < 400) {
    await cancelUpstreamBody(upstream);
    return jsonError(502, "Upstream redirects are not supported");
  }
  if (!upstream.ok) return upstreamError(upstream, upstreamKey);
  return new Response(upstream.body, {
    status: upstream.status, statusText: upstream.statusText, headers: proxyResponseHeaders(upstream.headers, upstreamKey)
  });
}
__name(forwardGeneration, "forwardGeneration");
async function handleResponses(request, upstreamBase, upstreamKey, upstreamApi) {
  let body;
  try {
    body = await readGenerationBody(request);
  } catch (error) {
    return jsonError(400, error.message);
  }
  await assignUpstreamKey(upstreamKey, request.headers, body);
  if (upstreamApi === "chat") return handleResponsesViaChat(request, upstreamBase, upstreamKey, body);
  let upstream;
  try {
    upstream = await postGeneration(request, upstreamBase, upstreamKey, "responses", body);
  } catch (error) {
    return fetchErrorResponse(error, upstreamKey);
  }
  if (upstreamApi === "auto" && await endpointUnsupported(upstream, "responses")) {
    await cancelUpstreamBody(upstream);
    return handleResponsesViaChat(request, upstreamBase, upstreamKey, body);
  }
  return forwardGeneration(upstream, upstreamKey);
}
__name(handleResponses, "handleResponses");
async function handleChatCompletions(request, upstreamBase, upstreamKey, upstreamApi) {
  let body;
  try {
    body = await readGenerationBody(request);
  } catch (error) {
    return jsonError(400, error.message);
  }
  await assignUpstreamKey(upstreamKey, request.headers, body);
  if (upstreamApi === "responses") return handleChatViaResponses(request, upstreamBase, upstreamKey, body);
  let upstream;
  try {
    upstream = await postGeneration(request, upstreamBase, upstreamKey, "chat/completions", body);
  } catch (error) {
    return fetchErrorResponse(error, upstreamKey);
  }
  if (upstreamApi === "auto" && await endpointUnsupported(upstream, "chat/completions")) {
    await cancelUpstreamBody(upstream);
    return handleChatViaResponses(request, upstreamBase, upstreamKey, body);
  }
  return forwardGeneration(upstream, upstreamKey);
}
__name(handleChatCompletions, "handleChatCompletions");
async function handleResponsesViaChat(request, upstreamBase, upstreamKey, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError(400, "Request body must be a JSON object");
  }
  if (typeof body.model !== "string" || !body.model.trim()) {
    return jsonError(400, "model must be a non-empty string");
  }
  if (typeof body.input !== "string" && !Array.isArray(body.input)) {
    return jsonError(400, "input must be a string or an array");
  }
  if (body.stream != null && typeof body.stream !== "boolean") {
    return jsonError(400, "stream must be a boolean");
  }
  if (body.background === true) {
    return jsonError(400, "Background responses are not supported by this adapter");
  }
  if (body.previous_response_id != null || body.conversation != null) {
    return jsonError(400, "This adapter is stateless; send conversation history in input instead of previous_response_id or conversation");
  }
  if (body.tools != null && (!Array.isArray(body.tools) || body.tools.some((tool) => !tool || tool.type !== "function" || typeof tool.name !== "string" || !tool.name))) {
    return jsonError(400, "Only named function tools are supported by this adapter");
  }
  if (body.tool_choice != null && !["auto", "none", "required"].includes(body.tool_choice) &&
      (!body.tool_choice || body.tool_choice.type !== "function" || typeof body.tool_choice.name !== "string" || !body.tool_choice.name)) {
    return jsonError(400, "tool_choice must be auto, none, required, or a named function");
  }
  const isStream = body.stream === true;
  let chatPayload;
  try {
    chatPayload = responsesToChat(body);
  } catch (error) {
    return jsonError(400, error.message);
  }
  const headers = buildUpstreamHeaders(request.headers, upstreamKey, isStream);
  let upstream;
  try {
    upstream = await fetchUpstream(`${upstreamBase}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(chatPayload),
      redirect: "manual",
      signal: request.signal
    }, upstreamKey, "chat/completions");
  } catch (e) {
    return fetchErrorResponse(e, upstreamKey);
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await cancelUpstreamBody(upstream);
    return jsonError(502, "Upstream redirects are not supported");
  }
  if (!upstream.ok) {
    return upstreamError(upstream, upstreamKey);
  }
  if (isStream) {
    if (!upstream.body || !upstream.headers.get("Content-Type")?.toLowerCase().startsWith("text/event-stream")) {
      await recordUpstreamFailure(upstream, "Upstream did not return an SSE stream");
      await cancelUpstreamBody(upstream);
      return jsonError(502, "Upstream did not return an SSE stream");
    }
    return streamChatToResponses(upstream, body, upstreamKey);
  }
  return nonStreamChatToResponses(upstream, body, upstreamKey);
}
__name(handleResponsesViaChat, "handleResponsesViaChat");
function chatContentToResponses(content, role) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("Chat message content must be a string or an array");
  return content.map((part) => {
    if (!isObject(part)) throw new Error("Chat content parts must be objects");
    if (part.type === "text" && typeof part.text === "string") {
      return role === "assistant" ? { type: "output_text", text: part.text, annotations: [] } : { type: "input_text", text: part.text };
    }
    if (part.type === "image_url" && role === "user") {
      const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof imageUrl !== "string" || !imageUrl) throw new Error("image_url must contain a URL");
      return { type: "input_image", image_url: imageUrl, detail: part.image_url?.detail || "auto" };
    }
    throw new Error(`Unsupported Chat content part for Responses: ${part.type}`);
  });
}
__name(chatContentToResponses, "chatContentToResponses");
function chatToResponses(body) {
  if (!Array.isArray(body.messages) || !body.messages.length) throw new Error("messages must be a non-empty array");
  if (body.n != null && body.n !== 1) throw new Error("Responses adaptation supports only n=1");
  for (const name of ["functions", "function_call", "logit_bias", "seed", "prediction", "audio"]) {
    if (body[name] != null) throw new Error(`${name} is not supported by the Responses adapter`);
  }
  if (body.logprobs || body.top_logprobs || body.presence_penalty || body.frequency_penalty ||
      (body.stop != null && !(Array.isArray(body.stop) && body.stop.length === 0)) ||
      (body.modalities != null && (!Array.isArray(body.modalities) || body.modalities.some((type) => type !== "text")))) {
    throw new Error("Requested Chat-only generation options cannot be represented by Responses");
  }
  const input = [];
  for (const message of body.messages) {
    if (!isObject(message)) throw new Error("Each Chat message must be an object");
    if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string" || !message.tool_call_id || message.content === undefined) {
        throw new Error("Tool messages require a tool_call_id and content");
      }
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: normalizeToolOutput(message.content) });
      continue;
    }
    if (!["system", "developer", "user", "assistant"].includes(message.role)) throw new Error("Unsupported Chat message role");
    let content = message.content == null && message.role === "assistant" ? "" : chatContentToResponses(message.content, message.role);
    if (message.refusal != null) {
      if (message.role !== "assistant" || typeof message.refusal !== "string") throw new Error("Invalid assistant refusal");
      if (typeof content === "string") content = content ? [{ type: "output_text", text: content, annotations: [] }] : [];
      content.push({ type: "refusal", refusal: message.refusal });
    }
    if (content.length || message.role !== "assistant") {
      input.push({ type: "message", role: message.role, content,
        ...(message.role === "assistant" && Array.isArray(content) ? { id: rid("msg"), status: "completed" } : {}) });
    }
    if (message.tool_calls != null) {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) throw new Error("Invalid assistant tool_calls");
      for (const tool of message.tool_calls) {
        if (!isObject(tool) || tool.type !== "function" || typeof tool.id !== "string" || !tool.id ||
            !isObject(tool.function) || typeof tool.function.name !== "string" || !tool.function.name || typeof tool.function.arguments !== "string") {
          throw new Error("Only function tool calls with IDs, names, and string arguments are supported");
        }
        input.push({ type: "function_call", call_id: tool.id, name: tool.function.name, arguments: tool.function.arguments });
      }
    }
  }
  const payload = { model: body.model, input, stream: body.stream === true, store: false };
  for (const name of ["temperature", "top_p", "parallel_tool_calls", "metadata", "user", "service_tier", "safety_identifier", "prompt_cache_key", "prompt_cache_retention"]) {
    if (body[name] != null) payload[name] = body[name];
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens != null) {
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error("Token limit must be a positive integer");
    payload.max_output_tokens = maxTokens;
  }
  if (body.reasoning_effort != null) payload.reasoning = { effort: body.reasoning_effort };
  if (body.verbosity != null) payload.text = { verbosity: body.verbosity };
  if (body.response_format != null) {
    const format = body.response_format;
    if (!isObject(format)) throw new Error("response_format must be an object");
    const flat = format.type === "json_schema" ? { ...format.json_schema, type: "json_schema" } : { type: format.type };
    chatResponseFormat(flat);
    payload.text = { ...payload.text, format: flat };
  }
  if (body.tools != null) {
    if (!Array.isArray(body.tools)) throw new Error("tools must be an array");
    payload.tools = body.tools.map((tool) => {
      if (!isObject(tool) || tool.type !== "function" || !isObject(tool.function) || typeof tool.function.name !== "string" || !tool.function.name) {
        throw new Error("Only named function tools can be adapted to Responses");
      }
      return { ...tool.function, type: "function" };
    });
  }
  if (body.tool_choice != null) {
    const choice = body.tool_choice;
    if (["auto", "none", "required"].includes(choice)) payload.tool_choice = choice;
    else if (isObject(choice) && choice.type === "function" && typeof choice.function?.name === "string" &&
             payload.tools?.some((tool) => tool.name === choice.function.name)) {
      payload.tool_choice = { type: "function", name: choice.function.name };
    } else throw new Error("Unsupported Chat tool_choice");
  }
  return payload;
}
__name(chatToResponses, "chatToResponses");
async function handleChatViaResponses(request, upstreamBase, upstreamKey, body) {
  let payload;
  try {
    payload = chatToResponses(body);
  } catch (error) {
    return jsonError(400, error.message);
  }
  let upstream;
  try {
    upstream = await postGeneration(request, upstreamBase, upstreamKey, "responses", payload);
  } catch (error) {
    return fetchErrorResponse(error, upstreamKey);
  }
  if (!upstream.ok) return forwardGeneration(upstream, upstreamKey);
  if (body.stream === true) {
    if (!upstream.body || !upstream.headers.get("Content-Type")?.toLowerCase().startsWith("text/event-stream")) {
      await recordUpstreamFailure(upstream, "Upstream did not return a Responses SSE stream");
      await cancelUpstreamBody(upstream);
      return jsonError(502, "Upstream did not return a Responses SSE stream");
    }
    return streamResponsesToChat(upstream, body, upstreamKey);
  }
  let data;
  try {
    data = responsesToChatCompletion(await upstream.json(), body);
  } catch (error) {
    await recordUpstreamFailure(upstream, error.message);
    return jsonError(502, redactSecret(error.message, upstreamKey));
  }
  return new Response(JSON.stringify(data), { headers: proxyResponseHeaders(upstream.headers, upstreamKey, "application/json") });
}
__name(handleChatViaResponses, "handleChatViaResponses");
function chatUsage(usage) {
  if (!isObject(usage)) return null;
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    prompt_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0 }
  };
}
__name(chatUsage, "chatUsage");
function chatFinishReason(response, hasTools) {
  if (response.status === "incomplete") return response.incomplete_details?.reason === "content_filter" ? "content_filter" : "length";
  return hasTools ? "tool_calls" : "stop";
}
__name(chatFinishReason, "chatFinishReason");
function validateResponseCompletion(response) {
  if (!isObject(response) || !Array.isArray(response.output)) throw new Error("Upstream returned an invalid Responses response");
  if (response.status === "failed" || response.error) throw new Error(response.error?.message || "Upstream Responses request failed");
  if (!["completed", "incomplete"].includes(response.status)) throw new Error("Upstream Responses response has no terminal status");
}
__name(validateResponseCompletion, "validateResponseCompletion");
function responseMessageParts(item) {
  if (!isObject(item) || !Array.isArray(item.content)) throw new Error("Upstream returned invalid Responses message content");
  for (const part of item.content) {
    if (!isObject(part) || (part.type === "output_text" ? typeof part.text !== "string" :
        part.type === "refusal" ? typeof part.refusal !== "string" : true)) {
      throw new Error("Responses output contains unsupported message content");
    }
  }
  return item.content;
}
__name(responseMessageParts, "responseMessageParts");
function validateResponseTool(item) {
  if (!isObject(item) || typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name || typeof item.arguments !== "string") {
    throw new Error("Upstream Responses function call is missing its ID, name, or arguments");
  }
}
__name(validateResponseTool, "validateResponseTool");
function responsesToChatCompletion(response, body) {
  validateResponseCompletion(response);
  const text = [];
  const refusal = [];
  const tools = [];
  for (const item of response.output) {
    if (!isObject(item)) throw new Error("Upstream returned an invalid output item");
    if (item.type === "message") {
      for (const part of responseMessageParts(item)) {
        if (part.type === "output_text") text.push(part.text);
        else refusal.push(part.refusal);
      }
    } else if (item.type === "function_call") {
      validateResponseTool(item);
      tools.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
    } else if (item.type !== "reasoning") throw new Error(`Cannot adapt Responses output type ${item.type} to Chat Completions`);
  }
  const usage = chatUsage(response.usage);
  return {
    id: typeof response.id === "string" ? response.id.replace(/^resp_/, "chatcmpl_") : rid("chatcmpl"),
    object: "chat.completion", created: response.created_at || nowSec(), model: response.model || body.model,
    choices: [{ index: 0, message: { role: "assistant", content: text.length ? text.join("") : null,
      ...(refusal.length ? { refusal: refusal.join("") } : {}), ...(tools.length ? { tool_calls: tools } : {}) },
      finish_reason: chatFinishReason(response, tools.length > 0), logprobs: null }],
    ...(usage ? { usage } : {})
  };
}
__name(responsesToChatCompletion, "responsesToChatCompletion");
function streamResponsesToChat(upstream, body, upstreamKey) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const includeUsage = body.stream_options?.include_usage === true;
  const id = rid("chatcmpl");
  let model = body.model;
  let created = nowSec();
  let roleSent = false;
  const tools = new Map();
  const content = new Map();
  const send = (value) => writer.write(encoder.encode(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`));
  const chunk = (delta, finishReason = null) => send({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    ...(includeUsage ? { usage: null } : {})
  });
  async function ensureRole() {
    if (!roleSent) { roleSent = true; await chunk({ role: "assistant", content: "" }); }
  }
  function contentKey(event, type) {
    return `${event.output_index ?? event.item_id}:${event.content_index ?? 0}:${type}`;
  }
  async function emitContent(event, type, value, full = false) {
    if (typeof value !== "string") throw new Error("Upstream Responses content must be a string");
    const key = contentKey(event, type);
    const previous = content.get(key) || "";
    if (full && !value.startsWith(previous)) throw new Error("Upstream Responses content differs from its streamed deltas");
    const delta = full ? value.slice(previous.length) : value;
    content.set(key, full ? value : previous + value);
    if (delta) { await ensureRole(); await chunk({ [type === "refusal" ? "refusal" : "content"]: delta }); }
  }
  function toolState(event) {
    const key = event.output_index ?? event.item_id;
    if (key == null) throw new Error("Upstream function event has no output index or item ID");
    if (!tools.has(key)) tools.set(key, { index: tools.size, callId: "", name: "", arguments: "", sentArguments: 0, sentName: "", added: false });
    return tools.get(key);
  }
  async function emitTool(state) {
    if (!state.callId || !state.name) return;
    await ensureRole();
    if (!state.added) {
      state.added = true;
      state.sentName = state.name;
      await chunk({ tool_calls: [{ index: state.index, id: state.callId, type: "function", function: { name: state.name, arguments: "" } }] });
    } else if (state.name !== state.sentName) {
      if (!state.name.startsWith(state.sentName)) throw new Error("Upstream function name changed during streaming");
      await chunk({ tool_calls: [{ index: state.index, function: { name: state.name.slice(state.sentName.length) } }] });
      state.sentName = state.name;
    }
    const delta = state.arguments.slice(state.sentArguments);
    if (delta) {
      await chunk({ tool_calls: [{ index: state.index, function: { arguments: delta } }] });
      state.sentArguments = state.arguments.length;
    }
  }
  async function updateTool(event, item, full) {
    const state = toolState(event);
    if (item.call_id != null) {
      if (typeof item.call_id !== "string" || (state.added && item.call_id !== state.callId)) throw new Error("Upstream function call ID changed during streaming");
      state.callId = item.call_id;
    }
    if (item.name != null) {
      if (typeof item.name !== "string") throw new Error("Upstream returned an invalid function name");
      state.name = item.name;
    }
    if (item.arguments != null) {
      if (typeof item.arguments !== "string" || (full && !item.arguments.startsWith(state.arguments))) throw new Error("Upstream function arguments differ from their streamed deltas");
      state.arguments = full ? item.arguments : state.arguments + item.arguments;
    }
    await emitTool(state);
  }
  async function emitItem(item, outputIndex) {
    if (!isObject(item)) throw new Error("Upstream returned an invalid Responses output item");
    if (item.type === "message") {
      const parts = responseMessageParts(item);
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        await emitContent({ output_index: outputIndex, item_id: item.id, content_index: index }, part.type,
          part.type === "refusal" ? part.refusal : part.text, true);
      }
    } else if (item.type === "function_call") {
      validateResponseTool(item);
      await updateTool({ output_index: outputIndex, item_id: item.id }, item, true);
    } else if (item.type !== "reasoning") throw new Error(`Cannot adapt Responses output type ${item.type} to Chat Completions`);
  }
  (async () => {
    const reader = upstream.body.pipeThrough(new TextDecoderStream()).getReader();
    writer.closed.catch(() => reader.cancel().catch(() => {}));
    let terminal = false;
    try {
      for await (const frame of readSSE(reader)) {
        if (!frame.data || frame.event === "ping") continue;
        if (frame.data.trim() === "[DONE]") break;
        let event;
        try { event = JSON.parse(frame.data); } catch { throw new Error("Upstream returned invalid Responses SSE JSON"); }
        if (!isObject(event)) throw new Error("Upstream returned an invalid Responses event");
        const type = event.type || frame.event;
        if (type === "error" || event.error || type === "response.failed") throw new Error(event.error?.message || event.response?.error?.message || event.message || "Upstream Responses stream failed");
        if (event.response) { model = event.response.model || model; created = event.response.created_at || created; }
        if (type === "response.created" || type === "response.in_progress") await ensureRole();
        else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
          await emitContent(event, type === "response.refusal.delta" ? "refusal" : "output_text", event.delta);
        } else if (type === "response.output_text.done" || type === "response.refusal.done") {
          await emitContent(event, type === "response.refusal.done" ? "refusal" : "output_text", type === "response.refusal.done" ? event.refusal : event.text, true);
        } else if (type === "response.output_item.added" && event.item?.type === "function_call") {
          await updateTool(event, event.item, true);
        } else if (type === "response.function_call_arguments.delta") {
          await updateTool(event, { arguments: event.delta }, false);
        } else if (type === "response.function_call_arguments.done") {
          await updateTool(event, { arguments: event.arguments, name: event.name }, true);
        } else if (type === "response.output_item.done") await emitItem(event.item, event.output_index);
        else if (type === "response.completed" || type === "response.incomplete") {
          validateResponseCompletion(event.response);
          for (let index = 0; index < event.response.output.length; index++) await emitItem(event.response.output[index], index);
          for (const state of tools.values()) if (!state.added) throw new Error("Upstream stream ended without function metadata");
          await ensureRole();
          await chunk({}, chatFinishReason(event.response, tools.size > 0));
          const usage = chatUsage(event.response.usage);
          if (includeUsage && usage) await send({ id, object: "chat.completion.chunk", created, model, choices: [], usage });
          await send("[DONE]");
          terminal = true;
          break;
        }
      }
      if (!terminal) throw new Error("Upstream Responses stream ended before a terminal response event");
    } catch (error) {
      await recordUpstreamFailure(upstream, error.message);
      try {
        await send({ error: { message: redactSecret(error.message, upstreamKey), type: "upstream_error", code: "responses_stream_error" } });
        await send("[DONE]");
      } catch {
      }
    } finally {
      try { await reader.cancel(); } catch {}
      reader.releaseLock();
      try { await writer.close(); } catch {}
    }
  })();
  const headers = proxyResponseHeaders(upstream.headers, upstreamKey, "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  return new Response(readable, { headers });
}
__name(streamResponsesToChat, "streamResponsesToChat");
function responsesToChat(body) {
  const messages = [];
  if (body.instructions != null && typeof body.instructions !== "string") throw new Error("instructions must be a string");
  if (body.parallel_tool_calls != null && typeof body.parallel_tool_calls !== "boolean") throw new Error("parallel_tool_calls must be a boolean");
  if (body.instructions) {
    messages.push({ role: "system", content: String(body.instructions) });
  }
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      appendInputItem(messages, item);
    }
  }
  const payload = {
    model: body.model,
    messages,
    stream: body.stream === true
  };
  if (payload.stream) {
    payload.stream_options = { include_usage: true };
  }
  if (body.reasoning != null) {
    if (!isObject(body.reasoning)) throw new Error("reasoning must be an object");
    if (body.reasoning.effort != null) {
      if (typeof body.reasoning.effort !== "string" || !body.reasoning.effort.trim()) {
        throw new Error("reasoning.effort must be a non-empty string");
      }
      payload.reasoning_effort = body.reasoning.effort;
    }
  }
  if (body.text != null) {
    if (!isObject(body.text)) throw new Error("text must be an object");
    if (body.text.verbosity != null) {
      if (!["low", "medium", "high"].includes(body.text.verbosity)) throw new Error("Invalid text.verbosity");
      payload.verbosity = body.text.verbosity;
    }
    if (body.text.format != null) payload.response_format = chatResponseFormat(body.text.format);
  }
  if (body.temperature != null) payload.temperature = body.temperature;
  if (body.top_p != null) payload.top_p = body.top_p;
  if (body.max_output_tokens != null) {
    if (!Number.isInteger(body.max_output_tokens) || body.max_output_tokens <= 0) {
      throw new Error("max_output_tokens must be a positive integer");
    }
    // Reasoning models use max_completion_tokens to include their reasoning budget.
    payload[payload.reasoning_effort != null ? "max_completion_tokens" : "max_tokens"] = body.max_output_tokens;
  }
  if (body.parallel_tool_calls != null) payload.parallel_tool_calls = body.parallel_tool_calls;
  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = [];
    for (const t of body.tools) {
      if (t.type === "function") {
        if (t.parameters != null && !isObject(t.parameters)) throw new Error("Function parameters must be a schema object");
        if (t.strict != null && typeof t.strict !== "boolean") throw new Error("Function strict must be a boolean");
        tools.push({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters || { type: "object", properties: {} },
            ...t.strict != null ? { strict: t.strict } : {}
          }
        });
      }
    }
    if (tools.length) payload.tools = tools;
  }
  if (body.tool_choice != null) {
    if (typeof body.tool_choice === "object" && !body.tools?.some((tool) => tool.name === body.tool_choice.name)) {
      throw new Error("tool_choice names a function that is not defined in tools");
    }
    payload.tool_choice = typeof body.tool_choice === "string" ? body.tool_choice : {
      type: "function", function: { name: body.tool_choice.name }
    };
  }
  return payload;
}
__name(responsesToChat, "responsesToChat");
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
__name(isObject, "isObject");
function chatResponseFormat(format) {
  if (!isObject(format)) throw new Error("text.format must be an object");
  if (format.type === "text" || format.type === "json_object") return { type: format.type };
  if (format.type !== "json_schema") throw new Error("Unsupported text.format type");
  if (typeof format.name !== "string" || !format.name || !isObject(format.schema)) {
    throw new Error("json_schema format requires a name and a schema object");
  }
  if (format.strict != null && typeof format.strict !== "boolean") throw new Error("text.format.strict must be a boolean");
  if (format.description != null && typeof format.description !== "string") throw new Error("text.format.description must be a string");
  return {
    type: "json_schema",
    json_schema: {
      name: format.name,
      schema: format.schema,
      ...(format.strict != null ? { strict: format.strict } : {}),
      ...(format.description != null ? { description: format.description } : {})
    }
  };
}
__name(chatResponseFormat, "chatResponseFormat");
function appendInputItem(messages, item) {
  if (!isObject(item)) throw new Error("Each input item must be an object");
  switch (item.type) {
    case undefined:
    case "message": {
      const role = item.role || "user";
      if (!["system", "developer", "user", "assistant"].includes(role)) throw new Error("Unsupported input message role");
      if (item.content == null) throw new Error("Input messages must contain content");
      const content = normalizeContent(item.content, role);
      const message = { role, content };
      if (role === "assistant" && Array.isArray(item.content)) {
        const refusals = item.content.filter((part) => part.type === "refusal");
        if (refusals.length) message.refusal = refusals.map((part) => part.refusal).join("");
      }
      messages.push(message);
      break;
    }
    case "function_call": {
      if (typeof (item.call_id || item.id) !== "string" || !(item.call_id || item.id) ||
          typeof item.name !== "string" || !item.name || typeof item.arguments !== "string") {
        throw new Error("function_call requires a call_id, name, and string arguments");
      }
      const toolCall = {
        id: item.call_id || item.id,
        type: "function",
        function: { name: item.name, arguments: item.arguments || "" }
      };
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && Array.isArray(last.tool_calls) && !last.content) {
        last.tool_calls.push(toolCall);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      break;
    }
    case "function_call_output": {
      if (typeof (item.call_id || item.id) !== "string" || !(item.call_id || item.id) || item.output === undefined) {
        throw new Error("function_call_output requires a call_id and output");
      }
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id,
        content: normalizeToolOutput(item.output)
      });
      break;
    }
    case "reasoning":
      break;
    default:
      throw new Error(`Unsupported input item type: ${item.type}`);
  }
}
__name(appendInputItem, "appendInputItem");
function normalizeContent(content, role) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("Message content must be a string or an array");
  const parts = [];
  let onlyText = true;
  for (const c of content) {
    if (!isObject(c)) throw new Error("Each content part must be an object");
    if (c.type === "input_text" || c.type === "output_text" || c.type === "text") {
      if (typeof c.text !== "string") throw new Error("Text content must contain a text string");
      parts.push({ type: "text", text: c.text });
    } else if (c.type === "input_image") {
      const imageUrl = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
      if (typeof imageUrl !== "string" || !imageUrl) throw new Error("Images require an image_url; image file_id is not supported");
      if (c.detail != null && !["low", "high", "auto"].includes(c.detail)) throw new Error("Unsupported image detail");
      onlyText = false;
      parts.push({
        type: "image_url",
        image_url: {
          url: imageUrl,
          ...c.detail != null ? { detail: c.detail } : {}
        }
      });
    } else if (c.type === "refusal" && role === "assistant") {
      if (typeof c.refusal !== "string") throw new Error("Refusal content must contain a refusal string");
    } else {
      throw new Error(`Unsupported content part type: ${c.type}`);
    }
  }
  if (onlyText) return parts.map((p) => p.text).join("");
  return parts;
}
__name(normalizeContent, "normalizeContent");
function normalizeToolOutput(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return JSON.stringify(output);
  return output.map((part) => {
    if (!isObject(part) || !["input_text", "output_text", "text"].includes(part.type) || typeof part.text !== "string") {
      throw new Error("Only text content parts are supported in function_call_output arrays");
    }
    return part.text;
  }).join("");
}
__name(normalizeToolOutput, "normalizeToolOutput");
function completionDetails(finishReason) {
  if (finishReason === "length") return { reason: "max_output_tokens" };
  if (finishReason === "content_filter") return { reason: "content_filter" };
  return null;
}
__name(completionDetails, "completionDetails");
async function nonStreamChatToResponses(upstream, reqBody, upstreamKey) {
  let data;
  try {
    data = await upstream.json();
  } catch (e) {
    await recordUpstreamFailure(upstream, e.message);
    return jsonError(502, "upstream returned non-JSON: " + redactSecret(e.message, upstreamKey));
  }
  if (!isObject(data) || !Array.isArray(data.choices) || !isObject(data.choices[0]?.message)) {
    await recordUpstreamFailure(upstream, "Upstream returned an invalid Chat Completions response");
    return jsonError(502, "Upstream returned an invalid Chat Completions response");
  }
  const choice = data.choices[0];
  const msg = choice.message;
  if ((msg.content != null && typeof msg.content !== "string") || (msg.refusal != null && typeof msg.refusal !== "string") ||
      (msg.tool_calls != null && (!Array.isArray(msg.tool_calls) || msg.tool_calls.some((tool) =>
        !isObject(tool) || !isObject(tool.function) || typeof tool.function.name !== "string" || !tool.function.name ||
        typeof tool.function.arguments !== "string" || (tool.id != null && typeof tool.id !== "string"))))) {
    await recordUpstreamFailure(upstream, "Upstream returned an invalid assistant message");
    return jsonError(502, "Upstream returned an invalid assistant message");
  }
  const incompleteDetails = completionDetails(choice.finish_reason);
  const status = incompleteDetails ? "incomplete" : "completed";
  const output = [];
  const content = [];
  if (msg.content) content.push({ type: "output_text", text: msg.content, annotations: [] });
  if (msg.refusal) content.push({ type: "refusal", refusal: msg.refusal });
  if (content.length) {
    output.push({
      id: rid("msg"),
      type: "message",
      status,
      role: "assistant",
      content
    });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      output.push({
        id: rid("fc"),
        type: "function_call",
        status,
        call_id: tc.id || rid("call"),
        name: tc.function?.name || "",
        arguments: tc.function?.arguments || ""
      });
    }
  }
  const response = buildResponseObject({
    status,
    incompleteDetails,
    output,
    usage: data.usage,
    model: data.model || reqBody.model,
    id: rid("resp"),
    created: data.created || nowSec(),
    reqBody
  });
  return new Response(JSON.stringify(response), {
    headers: proxyResponseHeaders(upstream.headers, upstreamKey, "application/json")
  });
}
__name(nonStreamChatToResponses, "nonStreamChatToResponses");
function createSSEParser() {
  let buffer = "";
  let data = [];
  let event = "";
  function consumeLine(line) {
    if (line === "") {
      const message = data.length ? { event, data: data.join("\n") } : null;
      data = [];
      event = "";
      return message;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    if (field === "event") event = value;
    return null;
  }
  return { push(value, done = false) {
    const messages = [];
    buffer += value;
    let index;
    while ((index = buffer.search(/[\r\n]/)) !== -1) {
      if (!done && buffer[index] === "\r" && index === buffer.length - 1) break;
      const length = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      const message = consumeLine(buffer.slice(0, index));
      buffer = buffer.slice(index + length);
      if (message) messages.push(message);
    }
    if (done) {
      if (buffer) consumeLine(buffer);
      const message = consumeLine("");
      if (message) messages.push(message);
    }
    return messages;
  } };
}
async function* readSSE(reader) {
  const parser = createSSEParser();
  while (true) {
    const { value, done } = await reader.read();
    for (const message of parser.push(done ? "" : value, done)) yield message;
    if (done) return;
  }
}
__name(readSSE, "readSSE");
function streamChatToResponses(upstream, reqBody, upstreamKey) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let seq = 0;
  const send = /* @__PURE__ */ __name((type, data) => {
    const payload = { type, sequence_number: seq++, ...data };
    return writer.write(encoder.encode(`event: ${type}
data: ${JSON.stringify(payload)}

`));
  }, "send");
  (async () => {
    const reader = upstream.body.pipeThrough(new TextDecoderStream()).getReader();
    // Stop consuming the upstream stream when the client disconnects.
    writer.closed.catch(() => reader.cancel().catch(() => {}));
    const respId = rid("resp");
    let model = reqBody.model;
    let created = nowSec();
    let usage = null;
    let finishReason = null;
    let sawDone = false;
    let sawChoice = false;
    let outputIndex = -1;
    const outputItems = [];
    let textItemId = null;
    let textIndex = -1;
    let textBuf = "";
    let textOpen = false;
    let partType = "output_text";
    const tools = /* @__PURE__ */ new Map();
    const created0 = buildResponseObject({
      status: "in_progress",
      output: [],
      usage: null,
      model,
      id: respId,
      created,
      reqBody
    });
    try {
      await send("response.created", { response: created0 });
      await send("response.in_progress", { response: created0 });
      for await (const event of readSSE(reader)) {
        if (event.event === "ping") continue;
        const payload = event.data;
        if (payload.trim() === "[DONE]") {
          sawDone = true;
          break;
        }
        if (!payload) continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          throw new Error("Upstream returned invalid SSE JSON");
        }
        if (!isObject(chunk)) throw new Error("Upstream returned an invalid SSE chunk");
        if (chunk.error) throw new Error(chunk.error.message || "Upstream stream failed");
        if (chunk.choices != null && !Array.isArray(chunk.choices)) throw new Error("Upstream returned invalid choices");
        if (chunk.choices == null && !isObject(chunk.usage)) throw new Error("Upstream SSE chunk has no choices or usage");
        if (chunk.choices?.length) sawChoice = true;
        if (chunk.model) model = chunk.model;
        if (chunk.created) created = chunk.created;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices && chunk.choices[0] || {};
        if (!isObject(choice)) throw new Error("Upstream returned an invalid choice");
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (!isObject(delta)) throw new Error("Upstream returned an invalid delta");
        if (delta.content != null) await appendContent("output_text", delta.content);
        if (delta.refusal != null) await appendContent("refusal", delta.refusal);
        if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) throw new Error("Upstream returned invalid tool calls");
        if (Array.isArray(delta.tool_calls)) {
          if (textOpen) await closeText();
          for (const tc of delta.tool_calls) {
            if (!isObject(tc) || (tc.function != null && !isObject(tc.function)) ||
                (tc.id != null && typeof tc.id !== "string") ||
                (tc.function?.name != null && typeof tc.function.name !== "string") ||
                (tc.function?.arguments != null && typeof tc.function.arguments !== "string")) {
              throw new Error("Upstream returned an invalid tool call delta");
            }
            const ci = tc.index ?? 0;
            if (!Number.isInteger(ci) || ci < 0) throw new Error("Upstream returned an invalid tool call index");
            let st = tools.get(ci);
            if (!st) {
              st = {
                itemId: rid("fc"),
                outIndex: ++outputIndex,
                callId: tc.id || rid("call"),
                name: "",
                argsBuf: "",
                added: false
              };
              tools.set(ci, st);
            }
            if (tc.id) st.callId = tc.id;
            if (tc.function?.name) st.name += tc.function.name;
            if (!st.added) {
              st.added = true;
              outputItems[st.outIndex] = {
                id: st.itemId, type: "function_call", status: "in_progress",
                call_id: st.callId, name: st.name, arguments: ""
              };
              await send("response.output_item.added", {
                output_index: st.outIndex,
                item: outputItems[st.outIndex]
              });
            }
            if (tc.function?.arguments) {
              st.argsBuf += tc.function.arguments;
              await send("response.function_call_arguments.delta", {
                item_id: st.itemId,
                output_index: st.outIndex,
                delta: tc.function.arguments
              });
            }
            Object.assign(outputItems[st.outIndex], { call_id: st.callId, name: st.name, arguments: st.argsBuf });
          }
        }
      }
      if (!sawDone) throw new Error("Upstream stream ended before [DONE]");
      if (!sawChoice) throw new Error("Upstream stream contained no completion choices");
      if (textOpen) await closeText();
      for (const st of tools.values()) await closeTool(st);
      const incompleteDetails = completionDetails(finishReason);
      const finalResponse = buildResponseObject({
        status: incompleteDetails ? "incomplete" : "completed",
        incompleteDetails,
        output: outputItems,
        usage,
        model,
        id: respId,
        created,
        reqBody
      });
      await send(finalResponse.status === "incomplete" ? "response.incomplete" : "response.completed", { response: finalResponse });
    } catch (err) {
      await recordUpstreamFailure(upstream, err && err.message || String(err));
      for (const item of outputItems) {
        if (item.status === "in_progress") item.status = "incomplete";
      }
      try {
        await send("response.failed", {
          response: buildResponseObject({
            status: "failed",
            output: outputItems,
            usage,
            model,
            id: respId,
            created,
            reqBody,
            error: { code: "translation_error", message: redactSecret(err && err.message || err, upstreamKey) }
          })
        });
      } catch (_) {
      }
    } finally {
      try {
        await reader.cancel();
      } catch (_) {
      }
      reader.releaseLock();
      try {
        await writer.close();
      } catch (_) {
      }
    }
    function contentPart() {
      return partType === "refusal" ? { type: "refusal", refusal: textBuf } : { type: "output_text", text: textBuf, annotations: [] };
    }
    async function appendContent(type, value) {
      if (typeof value !== "string") throw new Error("Upstream returned non-string assistant content");
      if (!value) return;
      if (textOpen && partType !== type) await closeText();
      if (!textOpen) {
        textOpen = true;
        partType = type;
        textBuf = "";
        textItemId = rid("msg");
        textIndex = ++outputIndex;
        outputItems[textIndex] = { id: textItemId, type: "message", status: "in_progress", role: "assistant", content: [] };
        await send("response.output_item.added", { output_index: textIndex, item: outputItems[textIndex] });
        await send("response.content_part.added", {
          item_id: textItemId, output_index: textIndex, content_index: 0, part: contentPart()
        });
      }
      textBuf += value;
      outputItems[textIndex].content = [contentPart()];
      await send(`response.${partType}.delta`, {
        item_id: textItemId, output_index: textIndex, content_index: 0, delta: value
      });
    }
    async function closeText() {
      textOpen = false;
      const item = {
        id: textItemId,
        type: "message",
        status: completionDetails(finishReason) ? "incomplete" : "completed",
        role: "assistant",
        content: [contentPart()]
      };
      await send(`response.${partType}.done`, {
        item_id: textItemId,
        output_index: textIndex,
        content_index: 0,
        [partType === "refusal" ? "refusal" : "text"]: textBuf
      });
      await send("response.content_part.done", {
        item_id: textItemId,
        output_index: textIndex,
        content_index: 0,
        part: contentPart()
      });
      await send("response.output_item.done", { output_index: textIndex, item });
      outputItems[textIndex] = item;
    }
    __name(closeText, "closeText");
    async function closeTool(st) {
      if (!st.name) throw new Error("Upstream tool call ended without a function name");
      const item = {
        id: st.itemId,
        type: "function_call",
        status: completionDetails(finishReason) ? "incomplete" : "completed",
        call_id: st.callId,
        name: st.name,
        arguments: st.argsBuf
      };
      await send("response.function_call_arguments.done", {
        item_id: st.itemId,
        output_index: st.outIndex,
        arguments: st.argsBuf,
        name: st.name
      });
      await send("response.output_item.done", { output_index: st.outIndex, item });
      outputItems[st.outIndex] = item;
    }
    __name(closeTool, "closeTool");
  })();
  const headers = proxyResponseHeaders(upstream.headers, upstreamKey, "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  return new Response(readable, { headers });
}
__name(streamChatToResponses, "streamChatToResponses");
function buildResponseObject({ status, output, usage, model, id, created, reqBody, error, incompleteDetails }) {
  return {
    id,
    object: "response",
    created_at: created,
    status,
    // in_progress | completed | incomplete | failed
    error: error || null,
    incomplete_details: incompleteDetails || null,
    instructions: reqBody?.instructions ?? null,
    max_output_tokens: reqBody?.max_output_tokens ?? null,
    model,
    output: output || [],
    parallel_tool_calls: reqBody?.parallel_tool_calls ?? true,
    previous_response_id: null,
    reasoning: reqBody?.reasoning ?? null,
    store: false,
    temperature: reqBody?.temperature ?? null,
    tool_choice: reqBody?.tool_choice ?? "auto",
    tools: reqBody?.tools ?? [],
    text: reqBody?.text ?? { format: { type: "text" } },
    top_p: reqBody?.top_p ?? null,
    truncation: reqBody?.truncation ?? "disabled",
    usage: usage ? normalizeUsage(usage) : null,
    metadata: reqBody?.metadata ?? {}
  };
}
__name(buildResponseObject, "buildResponseObject");
function normalizeUsage(u) {
  return {
    input_tokens: u.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens: u.completion_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
    total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)
  };
}
__name(normalizeUsage, "normalizeUsage");
async function passthrough(request, url, upstreamBase, upstreamKey) {
  const suffix = url.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  const target = `${upstreamBase}${suffix}${url.search}`;
  const init = {
    method: request.method,
    headers: buildUpstreamHeaders(request.headers, upstreamKey),
    body: request.method === "GET" || request.method === "HEAD" ? void 0 : request.body,
    redirect: "manual",
    signal: request.signal
  };
  try {
    const upstream = await fetchUpstream(target, init, upstreamKey);
    if (upstream.status === 304) {
      return new Response(null, { status: 304, headers: proxyResponseHeaders(upstream.headers, upstreamKey) });
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      await cancelUpstreamBody(upstream);
      return jsonError(502, "Upstream redirects are not supported");
    }
    if (!upstream.ok) return upstreamError(upstream, upstreamKey);
    const headers = proxyResponseHeaders(upstream.headers, upstreamKey);
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch (e) {
    return fetchErrorResponse(e, upstreamKey, "passthrough failed: ");
  }
}
__name(passthrough, "passthrough");
async function cancelUpstreamBody(upstream) {
  try {
    await upstream.body?.cancel();
  } catch {
  }
}
__name(cancelUpstreamBody, "cancelUpstreamBody");
function redactSecret(value, secret) {
  let text = String(value);
  const secrets = typeof secret === "string" ? [secret] : [...(secret?.keys?.map((key) => key.secret) || []), secret?.proxyKey];
  for (const key of secrets.filter((key) => typeof key === "string" && key).sort((a, b) => b.length - a.length)) {
    text = text.split(key).join("[REDACTED]");
  }
  return text;
}
__name(redactSecret, "redactSecret");
function proxyResponseHeaders(source, upstreamKey, contentType) {
  const headers = new Headers(source);
  for (const name of ["authorization", "proxy-authorization", "x-api-key", "api-key", "connection", "transfer-encoding"]) headers.delete(name);
  for (const [name, value] of headers) headers.set(name, redactSecret(value, upstreamKey));
  if (contentType) {
    for (const name of ["content-length", "content-encoding", "etag", "content-md5", "digest"]) headers.delete(name);
    headers.set("Content-Type", contentType);
  }
  for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value);
  return headers;
}
__name(proxyResponseHeaders, "proxyResponseHeaders");
async function upstreamError(upstream, upstreamKey) {
  let raw;
  try {
    raw = redactSecret(await upstream.text(), upstreamKey);
  } catch {
    return jsonError(502, "Failed to read upstream error response");
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
  }
  if (!isObject(data) || !isObject(data.error)) {
    data = { error: { message: `upstream ${upstream.status}: ${raw}`, type: "upstream_error", code: upstream.status } };
  }
  return new Response(JSON.stringify(data, (_name, value) => typeof value === "string" ? redactSecret(value, upstreamKey) : value), {
    status: upstream.status,
    headers: proxyResponseHeaders(upstream.headers, upstreamKey, "application/json")
  });
}
__name(upstreamError, "upstreamError");
function buildUpstreamHeaders(srcHeaders, upstreamKey, isStream) {
  const headers = new Headers();
  const skip = /* @__PURE__ */ new Set([
    "host", "content-length", "accept-encoding", "authorization", "proxy-authorization",
    "x-api-key", "api-key", "cookie", "connection", "keep-alive", "transfer-encoding",
    "te", "trailer", "upgrade"
  ]);
  for (const [k, v] of srcHeaders) {
    if (skip.has(k.toLowerCase())) continue;
    headers.set(k, v);
  }
  if (typeof upstreamKey === "string") headers.set("Authorization", `Bearer ${upstreamKey}`);
  if (typeof isStream === "boolean") {
    headers.set("Content-Type", "application/json");
    headers.set("Accept", isStream ? "text/event-stream" : "application/json");
  }
  return headers;
}
__name(buildUpstreamHeaders, "buildUpstreamHeaders");
function rid(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}
__name(rid, "rid");
function nowSec() {
  return Math.floor(Date.now() / 1e3);
}
__name(nowSec, "nowSec");
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, HEAD, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, OpenAI-Beta, X-Session-ID, session_id, X-Conversation-ID, conversation_id, X-Codex-Turn-Metadata, thread-id, thread_id, session-id",
    "Access-Control-Expose-Headers": "X-Request-ID, Retry-After",
    "Access-Control-Max-Age": "86400"
  };
}
__name(corsHeaders, "corsHeaders");
function jsonError(status, message, type = "proxy_error") {
  return new Response(JSON.stringify({ error: { message, type, code: status } }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}
__name(jsonError, "jsonError");
export {
  worker_default as default
};

