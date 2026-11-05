import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Import as an ES module without requiring a package.json beside worker.js.
const source = await readFile(new URL("./worker.js", import.meta.url), "utf8");
const { default: rawWorker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const d1SQL = await readFile(new URL("./worker.d1.sql", import.meta.url), "utf8");
const initializerAsset = JSON.parse(await readFile(new URL("./assets/d1-init.json", import.meta.url), "utf8"));
const databases = [];
let fixtureDB;

// Exercise real SQLite SQL, constraints and triggers through the D1 interface.
class TestD1 {
  constructor(initialize = true) {
    this.sqlite = new DatabaseSync(":memory:");
    this.sessions = [];
    this.waits = new Set();
    this.batches = [];
    if (initialize) this.sqlite.exec(d1SQL);
    databases.push(this);
  }
  withSession(constraint) {
    this.sessions.push(constraint);
    return this;
  }
  prepare(sql) { return new TestD1Statement(this, sql); }
  async batch(statements) {
    if (this.beforeBatch) await this.beforeBatch(statements);
    this.batches.push(statements);
    const execute = () => {
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((query) => {
          const rows = this.sqlite.prepare(query.sql).all(...query.values);
          const { changes } = this.sqlite.prepare("SELECT changes() AS changes").get();
          return { success: true, results: rows.map((row) => ({ ...row })), meta: { changes } };
        });
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    };
    const results = execute();
    // Simulate a transport replay after a committed batch.
    if (this.replayBatches) execute();
    return results;
  }
  waitUntil(promise) {
    this.waits.add(promise);
    promise.then(() => this.waits.delete(promise), () => this.waits.delete(promise));
  }
  async drain() { while (this.waits.size) await Promise.allSettled([...this.waits]); }
}
class TestD1Statement {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) { return new TestD1Statement(this.db, this.sql, values); }
  async all() { return (await this.db.batch([this]))[0]; }
  async run() { return this.all(); }
  async first(column) {
    const row = (await this.all()).results[0];
    return row ? column ? row[column] : row : null;
  }
}
function testWorker(implementation) {
  return {
    fetch(req, config, executionCtx) {
      const db = config && Object.hasOwn(config, "DB") ? config.DB : fixtureDB;
      const trackedDB = fixtureDB;
      const ctx = executionCtx || { waitUntil: (promise) => trackedDB.waitUntil(promise) };
      return implementation.fetch(req, { ...config, DB: db }, ctx);
    },
    scheduled(event, config, executionCtx) {
      return implementation.scheduled(event, { ...config, DB: config?.DB || fixtureDB }, executionCtx);
    }
  };
}
const worker = testWorker(rawWorker);
test.beforeEach(() => { fixtureDB = new TestD1(); });
test.afterEach(async () => { await fixtureDB.drain(); });
test.after(async () => {
  for (const db of databases) { await db.drain(); db.sqlite.close(); }
});
// Keep structured Worker diagnostics out of the test reporter.
test.mock.method(console, "log", () => {});
test.mock.method(console, "error", () => {});
// Existing regression tests exercise the original Responses -> Chat adapter.
const env = { PROXY_API_KEY: "client-test-key", UPSTREAM_API_KEY: "platform-test-key", UPSTREAM_API: "chat" };
const input = { model: "test-model", input: "Hello" };

function request(path = "/v1/responses", options = {}) {
  const headers = new Headers({ Authorization: `Bearer ${env.PROXY_API_KEY}`, "Content-Type": "application/json" });
  for (const [name, value] of Object.entries(options.headers || {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  const method = options.method || "POST";
  return new Request(`https://proxy.example${path}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" || method === "OPTIONS" ? undefined :
      options.rawBody !== undefined ? options.rawBody : JSON.stringify(options.body === undefined ? input : options.body)
  });
}

function chatResponse(overrides = {}) {
  return Response.json({
    model: "upstream-model",
    choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    ...overrides
  });
}

function sse(chunks, { done = true, trailingNewline = true } = {}) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("") +
    (done ? `data: [DONE]${trailingNewline ? "\r\n\r\n" : ""}` : "");
}

function streamResponse(body) {
  return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

function events(body) {
  return body.split("\n\n").filter(Boolean).map((event) => JSON.parse(event.split("\ndata: ")[1]));
}

for (const path of ["/v1/responses", "/v1/chat/completions", "/v1/models", "/unrelated/responses"]) {
  test(`rejects missing or incorrect credentials before fetching ${path}`, async (t) => {
    const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
    for (const authorization of [null, "Bearer wrong-key", `Bearer ${env.UPSTREAM_API_KEY}`, "Basic client-test-key"]) {
      const response = await worker.fetch(request(path, { headers: { Authorization: authorization } }), env);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.type, "authentication_error");
      assert.match(response.headers.get("WWW-Authenticate"), /^Bearer/);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    }
    assert.equal(upstream.mock.callCount(), 0);
  });
}

test("fails closed if either key is missing or not a string", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const config of [undefined, {}, { PROXY_API_KEY: env.PROXY_API_KEY }, { UPSTREAM_API_KEY: env.UPSTREAM_API_KEY },
    { ...env, PROXY_API_KEY: "  " }, { ...env, UPSTREAM_API_KEY: {} }]) {
    const response = await worker.fetch(request(), config);
    assert.equal(response.status, 500);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("preflight works without keys and never calls the platform", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  const response = await worker.fetch(request("/v1/responses", { method: "OPTIONS" }));
  assert.equal(response.status, 204);
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  assert.equal(upstream.mock.callCount(), 0);
});

test("Responses replaces credentials and translates functions, history, and images", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://agentrouter.org/v1/chat/completions");
    assert.equal(init.headers.get("Authorization"), `Bearer ${env.UPSTREAM_API_KEY}`);
    assert.equal(init.headers.get("X-API-Key"), null);
    assert.equal(init.headers.get("Cookie"), null);
    assert.equal(init.headers.get("Proxy-Authorization"), null);
    assert.equal(init.headers.get("Accept"), "application/json");
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal instanceof AbortSignal);
    const payload = JSON.parse(init.body);
    assert.deepEqual(payload.tool_choice, { type: "function", function: { name: "lookup" } });
    assert.equal(payload.tools[0].function.strict, true);
    assert.equal(payload.max_tokens, 12);
    assert.deepEqual(payload.messages[0], { role: "system", content: "Be brief" });
    assert.deepEqual(payload.messages[1].content[1], { type: "image_url", image_url: { url: "https://example.com/image.png", detail: "low" } });
    assert.equal(payload.messages[2].tool_calls.length, 2);
    assert.equal(payload.messages[3].tool_call_id, "call-1");
    return chatResponse();
  });
  const response = await worker.fetch(request("/responses", {
    headers: { "X-API-Key": "untrusted", "Cookie": "session=untrusted", "Proxy-Authorization": "Bearer untrusted" },
    body: {
      ...input, instructions: "Be brief", max_output_tokens: 12,
      input: [
        { role: "user", content: [{ type: "input_text", text: "Look" }, { type: "input_image", image_url: { url: "https://example.com/image.png" }, detail: "low" }] },
        { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" },
        { type: "function_call", call_id: "call-2", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call-1", output: "result" }
      ],
      tools: [{ type: "function", name: "lookup", strict: true }],
      tool_choice: { type: "function", name: "lookup" }, store: true
    }
  }), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.output[0].content[0].text, "Hi");
  assert.equal(data.usage.input_tokens, 3);
  assert.equal(data.usage.output_tokens, 2);
  assert.equal(data.store, false);
});

test("passthrough preserves binary content, method, query, status, and response headers", async (t) => {
  const bytes = new Uint8Array([0, 1, 254, 255]);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://platform.example/api/v1/files?purpose=assistants");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.get("Authorization"), `Bearer ${env.UPSTREAM_API_KEY}`);
    assert.equal(init.headers.get("X-API-Key"), null);
    assert.equal(init.headers.get("Cookie"), null);
    assert.equal(init.headers.get("Content-Type"), "multipart/form-data; boundary=test");
    assert.deepEqual(new Uint8Array(await new Response(init.body).arrayBuffer()), bytes);
    assert.equal(init.redirect, "manual");
    return new Response("uploaded", { status: 201, headers: { "X-Request-ID": "upstream-id", "Access-Control-Allow-Origin": "https://other.example" } });
  });
  const response = await worker.fetch(request("/v1/files?purpose=assistants", {
    rawBody: bytes, headers: { "Content-Type": "multipart/form-data; boundary=test", "X-API-Key": "untrusted", "Cookie": "session=untrusted" }
  }), { ...env, UPSTREAM_BASE: "https://platform.example/api/v1///" });
  assert.equal(response.status, 201);
  assert.equal(await response.text(), "uploaded");
  assert.equal(response.headers.get("X-Request-ID"), "upstream-id");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("GET models has no body and preserves its query", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://agentrouter.org/v1/models?limit=2");
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.headers.get("Authorization"), `Bearer ${env.UPSTREAM_API_KEY}`);
    return Response.json({ data: [] });
  });
  assert.equal((await worker.fetch(request("/v1/models?limit=2", { method: "GET" }), env)).status, 200);
});

test("Chat Completions SSE is passed through unchanged", async (t) => {
  const body = sse([{ choices: [{ delta: { content: "Hi" } }] }]);
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(JSON.parse(await new Response(init.body).text()).stream, true);
    assert.equal(init.headers.get("Authorization"), `Bearer ${env.UPSTREAM_API_KEY}`);
    return streamResponse(body);
  });
  const response = await worker.fetch(request("/v1/chat/completions", { body: { model: "test-model", messages: [], stream: true } }), env);
  assert.equal(await response.text(), body);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("only the exact Responses route is translated", async (t) => {
  const targets = [];
  t.mock.method(globalThis, "fetch", async (url) => { targets.push(url); return new Response("passthrough"); });
  for (const path of ["/unrelated/responses", "/v1evil/models", "/v1/files/v1/sample"]) {
    await worker.fetch(request(path), env);
  }
  assert.deepEqual(targets, ["https://agentrouter.org/v1/unrelated/responses", "https://agentrouter.org/v1/v1evil/models", "https://agentrouter.org/v1/files/v1/sample"]);
});

test("rejects malformed bodies and unsupported stateful or built-in tool requests", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const body of [null, [], "hello", {}, { model: "", input: "Hi" }, { model: "test", input: {} },
    { ...input, stream: "true" }, { ...input, previous_response_id: "resp-old" }, { ...input, conversation: "conv-old" },
    { ...input, tools: [null] }, { ...input, tools: [{ type: "web_search" }] }, { ...input, tool_choice: { type: "function" } }]) {
    assert.equal((await worker.fetch(request("/v1/responses", { body }), env)).status, 400);
  }
  assert.equal((await worker.fetch(request("/v1/responses", { rawBody: "{" }), env)).status, 400);
  assert.equal(upstream.mock.callCount(), 0);
});

test("rejects invalid or insecure upstream addresses", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const base of ["invalid", "http://platform.example/v1", "https://user:pass@platform.example/v1", "https://platform.example/v1?key=value", "https://platform.example/v1#fragment"]) {
    assert.equal((await worker.fetch(request(), { ...env, UPSTREAM_BASE: base })).status, 500);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

for (const path of ["/v1/responses", "/v1/chat/completions"]) {
  test(`does not follow upstream redirects for ${path}`, async (t) => {
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(init.redirect, "manual");
      return new Response(null, { status: 307, headers: { Location: "https://other.example" } });
    });
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Location"), null);
  });
  test(`reports upstream connection failures for ${path}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error("connection failed"); });
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  });
  test(`preserves upstream error status for ${path}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: "rate limited" } }, { status: 429 }));
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(await response.text(), /rate limited/);
  });
}

test("rejects malformed upstream JSON instead of returning empty success", async (t) => {
  for (const data of [null, {}, { choices: [] }, { choices: [{ delta: {} }] }]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(data));
    assert.equal((await worker.fetch(request(), env)).status, 502);
  }
  t.mock.method(globalThis, "fetch", async () => new Response("not JSON"));
  assert.equal((await worker.fetch(request(), env)).status, 502);
});

test("nonstream token-limit termination is marked incomplete", async (t) => {
  t.mock.method(globalThis, "fetch", async () => chatResponse({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] }));
  const response = await (await worker.fetch(request(), env)).json();
  assert.equal(response.status, "incomplete");
  assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
});

test("Responses streaming handles split UTF-8, CRLF, usage, and DONE without a final newline", async (t) => {
  const bytes = new TextEncoder().encode(sse([
    { model: "stream-model", choices: [{ delta: { content: "你好" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }
  ], { trailingNewline: false }));
  let position = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (position >= bytes.length) controller.close();
    else { controller.enqueue(bytes.slice(position, position + 7)); position += 7; }
  } });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.get("Authorization"), `Bearer ${env.UPSTREAM_API_KEY}`);
    assert.equal(init.headers.get("Accept"), "text/event-stream");
    assert.deepEqual(JSON.parse(init.body).stream_options, { include_usage: true });
    return streamResponse(stream);
  });
  const result = events(await (await worker.fetch(request("/v1/responses", { body: { ...input, stream: true } }), env)).text());
  assert.equal(result[0].type, "response.created");
  assert.deepEqual(result.map((event) => event.sequence_number), result.map((_, index) => index));
  assert.equal(result.at(-1).type, "response.completed");
  assert.equal(result.at(-1).response.output[0].content[0].text, "你好");
  assert.equal(result.at(-1).response.usage.total_tokens, 3);
});

test("streamed function arguments and output indexes survive interleaved text", async (t) => {
  t.mock.method(globalThis, "fetch", async () => streamResponse(sse([
    { choices: [{ delta: { content: "Before" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "look", arguments: '{"x":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "up", arguments: "1}" } }] } }] },
    { choices: [{ delta: { content: "After" }, finish_reason: "tool_calls" }] }
  ])));
  const result = events(await (await worker.fetch(request("/v1/responses", { body: { ...input, stream: true } }), env)).text());
  const output = result.at(-1).response.output;
  assert.equal(output[0].content[0].text, "Before");
  assert.equal(output[1].name, "lookup");
  assert.equal(output[1].arguments, '{"x":1}');
  assert.equal(output[2].content[0].text, "After");
  for (const event of result.filter((event) => event.type === "response.output_item.done")) {
    assert.equal(output[event.output_index].id, event.item.id);
  }
});

test("streaming token-limit termination emits response.incomplete", async (t) => {
  t.mock.method(globalThis, "fetch", async () => streamResponse(sse([{ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }])));
  const result = events(await (await worker.fetch(request("/v1/responses", { body: { ...input, stream: true } }), env)).text());
  assert.equal(result.at(-1).type, "response.incomplete");
  assert.equal(result.at(-1).response.incomplete_details.reason, "max_output_tokens");
});

for (const [name, body] of [
  ["upstream error event", sse([{ error: { message: "quota exceeded" } }])],
  ["malformed SSE JSON", "data: {broken}\n\ndata: [DONE]\n\n"],
  ["truncated stream", sse([{ choices: [{ delta: { content: "partial" } }] }], { done: false })]
]) {
  test(`${name} emits failure instead of completion`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => streamResponse(body));
    const result = events(await (await worker.fetch(request("/v1/responses", { body: { ...input, stream: true } }), env)).text());
    assert.equal(result.at(-1).type, "response.failed");
    assert.equal(result.at(-1).response.status, "failed");
    assert.ok(!result.some((event) => event.type === "response.completed"));
  });
}

test("a non-SSE response to a streaming request is an HTTP 502", async (t) => {
  t.mock.method(globalThis, "fetch", async () => chatResponse());
  const response = await worker.fetch(request("/v1/responses", { body: { ...input, stream: true } }), env);
  assert.equal(response.status, 502);
});

test("client disconnect cancels an open upstream stream", async (t) => {
  const cancelled = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async () => streamResponse(new ReadableStream({ cancel() { cancelled.resolve(); } })));
  const response = await worker.fetch(request("/v1/responses", { body: { ...input, stream: true } }), env);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await cancelled.promise;
});

for (const format of [{ type: "text" }, { type: "json_object" }, {
  type: "json_schema", name: "answer", description: "Structured answer", strict: true,
  schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }
}]) {
  test(`converts Responses text.format ${format.type}`, async (t) => {
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      const payload = JSON.parse(init.body);
      assert.deepEqual(payload.response_format, format.type === "json_schema" ? {
        type: "json_schema", json_schema: { name: format.name, description: format.description, strict: true, schema: format.schema }
      } : { type: format.type });
      return chatResponse();
    });
    const response = await (await worker.fetch(request("/v1/responses", { body: { ...input, text: { format } } }), env)).json();
    assert.deepEqual(response.text.format, format);
  });
}

test("passes reasoning effort and verbosity with the reasoning token budget", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const payload = JSON.parse(init.body);
    assert.equal(payload.reasoning_effort, "high");
    assert.equal(payload.max_completion_tokens, 2048);
    assert.equal(payload.max_tokens, undefined);
    assert.equal(payload.verbosity, "low");
    return chatResponse();
  });
  const response = await worker.fetch(request("/v1/responses", {
    body: { ...input, max_output_tokens: 2048, reasoning: { effort: "high" }, text: { verbosity: "low" } }
  }), env);
  assert.equal(response.status, 200);
});

test("rejects unsupported content and invalid adapter options before fetching", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const options of [
    { input: [null] }, { input: [{ type: "input_file", file_id: "file-1" }] },
    { input: [{ role: "user", content: [{ type: "input_file", file_id: "file-1" }] }] },
    { input: [{ role: "user", content: [{ type: "input_audio", data: "audio" }] }] },
    { input: [{ role: "user", content: [{ type: "input_image", file_id: "file-1" }] }] },
    { input: [{ role: "user", content: [{ type: "input_text", text: {} }] }] },
    { input: [{ role: "unknown", content: "Hello" }] }, { input: [{ role: "user", content: {} }] },
    { input: [{ type: "function_call", name: "lookup", arguments: "{}" }] },
    { input: [{ type: "function_call_output", call_id: "call-1", output: [{ type: "input_image", image_url: "https://example.com/image.png" }] }] },
    { text: [] }, { text: { format: { type: "unknown" } } },
    { text: { format: { type: "json_schema", name: "answer" } } },
    { text: { format: { type: "json_schema", name: "answer", schema: {}, strict: "yes" } } },
    { text: { verbosity: "unknown" } }, { reasoning: [] }, { reasoning: { effort: 1 } },
    { background: true }, { max_output_tokens: -1 }, { max_output_tokens: 1.5 },
    { tools: [{ type: "function", name: "lookup", parameters: [] }] },
    { tools: [{ type: "function", name: "lookup", strict: "true" }] },
    { tool_choice: { type: "function", name: "undefined_tool" } }
  ]) {
    const response = await worker.fetch(request("/v1/responses", { body: { ...input, ...options } }), env);
    assert.equal(response.status, 400, JSON.stringify(options));
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("keeps assistant refusals and converts text parts in tool history", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const messages = JSON.parse(init.body).messages;
    assert.equal(messages[0].refusal, "Cannot help with that");
    assert.equal(messages[1].content, "First second");
    return chatResponse();
  });
  const response = await worker.fetch(request("/v1/responses", { body: {
    ...input, input: [
      { type: "message", role: "assistant", content: [{ type: "refusal", refusal: "Cannot help with that" }] },
      { type: "function_call_output", call_id: "call-1", output: [{ type: "input_text", text: "First " }, { type: "input_text", text: "second" }] }
    ]
  } }), env);
  assert.equal(response.status, 200);
});

test("preserves a nonstream refusal instead of returning empty output", async (t) => {
  t.mock.method(globalThis, "fetch", async () => chatResponse({
    choices: [{ message: { content: null, refusal: "Cannot help with that" }, finish_reason: "stop" }]
  }));
  const response = await (await worker.fetch(request(), env)).json();
  assert.equal(response.status, "completed");
  assert.deepEqual(response.output[0].content, [{ type: "refusal", refusal: "Cannot help with that" }]);
});

test("invalid upstream assistant content and tool metadata are HTTP 502", async (t) => {
  for (const message of ["hello", { content: {} }, { refusal: {} }, { tool_calls: [null] },
    { tool_calls: [{ function: { name: "lookup", arguments: {} } }] }]) {
    t.mock.method(globalThis, "fetch", async () => chatResponse({ choices: [{ message }] }));
    assert.equal((await worker.fetch(request(), env)).status, 502);
  }
});

for (const path of ["/v1/responses", "/v1/chat/completions"]) {
  test(`redacts platform key and preserves upstream error metadata for ${path}`, async (t) => {
    // An escaped JSON character must not bypass key redaction after decoding.
    const raw = JSON.stringify({ error: { message: `Rejected key ${env.UPSTREAM_API_KEY}`, code: "invalid_api_key", param: "authorization", type: "authentication_error" } })
      .replace("platform-test-key", "\\u0070latform-test-key");
    t.mock.method(globalThis, "fetch", async () => new Response(raw, { status: 401, headers: {
      "Content-Type": "application/json", "X-Request-ID": "req-1", "Retry-After": "30",
      "Content-Length": String(raw.length), "ETag": "old-body", "X-API-Key": env.UPSTREAM_API_KEY
    } }));
    const response = await worker.fetch(request(path), env);
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.error.code, "invalid_api_key");
    assert.equal(body.error.type, "authentication_error");
    assert.equal(body.error.param, "authorization");
    assert.equal(body.error.message, "Rejected key [REDACTED]");
    assert.equal(response.headers.get("X-Request-ID"), "req-1");
    assert.equal(response.headers.get("Retry-After"), "30");
    assert.equal(response.headers.get("Content-Length"), null);
    assert.equal(response.headers.get("ETag"), null);
    assert.equal(response.headers.get("X-API-Key"), null);
  });
  test(`network errors cannot expose the platform key for ${path}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error(`Rejected ${env.UPSTREAM_API_KEY}`); });
    const response = await worker.fetch(request(path), env);
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.ok(!body.includes(env.UPSTREAM_API_KEY));
    assert.match(body, /REDACTED/);
  });
}

test("non-JSON upstream errors are normalized and redacted", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(`Failed ${env.UPSTREAM_API_KEY}`, { status: 503 }));
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.message, "upstream 503: Failed [REDACTED]");
});

test("an interrupted upstream error body produces a controlled 502", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) {
    controller.error(new Error("body interrupted"));
  } }), { status: 429 }));
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.message, "Failed to read upstream error response");
});

test("keys containing whitespace fail closed instead of constructing invalid headers", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const config of [{ ...env, UPSTREAM_API_KEY: "Bearer platform-key" }, { ...env, PROXY_API_KEY: "client key" }]) {
    assert.equal((await worker.fetch(request(), config)).status, 500);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

for (const stream of [false, true]) {
  test(`content-filter termination marks response and message incomplete, stream=${stream}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => stream ? streamResponse(sse([
      { choices: [{ delta: { content: "partial" }, finish_reason: "content_filter" }] }
    ])) : chatResponse({ choices: [{ message: { content: "partial" }, finish_reason: "content_filter" }] }));
    const response = await worker.fetch(request("/v1/responses", { body: { ...input, stream } }), env);
    const result = stream ? events(await response.text()).at(-1).response : await response.json();
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.incomplete_details, { reason: "content_filter" });
    assert.equal(result.output[0].status, "incomplete");
  });
}

test("nonstream truncated function arguments have incomplete item status", async (t) => {
  t.mock.method(globalThis, "fetch", async () => chatResponse({ choices: [{ message: { content: null, tool_calls: [
    { id: "call-1", type: "function", function: { name: "lookup", arguments: '{"x":' } }
  ] }, finish_reason: "length" }] }));
  const result = await (await worker.fetch(request(), env)).json();
  assert.equal(result.status, "incomplete");
  assert.equal(result.output[0].status, "incomplete");
});

test("streaming refusals emit refusal delta and done events", async (t) => {
  t.mock.method(globalThis, "fetch", async () => streamResponse(sse([
    { choices: [{ delta: { refusal: "Cannot " } }] },
    { choices: [{ delta: { refusal: "help" }, finish_reason: "stop" }] }
  ])));
  const result = events(await (await worker.fetch(request("/v1/responses", { body: { ...input, stream: true } }), env)).text());
  assert.deepEqual(result.filter((event) => event.type === "response.refusal.delta").map((event) => event.delta), ["Cannot ", "help"]);
  assert.equal(result.find((event) => event.type === "response.refusal.done").refusal, "Cannot help");
  assert.equal(result.at(-1).type, "response.completed");
  assert.deepEqual(result.at(-1).response.output[0].content, [{ type: "refusal", refusal: "Cannot help" }]);
});

test("multiline SSE, comments, ping events, and split CRLF are parsed correctly", async (t) => {
  const body = ': keepalive\r\nevent: ping\r\ndata: heartbeat\r\n\r\n' +
    'event: message\r\ndata: {"choices": [\r\ndata: {"delta": {"content": "Hi"}, "finish_reason": "stop"}\r\ndata: ]}\r\n\r\n' +
    'data: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(body);
  let index = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (index >= bytes.length) controller.close();
    else controller.enqueue(bytes.slice(index, ++index));
  } });
  t.mock.method(globalThis, "fetch", async () => streamResponse(stream));
  const result = events(await (await worker.fetch(request("/v1/responses", { body: { ...input, stream: true } }), env)).text());
  assert.equal(result.at(-1).type, "response.completed");
  assert.equal(result.at(-1).response.output[0].content[0].text, "Hi");
});

test("SSE accepts CR line endings", async (t) => {
  t.mock.method(globalThis, "fetch", async () => streamResponse(sse([
    { choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }
  ]).replaceAll("\r\n", "\r")));
  const result = events(await (await worker.fetch(request("/v1/responses", { body: { ...input, stream: true } }), env)).text());
  assert.equal(result.at(-1).type, "response.completed");
});

test("failed streams keep partial text and hide the upstream key", async (t) => {
  t.mock.method(globalThis, "fetch", async () => streamResponse(sse([
    { choices: [{ delta: { content: "Partial answer" } }] },
    { error: { message: `Rejected ${env.UPSTREAM_API_KEY}` } }
  ])));
  const result = events(await (await worker.fetch(request("/v1/responses", { body: { ...input, stream: true } }), env)).text());
  const last = result.at(-1);
  assert.equal(last.type, "response.failed");
  assert.equal(last.response.output[0].content[0].text, "Partial answer");
  assert.equal(last.response.output[0].status, "incomplete");
  assert.equal(last.response.error.message, "Rejected [REDACTED]");
});

test("parallel streamed calls retain their own IDs, names, arguments and output indexes", async (t) => {
  t.mock.method(globalThis, "fetch", async () => streamResponse(sse([
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: "call-0", function: { name: "first", arguments: '{"x":' } },
      { index: 1, id: "call-1", function: { name: "second", arguments: '{"y":' } }
    ] } }] },
    { choices: [{ delta: { tool_calls: [
      { index: 1, function: { arguments: "2}" } }, { index: 0, function: { arguments: "1}" } }
    ] }, finish_reason: "tool_calls" }] }
  ])));
  const result = events(await (await worker.fetch(request("/v1/responses", { body: { ...input, stream: true } }), env)).text());
  const output = result.at(-1).response.output;
  assert.equal(result.at(-1).type, "response.completed");
  assert.deepEqual(output.map((item) => [item.call_id, item.name, item.arguments]), [
    ["call-0", "first", '{"x":1}'], ["call-1", "second", '{"y":2}']
  ]);
  for (const event of result.filter((event) => event.type === "response.output_item.done")) {
    assert.equal(output[event.output_index].id, event.item.id);
  }
});

test("truncated streamed calls preserve partial arguments and incomplete status", async (t) => {
  t.mock.method(globalThis, "fetch", async () => streamResponse(sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-0", function: { name: "lookup", arguments: '{"x":' } }] } }] }
  ], { done: false })));
  const result = events(await (await worker.fetch(request("/v1/responses", { body: { ...input, stream: true } }), env)).text());
  assert.equal(result.at(-1).type, "response.failed");
  assert.equal(result.at(-1).response.output[0].arguments, '{"x":');
  assert.equal(result.at(-1).response.output[0].status, "incomplete");
});

test("invalid SSE content or tool metadata cannot finish successfully", async (t) => {
  for (const chunk of [{}, { choices: "invalid" }, { choices: [{ delta: { content: {} } }] },
    { choices: [{ delta: { tool_calls: [null] } }] },
    { choices: [{ delta: { tool_calls: [{ index: -1, function: { name: "lookup", arguments: "{}" } }] } }] }]) {
    t.mock.method(globalThis, "fetch", async () => streamResponse(sse([chunk])));
    const result = events(await (await worker.fetch(request("/v1/responses", { body: { ...input, stream: true } }), env)).text());
    assert.equal(result.at(-1).type, "response.failed", JSON.stringify(chunk));
  }
});

test("conditional GET passes a bodyless 304 with CORS and cache headers", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.get("If-None-Match"), "cached-models");
    return new Response(null, { status: 304, headers: { ETag: "cached-models" } });
  });
  const response = await worker.fetch(request("/v1/models", { method: "GET", headers: { "If-None-Match": "cached-models" } }), env);
  assert.equal(response.status, 304);
  assert.equal(response.body, null);
  assert.equal(response.headers.get("ETag"), "cached-models");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("streamed tools must have a function name before successful completion", async (t) => {
  t.mock.method(globalThis, "fetch", async () => streamResponse(sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-0", function: { arguments: "{}" } }] }, finish_reason: "tool_calls" }] }
  ])));
  const result = events(await (await worker.fetch(request("/v1/responses", { body: { ...input, stream: true } }), env)).text());
  assert.equal(result.at(-1).type, "response.failed");
  assert.match(result.at(-1).response.error.message, /function name/);
});

test("body cancellation failure still produces a controlled redirect error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    cancel() { throw new Error("cancel failed"); }
  }), { status: 307, headers: { Location: "https://other.example" } }));
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.message, "Upstream redirects are not supported");
});

function nativeResponse(overrides = {}) {
  return {
    id: "resp_native", object: "response", created_at: 1730000000, status: "completed", model: "gpt-6.1-sol",
    output: [{ id: "msg_native", type: "message", role: "assistant", status: "completed", content: [
      { type: "output_text", text: "Native answer", annotations: [] }
    ] }],
    usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } },
    ...overrides
  };
}

function nativeSSE(frames) {
  return frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
}

function chatEvents(body) {
  return body.split("\n\n").filter(Boolean).map((frame) => {
    const data = frame.slice("data: ".length);
    return data === "[DONE]" ? data : JSON.parse(data);
  });
}

const nativeEnv = { ...env, UPSTREAM_API: "responses" };
const autoEnv = { ...env, UPSTREAM_API: "auto" };
const qwenBody = { model: "gpt-6.1-sol", messages: [{ role: "user", content: "Hello" }] };
const endpointError = "模型 gpt-6.1-sol 不支持 /v1/chat/completions 接口，请改用 /v1/responses（OpenAI Responses API）。Model gpt-6.1-sol does not support /v1/chat/completions, please use /v1/responses instead.";

test("auto defaults to native Responses and preserves Codex-specific fields", async (t) => {
  const config = { ...env };
  delete config.UPSTREAM_API;
  const body = { model: "gpt-6.1-sol", input: [{ type: "reasoning", encrypted_content: "opaque" },
    { role: "user", content: [{ type: "input_file", file_id: "file-1" }] }],
    reasoning: { effort: "high", summary: "auto" }, include: ["reasoning.encrypted_content"], previous_response_id: "resp_old", store: true };
  const data = nativeResponse();
  const calls = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://agentrouter.org/v1/responses");
    assert.deepEqual(JSON.parse(init.body), body);
    assert.equal(init.headers.get("Authorization"), `Bearer ${env.UPSTREAM_API_KEY}`);
    return Response.json(data);
  });
  const response = await worker.fetch(request("/v1/responses", { body }), config);
  assert.deepEqual(await response.json(), data);
  assert.equal(calls.mock.callCount(), 1);
});

test("native Codex Responses SSE is passed through without translation", async (t) => {
  const body = nativeSSE([{ type: "response.completed", response: nativeResponse() }]);
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://agentrouter.org/v1/responses");
    return streamResponse(body);
  });
  const response = await worker.fetch(request("/responses", { body: { model: "gpt-6.1-sol", input: "Hello", stream: true } }), autoEnv);
  assert.equal(await response.text(), body);
});

test("Qwen endpoint-only rejection switches to Responses and returns Chat JSON", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    urls.push(url);
    assert.equal(init.headers.get("Authorization"), `Bearer ${env.UPSTREAM_API_KEY}`);
    if (url.endsWith("/chat/completions")) return Response.json({ error: { message: endpointError } }, { status: 400 });
    const body = JSON.parse(init.body);
    assert.equal(body.model, "gpt-6.1-sol");
    assert.deepEqual(body.input, [{ type: "message", role: "user", content: "Hello" }]);
    assert.equal(body.messages, undefined);
    return Response.json(nativeResponse());
  });
  const response = await worker.fetch(request("/v1/chat/completions", { body: qwenBody }), autoEnv);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.object, "chat.completion");
  assert.equal(data.choices[0].message.content, "Native answer");
  assert.equal(data.choices[0].finish_reason, "stop");
  assert.equal(data.usage.prompt_tokens, 12);
  assert.equal(data.usage.completion_tokens_details.reasoning_tokens, 3);
  assert.deepEqual(urls, ["https://agentrouter.org/v1/chat/completions", "https://agentrouter.org/v1/responses"]);
});

test("forced Responses avoids the unsupported Chat attempt and converts Qwen history/options", async (t) => {
  const schema = { type: "object", properties: { answer: { type: "string" } } };
  const calls = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://agentrouter.org/v1/responses");
    const body = JSON.parse(init.body);
    assert.deepEqual(body.input[0], { type: "message", role: "system", content: "Be brief" });
    assert.equal(body.input[1].content[1].type, "input_image");
    assert.equal(body.input[1].content[1].image_url, "https://example.com/image.png");
    assert.deepEqual(body.input[2], { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" });
    assert.deepEqual(body.input[3], { type: "function_call_output", call_id: "call-1", output: "result" });
    assert.equal(body.tools[0].name, "lookup");
    assert.equal(body.tools[0].function, undefined);
    assert.deepEqual(body.tool_choice, { type: "function", name: "lookup" });
    assert.deepEqual(body.text.format, { type: "json_schema", name: "answer", schema, strict: true });
    assert.equal(body.reasoning.effort, "high");
    assert.equal(body.max_output_tokens, 1024);
    assert.equal(body.text.verbosity, "low");
    assert.equal(body.store, false);
    return Response.json(nativeResponse());
  });
  const response = await worker.fetch(request("/chat/completions", { body: {
    ...qwenBody, messages: [
      { role: "system", content: "Be brief" },
      { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "https://example.com/image.png", detail: "low" } }] },
      { role: "assistant", content: null, tool_calls: [{ type: "function", id: "call-1", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "result" }
    ], tools: [{ type: "function", function: { name: "lookup", parameters: {}, strict: true } }],
    tool_choice: { type: "function", function: { name: "lookup" } },
    response_format: { type: "json_schema", json_schema: { name: "answer", schema, strict: true } },
    reasoning_effort: "high", max_completion_tokens: 1024, verbosity: "low"
  } }), nativeEnv);
  assert.equal(response.status, 200);
  assert.equal(calls.mock.callCount(), 1);
});

for (const [name, failure] of [
  ["invalid parameters", { status: 400, message: "unsupported parameter max_tokens on /v1/chat/completions" }],
  ["model not found", { status: 404, message: "Model gpt-6.1-sol not found" }],
  ["authentication", { status: 401, message: endpointError }],
  ["rate limit", { status: 429, message: endpointError }],
  ["server error", { status: 500, message: endpointError }]
]) {
  test(`auto does not retry ${name}`, async (t) => {
    const calls = t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: failure.message } }, { status: failure.status }));
    const response = await worker.fetch(request("/v1/chat/completions", { body: qwenBody }), autoEnv);
    assert.equal(response.status, failure.status);
    assert.equal(calls.mock.callCount(), 1);
  });
}

test("auto does not retry network failures", async (t) => {
  const calls = t.mock.method(globalThis, "fetch", async () => { throw new Error("network error"); });
  assert.equal((await worker.fetch(request("/v1/chat/completions", { body: qwenBody }), autoEnv)).status, 502);
  assert.equal(calls.mock.callCount(), 1);
});

test("auto falls back to legacy Chat for an explicitly unsupported Responses endpoint", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    if (url.endsWith("/responses")) return Response.json({ error: { message: "Model legacy does not support /v1/responses, use /v1/chat/completions instead" } }, { status: 400 });
    return chatResponse();
  });
  const response = await worker.fetch(request(), autoEnv);
  assert.equal((await response.json()).output[0].content[0].text, "Hi");
  assert.deepEqual(urls, ["https://agentrouter.org/v1/responses", "https://agentrouter.org/v1/chat/completions"]);
});

test("forced Responses does not fall back when the upstream rejects it", async (t) => {
  const calls = t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: "Unsupported /v1/responses endpoint" } }, { status: 400 }));
  assert.equal((await worker.fetch(request(), nativeEnv)).status, 400);
  assert.equal(calls.mock.callCount(), 1);
});

test("adapter rejects unsupported Chat semantics before a forced Responses request", async (t) => {
  const calls = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const options of [{ n: 2 }, { stop: ["END"] }, { logprobs: true }, { seed: 1 },
    { messages: [] }, { messages: [{ role: "user", content: [{ type: "input_audio" }] }] },
    { tools: [{ type: "custom", name: "custom" }] }, { tool_choice: { type: "function", function: { name: "missing" } } }]) {
    assert.equal((await worker.fetch(request("/chat/completions", { body: { ...qwenBody, ...options } }), nativeEnv)).status, 400);
  }
  assert.equal(calls.mock.callCount(), 0);
});

test("invalid upstream API configuration fails closed", async (t) => {
  const calls = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  assert.equal((await worker.fetch(request(), { ...env, UPSTREAM_API: "invalid" })).status, 500);
  assert.equal(calls.mock.callCount(), 0);
});

test("native Responses JSON errors retain status and key redaction for Qwen", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "rate_limit_exceeded", message: `Limited ${env.UPSTREAM_API_KEY}` } }, { status: 429 }));
  const response = await worker.fetch(request("/chat/completions", { body: qwenBody }), nativeEnv);
  const data = await response.json();
  assert.equal(response.status, 429);
  assert.equal(data.error.code, "rate_limit_exceeded");
  assert.equal(data.error.message, "Limited [REDACTED]");
});

test("Qwen streaming switches APIs and receives Chat deltas, usage, and DONE", async (t) => {
  const data = nativeResponse({ output: [{ id: "msg_native", type: "message", role: "assistant", status: "completed", content: [
    { type: "output_text", text: "你好", annotations: [] }
  ] }] });
  const wire = nativeSSE([
    { type: "response.created", response: { ...data, status: "in_progress", output: [] } },
    { type: "response.output_text.delta", item_id: "msg_native", output_index: 0, content_index: 0, delta: "你" },
    { type: "response.output_text.delta", item_id: "msg_native", output_index: 0, content_index: 0, delta: "好" },
    { type: "response.output_text.done", item_id: "msg_native", output_index: 0, content_index: 0, text: "你好" },
    { type: "response.output_item.done", output_index: 0, item: data.output[0] },
    { type: "response.completed", response: data }
  ]);
  const calls = t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.endsWith("/chat/completions")) return Response.json({ error: { message: endpointError } }, { status: 400 });
    assert.equal(JSON.parse(init.body).stream, true);
    const bytes = new TextEncoder().encode(wire);
    let index = 0;
    return streamResponse(new ReadableStream({ pull(controller) {
      if (index >= bytes.length) controller.close();
      else { controller.enqueue(bytes.slice(index, index + 11)); index += 11; }
    } }));
  });
  const response = await worker.fetch(request("/v1/chat/completions", { body: { ...qwenBody, stream: true, stream_options: { include_usage: true } } }), autoEnv);
  const result = chatEvents(await response.text());
  assert.equal(result.at(-1), "[DONE]");
  const chunks = result.filter((event) => typeof event !== "string");
  assert.ok(chunks.every((event) => event.object === "chat.completion.chunk"));
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(chunks.map((event) => event.choices[0]?.delta.content || "").join(""), "你好");
  assert.equal(new Set(chunks.map((event) => event.id)).size, 1);
  assert.equal(chunks.filter((event) => event.choices[0]?.finish_reason === "stop").length, 1);
  assert.deepEqual(chunks.at(-1).choices, []);
  assert.equal(chunks.at(-1).usage.total_tokens, 17);
  assert.equal(calls.mock.callCount(), 2);
});

test("Responses terminal-only streams still emit Chat output without a usage-only chunk by default", async (t) => {
  t.mock.method(globalThis, "fetch", async () => streamResponse(nativeSSE([{ type: "response.completed", response: nativeResponse() }])));
  const response = await worker.fetch(request("/chat/completions", { body: { ...qwenBody, stream: true } }), nativeEnv);
  const result = chatEvents(await response.text());
  assert.equal(result.filter((event) => typeof event !== "string").map((event) => event.choices[0].delta.content || "").join(""), "Native answer");
  assert.equal(result.at(-2).choices[0].finish_reason, "stop");
  assert.ok(result.slice(0, -1).every((event) => event.choices.length === 1));
});

test("Responses parallel functions become separate Chat tool indexes without duplicated arguments", async (t) => {
  const first = { type: "function_call", id: "fc_0", call_id: "call_0", name: "first", arguments: '{"x":1}' };
  const second = { type: "function_call", id: "fc_1", call_id: "call_1", name: "second", arguments: '{"y":2}' };
  const message = { type: "message", id: "msg_2", role: "assistant", content: [{ type: "output_text", text: "Working", annotations: [] }] };
  const reasoning = { type: "reasoning", id: "rs_0", summary: [] };
  t.mock.method(globalThis, "fetch", async () => streamResponse(nativeSSE([
    { type: "response.output_item.added", output_index: 1, item: { ...first, arguments: "" } },
    { type: "response.output_item.added", output_index: 3, item: { ...second, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_0", delta: '{"x":' },
    { type: "response.output_text.delta", output_index: 2, item_id: "msg_2", content_index: 0, delta: "Working" },
    { type: "response.function_call_arguments.delta", output_index: 3, item_id: "fc_1", delta: '{"y":2}' },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_0", delta: "1}" },
    { type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_0", arguments: first.arguments },
    { type: "response.output_item.done", output_index: 1, item: first },
    { type: "response.completed", response: nativeResponse({ output: [reasoning, first, message, second] }) }
  ])));
  const response = await worker.fetch(request("/chat/completions", { body: { ...qwenBody, stream: true } }), nativeEnv);
  const result = chatEvents(await response.text());
  const calls = [];
  for (const event of result.slice(0, -1)) {
    for (const tool of event.choices[0]?.delta.tool_calls || []) {
      calls[tool.index] ||= { id: "", name: "", arguments: "" };
      if (tool.id) calls[tool.index].id = tool.id;
      calls[tool.index].name += tool.function.name || "";
      calls[tool.index].arguments += tool.function.arguments || "";
    }
  }
  assert.deepEqual(calls, [{ id: "call_0", name: "first", arguments: first.arguments }, { id: "call_1", name: "second", arguments: second.arguments }]);
  assert.equal(result.at(-2).choices[0].finish_reason, "tool_calls");
  assert.equal(result.slice(0, -1).map((event) => event.choices[0]?.delta.content || "").join(""), "Working");
});

test("Responses refusals are preserved in Chat JSON and streamed refusal fields", async (t) => {
  const data = nativeResponse({ output: [{ type: "message", id: "msg_refusal", role: "assistant", content: [{ type: "refusal", refusal: "Cannot help" }] }] });
  t.mock.method(globalThis, "fetch", async (_url, init) => JSON.parse(init.body).stream ? streamResponse(nativeSSE([
    { type: "response.refusal.delta", output_index: 0, item_id: "msg_refusal", content_index: 0, delta: "Cannot " },
    { type: "response.refusal.delta", output_index: 0, item_id: "msg_refusal", content_index: 0, delta: "help" },
    { type: "response.completed", response: data }
  ])) : Response.json(data));
  const json = await (await worker.fetch(request("/chat/completions", { body: qwenBody }), nativeEnv)).json();
  assert.equal(json.choices[0].message.refusal, "Cannot help");
  const stream = await worker.fetch(request("/chat/completions", { body: { ...qwenBody, stream: true } }), nativeEnv);
  const events = chatEvents(await stream.text()).slice(0, -1);
  assert.equal(events.map((event) => event.choices[0]?.delta.refusal || "").join(""), "Cannot help");
});

for (const reason of ["max_output_tokens", "content_filter"]) {
  test(`Responses incomplete ${reason} maps to Chat finish reason in JSON and SSE`, async (t) => {
    const data = nativeResponse({ status: "incomplete", incomplete_details: { reason } });
    t.mock.method(globalThis, "fetch", async (_url, init) => JSON.parse(init.body).stream ?
      streamResponse(nativeSSE([{ type: "response.incomplete", response: data }])) : Response.json(data));
    const finish = reason === "content_filter" ? "content_filter" : "length";
    const json = await (await worker.fetch(request("/chat/completions", { body: qwenBody }), nativeEnv)).json();
    assert.equal(json.choices[0].finish_reason, finish);
    const stream = await worker.fetch(request("/chat/completions", { body: { ...qwenBody, stream: true } }), nativeEnv);
    assert.equal(chatEvents(await stream.text()).at(-2).choices[0].finish_reason, finish);
  });
}

for (const [name, frames] of [
  ["failed response", [{ type: "response.failed", response: nativeResponse({ status: "failed", error: { message: `Failure ${env.UPSTREAM_API_KEY}` } }) }]],
  ["truncated response", [{ type: "response.output_text.delta", output_index: 0, item_id: "msg_partial", delta: "partial" }]],
  ["malformed response", [{ type: "response.completed", response: { status: "completed" } }]]
]) {
  test(`${name} is an error event, never a successful Chat finish`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => streamResponse(nativeSSE(frames)));
    const stream = await worker.fetch(request("/chat/completions", { body: { ...qwenBody, stream: true } }), nativeEnv);
    const events = chatEvents(await stream.text());
    assert.equal(events.at(-1), "[DONE]");
    assert.ok(events.some((event) => event.error));
    assert.ok(!JSON.stringify(events).includes(env.UPSTREAM_API_KEY));
    assert.ok(!events.some((event) => event.choices?.[0].finish_reason));
  });
}

test("Qwen streaming rejects a non-SSE Responses reply with HTTP 502", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(nativeResponse()));
  const response = await worker.fetch(request("/chat/completions", { body: { ...qwenBody, stream: true } }), nativeEnv);
  assert.equal(response.status, 502);
});

test("Qwen disconnect cancels the native Responses upstream", async (t) => {
  const cancelled = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async () => streamResponse(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(nativeSSE([{ type: "response.created", response: nativeResponse({ status: "in_progress", output: [] }) }]))); },
    cancel() { cancelled.resolve(); }
  })));
  const response = await worker.fetch(request("/chat/completions", { body: { ...qwenBody, stream: true } }), nativeEnv);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await cancelled.promise;
});

test("invalid Responses JSON or incomplete function metadata is controlled HTTP 502", async (t) => {
  for (const data of [{}, nativeResponse({ status: "in_progress" }), nativeResponse({ output: [{ type: "function_call", name: "lookup", arguments: "{}" }] }),
    nativeResponse({ output: [{ type: "message", content: [{ type: "output_audio", data: "audio" }] }] })]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(data));
    assert.equal((await worker.fetch(request("/chat/completions", { body: qwenBody }), nativeEnv)).status, 502);
  }
});

test("Qwen assistant text/refusal arrays use complete Responses output-message records", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const history = JSON.parse(init.body).input;
    assert.equal(history[0].role, "assistant");
    assert.match(history[0].id, /^msg_/);
    assert.equal(history[0].status, "completed");
    assert.deepEqual(history[0].content, [
      { type: "output_text", text: "Previous answer", annotations: [] }, { type: "refusal", refusal: "Cannot continue" }
    ]);
    return Response.json(nativeResponse());
  });
  const response = await worker.fetch(request("/chat/completions", { body: {
    ...qwenBody, messages: [{ role: "assistant", content: [{ type: "text", text: "Previous answer" }], refusal: "Cannot continue" },
      { role: "user", content: "Hello" }]
  } }), nativeEnv);
  assert.equal(response.status, 200);
});

let workerInstance = 0;
async function freshWorker() {
  const url = "data:text/javascript;base64," + Buffer.from(source).toString("base64") + "#isolate-" + ++workerInstance;
  return testWorker((await import(url)).default);
}
const dualKeyEnv = { ...nativeEnv, UPSTREAM_API_KEY_1: env.UPSTREAM_API_KEY + "-backup" };
const primarySession = "session-0";
const secondarySession = "session-1";
async function health(instance, config = dualKeyEnv, options = {}) {
  const { path = "/health", ...requestOptions } = options;
  return (await instance.fetch(request(path, { method: "GET", ...requestOptions }), config)).json();
}
async function routedCall(instance, config = dualKeyEnv, options = {}) {
  const response = await instance.fetch(request("/chat/completions", { body: qwenBody, ...options }), config);
  await response.text();
  return response;
}

test("health starts empty, is protected, never reaches the platform, and is not cached", async (t) => {
  const instance = await freshWorker();
  const calls = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  let identity;
  for (const path of ["/health", "/v1/health"]) {
    const response = await instance.fetch(request(path, { method: "GET" }), dualKeyEnv);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    const data = await response.json();
    assert.equal(data.scope, "d1");
    assert.equal(data.rotation, undefined);
    assert.deepEqual(data.routing, { mode: "session_hash", source: "default", preferred_key: "UPSTREAM_API_KEY", selected_key: "UPSTREAM_API_KEY" });
    assert.deepEqual(data.routing_stats, { session_requests: 0, default_requests: 0 });
    assert.match(data.instance.id, /^[0-9a-f-]{36}$/);
    assert.ok(Number.isFinite(Date.parse(data.instance.started_at)));
    if (identity) assert.deepEqual(data.instance, identity);
    identity = data.instance;
    assert.deepEqual(data.keys.map((key) => [key.name, key.calls, key.success_calls, key.error_calls, key.in_flight]), [
      ["UPSTREAM_API_KEY", 0, 0, 0, 0], ["UPSTREAM_API_KEY_1", 0, 0, 0, 0]
    ]);
    assert.ok(data.keys.every((key) => key.key_configured && key.last_error === null));
  }
  const denied = await instance.fetch(request("/health", { method: "GET", headers: { Authorization: null } }), dualKeyEnv);
  assert.equal(denied.status, 401);
  const head = await instance.fetch(request("/health", { method: "HEAD" }), dualKeyEnv);
  assert.equal(head.body, null);
  const post = await instance.fetch(request("/health"), dualKeyEnv);
  assert.equal(post.status, 405);
  assert.equal(calls.mock.callCount(), 0);
});

test("growing conversations keep their key across isolates and past the old 50-call boundary", async (t) => {
  const instances = await Promise.all([freshWorker(), freshWorker(), freshWorker()]);
  const observed = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    observed.push([init.headers.get("session_id"), init.headers.get("Authorization"), JSON.parse(init.body).input.length]);
    return Response.json(nativeResponse());
  });
  for (const session of [primarySession, secondarySession]) {
    const messages = [{ role: "user", content: "Original question" }];
    for (let turn = 0; turn < 55; turn++) {
      if (turn) messages.push({ role: "assistant", content: "Reply " + turn }, { role: "user", content: "Follow-up " + turn });
      const response = await routedCall(instances[turn % instances.length], dualKeyEnv, {
        headers: { session_id: session }, body: { ...qwenBody, messages }
      });
      assert.equal(response.status, 200);
    }
  }
  assert.deepEqual(observed.map((entry) => entry[1]), [
    ...Array(55).fill("Bearer " + env.UPSTREAM_API_KEY),
    ...Array(55).fill("Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1)
  ]);
  assert.equal(observed[54][2], 109);
  assert.equal(observed[109][2], 109);
});

test("concurrent conversations keep session affinity and share atomic D1 counters", async (t) => {
  const instances = await Promise.all([freshWorker(), freshWorker(), freshWorker()]);
  const observed = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const session = init.headers.get("X-Session-ID");
    const expected = session === primarySession ? env.UPSTREAM_API_KEY : dualKeyEnv.UPSTREAM_API_KEY_1;
    assert.equal(init.headers.get("Authorization"), "Bearer " + expected);
    observed.push(session);
    return Response.json(nativeResponse());
  });
  await Promise.all(Array.from({ length: 123 }, (_, index) => routedCall(instances[index % 3], dualKeyEnv, {
    headers: { "X-Session-ID": index % 2 ? secondarySession : primarySession }
  })));
  assert.equal(observed.filter((session) => session === primarySession).length, 62);
  assert.equal(observed.filter((session) => session === secondarySession).length, 61);
  const snapshots = await Promise.all(instances.map((instance) => health(instance)));
  for (const snapshot of snapshots) assert.deepEqual(snapshot.keys.map((key) => key.calls), [62, 61]);
});

for (const header of ["X-Session-ID", "session_id", "X-Conversation-ID", "conversation_id"]) {
  test("session routing reads " + header + " and health predicts the same key", async (t) => {
    const instance = await freshWorker();
    const calls = t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(init.headers.get("Authorization"), "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1);
      assert.equal(init.headers.get(header), secondarySession);
      return Response.json(nativeResponse());
    });
    await routedCall(instance, dualKeyEnv, { headers: { [header]: secondarySession } });
    const snapshot = await health(instance, dualKeyEnv, { headers: { [header]: secondarySession } });
    assert.deepEqual(snapshot.routing, { mode: "session_hash", source: header.toLowerCase(), preferred_key: "UPSTREAM_API_KEY_1", selected_key: "UPSTREAM_API_KEY_1" });
    assert.deepEqual(snapshot.keys.map((key) => key.calls), [0, 1]);
    assert.equal(calls.mock.callCount(), 1);
  });
}

for (const [name, path, api, body, reply] of [
  ["native Responses", "/responses", "responses", input, () => Response.json(nativeResponse())],
  ["Responses via Chat", "/responses", "chat", input, chatResponse],
  ["native Chat", "/chat/completions", "chat", qwenBody, chatResponse],
  ["Chat via Responses", "/chat/completions", "responses", qwenBody, () => Response.json(nativeResponse())]
]) {
  test("prompt_cache_key provides affinity for " + name, async (t) => {
    const instance = await freshWorker();
    const payload = { ...body, prompt_cache_key: secondarySession };
    const calls = t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(init.headers.get("Authorization"), "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1);
      if (name.startsWith("native")) assert.deepEqual(JSON.parse(init.body), payload);
      return reply();
    });
    const response = await instance.fetch(request(path, { body: payload }), { ...dualKeyEnv, UPSTREAM_API: api });
    assert.equal(response.status, 200);
    await response.text();
    const snapshot = await health(instance, dualKeyEnv, { path: "/health?prompt_cache_key=" + secondarySession });
    assert.equal(snapshot.routing.source, "query.prompt_cache_key");
    assert.equal(snapshot.routing.selected_key, "UPSTREAM_API_KEY_1");
    assert.deepEqual(snapshot.keys.map((key) => key.calls), [0, 1]);
    assert.equal(calls.mock.callCount(), 1);
  });
}

for (const field of ["session_id", "sessionId", "conversation_id", "conversationId"]) {
  test("metadata." + field + " provides a stable session identifier ahead of prompt_cache_key", async (t) => {
    const instance = await freshWorker();
    const observed = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      observed.push(init.headers.get("Authorization"));
      return Response.json(nativeResponse());
    });
    for (const promptId of ["turn-1", "turn-2"]) {
      const response = await routedCall(instance, dualKeyEnv, {
        body: { ...qwenBody, metadata: { [field]: primarySession, promptId }, prompt_cache_key: secondarySession }
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(observed, ["Bearer " + env.UPSTREAM_API_KEY, "Bearer " + env.UPSTREAM_API_KEY]);
  });
}

test("explicit session headers take priority over other headers, metadata and prompt_cache_key", async (t) => {
  const instance = await freshWorker();
  const calls = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.get("Authorization"), "Bearer " + env.UPSTREAM_API_KEY);
    assert.equal(JSON.parse(init.body).prompt_cache_key, secondarySession);
    return Response.json(nativeResponse());
  });
  await routedCall(instance, dualKeyEnv, {
    headers: { "X-Session-ID": primarySession, session_id: secondarySession },
    body: { ...qwenBody, metadata: { sessionId: secondarySession }, prompt_cache_key: secondarySession }
  });
  const snapshot = await health(instance, dualKeyEnv, {
    path: "/health?session_id=" + secondarySession,
    headers: { "X-Session-ID": primarySession, session_id: secondarySession }
  });
  assert.deepEqual(snapshot.routing, { mode: "session_hash", source: "x-session-id", preferred_key: "UPSTREAM_API_KEY", selected_key: "UPSTREAM_API_KEY" });
  assert.equal(calls.mock.callCount(), 1);
});

test("blank identifiers are skipped and whitespace is normalized without rewriting the payload", async (t) => {
  const instance = await freshWorker();
  const calls = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.get("Authorization"), "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1);
    assert.equal(JSON.parse(init.body).prompt_cache_key, "  " + secondarySession + "  ");
    return Response.json(nativeResponse());
  });
  await routedCall(instance, dualKeyEnv, {
    headers: { "X-Session-ID": " ", session_id: "" },
    body: { ...qwenBody, prompt_cache_key: "  " + secondarySession + "  " }
  });
  assert.equal(calls.mock.callCount(), 1);
});

for (const field of ["thread_id", "threadId"]) {
  test("Codex turn metadata uses only its stable " + field + " for affinity", async (t) => {
    const instance = await freshWorker();
    const observed = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      observed.push(init.headers.get("Authorization"));
      return Response.json(nativeResponse());
    });
    for (const turnId of ["turn-1", "turn-2"]) {
      const response = await routedCall(instance, dualKeyEnv, {
        headers: { "X-Codex-Turn-Metadata": JSON.stringify({ [field]: secondarySession, turnId, callId: turnId + "-call" }) },
        body: { ...qwenBody, prompt_cache_key: primarySession }
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(observed, ["Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1, "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1]);
    const snapshot = await health(instance);
    assert.equal(snapshot.routing_logs[0].source, "x-codex-turn-metadata." + field);
    assert.equal(snapshot.routing_logs[0].session_fingerprint, snapshot.routing_logs[1].session_fingerprint);
  });
}

test("malformed or turn-only Codex metadata cannot replace a stable prompt_cache_key", async (t) => {
  const instance = await freshWorker();
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.get("Authorization"), "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1);
    return Response.json(nativeResponse());
  });
  for (const metadata of ["not JSON", '{"threadId":42}', '{"turnId":"changes-per-turn"}']) {
    const response = await routedCall(instance, dualKeyEnv, {
      headers: { "X-Codex-Turn-Metadata": metadata }, body: { ...qwenBody, prompt_cache_key: secondarySession }
    });
    assert.equal(response.status, 200);
  }
  assert.ok((await health(instance)).routing_logs.every((log) => log.source === "prompt_cache_key"));
});

test("routing diagnostics expose field names and key choices without identifier values, prompts or secrets", async (t) => {
  const instance = await freshWorker();
  const output = t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "fetch", async () => Response.json(nativeResponse()));
  const response = await routedCall(instance, dualKeyEnv, {
    headers: {
      session_id: secondarySession, "X-Unknown-Thread": "private-unknown-identifier",
      "User-Agent": "Codex/test " + env.PROXY_API_KEY + " " + dualKeyEnv.UPSTREAM_API_KEY_1
    },
    body: {
      ...qwenBody, messages: [{ role: "user", content: "private-prompt-content" }],
      metadata: { sessionId: secondarySession, promptId: "private-turn-identifier" },
      prompt_cache_key: "private-cache-identifier"
    }
  });
  assert.equal(response.status, 200);
  assert.equal(output.mock.callCount(), 1);
  const log = JSON.parse(output.mock.calls[0].arguments[0]);
  const snapshot = await health(instance);
  assert.deepEqual(snapshot.routing_logs, [log]);
  assert.equal(log.event, "upstream_routing");
  assert.equal(log.source, "session_id");
  assert.equal(log.reason, "session_hash");
  assert.equal(log.selected_key, "UPSTREAM_API_KEY_1");
  assert.equal(log.user_agent, "Codex/test [REDACTED] [REDACTED]");
  assert.equal(log.instance_id, snapshot.instance.id);
  assert.match(log.session_fingerprint, /^[0-9a-f]{12}$/);
  assert.ok(log.header_names.includes("session_id"));
  assert.ok(log.header_names.includes("x-unknown-thread"));
  assert.ok(log.body_fields.includes("prompt_cache_key"));
  assert.deepEqual(log.metadata_fields, ["sessionId", "promptId"]);
  for (const value of [
    env.PROXY_API_KEY, env.UPSTREAM_API_KEY, dualKeyEnv.UPSTREAM_API_KEY_1, secondarySession,
    "private-prompt-content", "private-turn-identifier", "private-cache-identifier", "private-unknown-identifier"
  ]) assert.ok(!JSON.stringify(log).includes(value));
});

test("unknown client identifier fields remain observable without guessing an unstable session", async (t) => {
  const instance = await freshWorker();
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.get("Authorization"), "Bearer " + env.UPSTREAM_API_KEY);
    return Response.json(nativeResponse());
  });
  const response = await routedCall(instance, dualKeyEnv, {
    headers: { "X-Client-Thread": "unrecognized-thread-value" },
    body: { ...qwenBody, metadata: { conversation_token: "unrecognized-conversation-value" } }
  });
  assert.equal(response.status, 200);
  const snapshot = await health(instance);
  const log = snapshot.routing_logs[0];
  assert.equal(log.source, "default");
  assert.equal(log.session_fingerprint, null);
  assert.ok(log.header_names.includes("x-client-thread"));
  assert.ok(log.metadata_fields.includes("conversation_token"));
  assert.deepEqual(snapshot.routing_stats, { session_requests: 0, default_requests: 1 });
});

test("routing diagnostics are bounded and console output can be disabled", async (t) => {
  const instance = await freshWorker();
  const output = t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "fetch", async () => Response.json(nativeResponse()));
  const config = { ...dualKeyEnv, ROUTING_LOGS: "off" };
  for (let index = 0; index < 25; index++) assert.equal((await routedCall(instance, config)).status, 200);
  const snapshot = await health(instance, config);
  assert.equal(snapshot.routing_logs.length, 20);
  assert.equal(new Set(snapshot.routing_logs.map((log) => log.request_id)).size, 20);
  assert.ok(snapshot.routing_logs.every((log) => log.attempt === 1 && log.reason === "default"));
  assert.deepEqual(snapshot.routing_stats, { session_requests: 0, default_requests: 25 });
  assert.equal(output.mock.callCount(), 0);
});

test("requests without a usable session identifier keep the first key instead of rotating", async (t) => {
  const instance = await freshWorker();
  const calls = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.get("Authorization"), "Bearer " + env.UPSTREAM_API_KEY);
    return Response.json(nativeResponse());
  });
  for (let index = 0; index < 101; index++) await routedCall(instance);
  for (const prompt_cache_key of ["", " ", 123, { id: secondarySession }]) {
    await routedCall(instance, dualKeyEnv, { body: { ...qwenBody, prompt_cache_key } });
  }
  const snapshot = await health(instance);
  assert.deepEqual(snapshot.routing, { mode: "session_hash", source: "default", preferred_key: "UPSTREAM_API_KEY", selected_key: "UPSTREAM_API_KEY" });
  assert.deepEqual(snapshot.keys.map((key) => key.calls), [105, 0]);
  assert.deepEqual(snapshot.routing_stats, { session_requests: 0, default_requests: 105 });
  assert.equal(calls.mock.callCount(), 105);
});

test("health session previews are stateless, private, and do not reserve an upstream call", async (t) => {
  const first = await freshWorker();
  const second = await freshWorker();
  const calls = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const [session, selected_key] of [[primarySession, "UPSTREAM_API_KEY"], [secondarySession, "UPSTREAM_API_KEY_1"]]) {
    const path = "/health?session_id=" + encodeURIComponent(session);
    const a = await health(first, dualKeyEnv, { path });
    const b = await health(second, dualKeyEnv, { path: "/v1" + path });
    assert.deepEqual(a.routing, { mode: "session_hash", source: "query.session_id", preferred_key: selected_key, selected_key });
    assert.deepEqual(a.routing, b.routing);
    assert.notEqual(a.instance.id, b.instance.id);
    assert.ok(a.keys.every((key) => key.calls === 0));
    assert.deepEqual(a.routing_stats, { session_requests: 0, default_requests: 0 });
    assert.ok(!JSON.stringify(a).includes(session));
    for (const secret of [env.PROXY_API_KEY, env.UPSTREAM_API_KEY, dualKeyEnv.UPSTREAM_API_KEY_1]) {
      assert.ok(!JSON.stringify(a).includes(secret));
    }
  }
  assert.equal(calls.mock.callCount(), 0);
});

test("bodyless passthrough uses session headers and business query strings are not session identifiers", async (t) => {
  const instance = await freshWorker();
  const observed = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    observed.push(init.headers.get("Authorization"));
    return Response.json({ data: [] });
  });
  for (const headers of [{ "X-Session-ID": secondarySession }, {}]) {
    const response = await instance.fetch(request("/models?session_id=" + secondarySession, { method: "GET", headers }), dualKeyEnv);
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.deepEqual(observed, ["Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1, "Bearer " + env.UPSTREAM_API_KEY]);
});

test("CORS preflight allows the supported session headers", async (t) => {
  const instance = await freshWorker();
  const calls = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  const response = await instance.fetch(request("/responses", { method: "OPTIONS" }), dualKeyEnv);
  const allowed = response.headers.get("Access-Control-Allow-Headers").toLowerCase().split(",").map((name) => name.trim());
  for (const name of ["x-session-id", "session_id", "x-conversation-id", "conversation_id"]) assert.ok(allowed.includes(name));
  assert.equal(calls.mock.callCount(), 0);
});

test("HTTP and network failures consume attempts and keep a redacted last error after later successes", async (t) => {
  const instance = await freshWorker();
  let count = 0;
  t.mock.method(globalThis, "fetch", async () => {
    count++;
    if (count <= 2) return Response.json({ error: { message: "Server failure " + dualKeyEnv.UPSTREAM_API_KEY_1 } }, { status: 503 });
    if (count === 3) throw new Error("Connect " + env.PROXY_API_KEY + " " + env.UPSTREAM_API_KEY + " " + dualKeyEnv.UPSTREAM_API_KEY_1);
    return Response.json(nativeResponse());
  });
  for (let index = 0; index < 50; index++) await routedCall(instance);
  const data = await health(instance);
  assert.equal(data.routing.selected_key, "UPSTREAM_API_KEY");
  assert.deepEqual([data.keys[0].calls, data.keys[0].success_calls, data.keys[0].error_calls, data.keys[0].in_flight], [50, 47, 3, 0]);
  assert.equal(data.keys[0].last_error.status, null);
  assert.equal(data.keys[0].last_error.message, "Connect [REDACTED] [REDACTED] [REDACTED]");
  assert.match(data.keys[0].last_error.at, /^\d{4}-\d{2}-\d{2}T/);
  for (const key of [env.PROXY_API_KEY, env.UPSTREAM_API_KEY, dualKeyEnv.UPSTREAM_API_KEY_1]) assert.ok(!JSON.stringify(data).includes(key));
});

test("health, preflight, rejected authentication and local validation do not use a key", async (t) => {
  const instance = await freshWorker();
  const calls = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  await health(instance);
  await instance.fetch(request("/chat/completions", { method: "OPTIONS" }), dualKeyEnv);
  assert.equal((await instance.fetch(request("/chat/completions", { headers: { Authorization: "Bearer wrong" } }), dualKeyEnv)).status, 401);
  assert.equal((await instance.fetch(request("/chat/completions", { rawBody: "{" }), dualKeyEnv)).status, 400);
  assert.equal((await instance.fetch(request("/chat/completions", { body: { ...qwenBody, n: 2 } }), dualKeyEnv)).status, 400);
  assert.equal((await instance.fetch(request("/chat/completions", { body: qwenBody }), { ...dualKeyEnv, UPSTREAM_BASE: "http://example.com/v1" })).status, 500);
  const data = await health(instance);
  assert.ok(data.keys.every((key) => key.calls === 0));
  assert.deepEqual(data.routing_stats, { session_requests: 0, default_requests: 0 });
  assert.equal(calls.mock.callCount(), 0);
});

test("auto endpoint fallback counts both attempts and keeps the same session key", async (t) => {
  const instance = await freshWorker();
  const keys = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    keys.push(init.headers.get("Authorization"));
    if (url.endsWith("/chat/completions")) return Response.json({ error: { message: endpointError } }, { status: 400 });
    return Response.json(nativeResponse());
  });
  const options = { headers: { session_id: secondarySession } };
  for (let index = 0; index < 49; index++) await routedCall(instance, dualKeyEnv, options);
  await routedCall(instance, { ...dualKeyEnv, UPSTREAM_API: "auto" }, options);
  const data = await health(instance);
  assert.deepEqual(keys, Array(51).fill("Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1));
  assert.deepEqual(data.keys.map((key) => [key.calls, key.success_calls, key.error_calls]), [[0, 0, 0], [51, 50, 1]]);
  assert.deepEqual(data.routing_stats, { session_requests: 50, default_requests: 0 });
});

test("a key limit retries the same payload and subsequent requests bypass its shared cooldown", async (t) => {
  const instance = await freshWorker();
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, key: init.headers.get("Authorization"), body: init.body });
    if (calls.length === 12) return Response.json({ error: {
      code: "insufficient_quota", message: "No quota for " + env.UPSTREAM_API_KEY
    } }, { status: 429 });
    return Response.json(nativeResponse());
  });
  const options = { headers: { session_id: primarySession } };
  for (let index = 0; index < 11; index++) await routedCall(instance, dualKeyEnv, options);
  assert.equal((await routedCall(instance, dualKeyEnv, options)).status, 200);
  assert.deepEqual(calls.slice(-2).map((call) => call.key), ["Bearer " + env.UPSTREAM_API_KEY, "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1]);
  assert.equal(calls[11].url, calls[12].url);
  assert.equal(calls[11].body, calls[12].body);
  let data = await health(instance);
  assert.deepEqual(data.keys.map((key) => [key.calls, key.success_calls, key.error_calls, key.in_flight]), [[12, 11, 1, 0], [1, 1, 0, 0]]);
  assert.deepEqual(data.routing_stats, { session_requests: 12, default_requests: 0 });
  assert.equal(data.keys[0].last_error.message, "No quota for [REDACTED]");
  for (let index = 0; index < 49; index++) await routedCall(instance, dualKeyEnv, options);
  data = await health(instance);
  assert.equal(calls.at(-1).key, "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1);
  assert.equal(data.routing.preferred_key, "UPSTREAM_API_KEY");
  assert.equal(data.routing.selected_key, "UPSTREAM_API_KEY_1");
  assert.deepEqual(data.keys.map((key) => [key.calls, key.success_calls, key.error_calls]), [[12, 11, 1], [50, 50, 0]]);
});

for (const [name, status, body] of [
  ["HTTP rate limit", 429, "Too many requests"],
  ["HTTP authentication failure", 401, "Unauthorized"],
  ["quota error code", 400, { error: { code: "insufficient_quota", message: "Limit reached" } }],
  ["token quota error type", 403, { error: { type: "insufficient_token_quota", message: "Limit reached" } }],
  ["billing code", 402, { error: { code: "billing_hard_limit_reached", message: "Limit reached" } }],
  ["expired key code", 403, { error: { code: "api_key_expired", message: "Access denied" } }],
  ["top-level quota code", 403, { code: "quota_exceeded", message: "Limit reached" }],
  ["Chinese quota message", 403, { error: { message: "用户额度不足" } }],
  ["Chinese exhausted token quota", 403, { error: { message: "令牌额度已用尽" } }],
  ["English balance message", 402, { error: { message: "Insufficient balance for this request" } }],
  ["Chinese key message", 403, { error: { message: "令牌已过期" } }]
]) {
  test(`key failover recognizes ${name}`, async (t) => {
    const instance = await freshWorker();
    const calls = t.mock.method(globalThis, "fetch", async (_url, init) => {
      if (init.headers.get("Authorization") === `Bearer ${env.UPSTREAM_API_KEY}`) {
        return typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status });
      }
      return Response.json(nativeResponse());
    });
    assert.equal((await routedCall(instance)).status, 200);
    assert.equal(calls.mock.callCount(), 2);
    assert.deepEqual((await health(instance)).keys.map((key) => [key.calls, key.success_calls, key.error_calls]), [[1, 0, 1], [1, 1, 0]]);
  });
}

for (const [name, status, error] of [
  ["invalid parameters", 400, { code: "invalid_parameter", message: "max_tokens exceeds the model limit" }],
  ["context limit", 400, { code: "context_length_exceeded", message: "Token limit exceeded" }],
  ["unknown payment error", 402, { message: "Payment required" }],
  ["model permission", 403, { code: "permission_denied", message: "Model access forbidden" }],
  ["quota words in diagnostic metadata", 403, { code: "unknown", details: "quota exceeded" }],
  ["model not found", 404, { code: "model_not_found", message: "Model not found" }],
  ["server error with a quota code", 500, { code: "insufficient_quota", message: "Insufficient quota" }],
  ["temporary overload", 503, { message: "Server overloaded" }]
]) {
  test(`key failover does not retry for ${name}`, async (t) => {
    const instance = await freshWorker();
    const calls = t.mock.method(globalThis, "fetch", async () => Response.json({ error }, { status }));
    const response = await routedCall(instance);
    assert.equal(response.status, status);
    assert.equal(calls.mock.callCount(), 1);
    assert.deepEqual((await health(instance)).keys.map((key) => key.calls), [1, 0]);
  });
}

test("network failures do not trigger key failover", async (t) => {
  const instance = await freshWorker();
  const calls = t.mock.method(globalThis, "fetch", async () => { throw new Error("connection lost"); });
  assert.equal((await routedCall(instance)).status, 502);
  assert.equal(calls.mock.callCount(), 1);
  assert.deepEqual((await health(instance)).keys.map((key) => key.calls), [1, 0]);
});

test("two limited keys return the second error without bouncing back", async (t) => {
  const instance = await freshWorker();
  const calls = t.mock.method(globalThis, "fetch", async (_url, init) => Response.json({ error: {
    code: "rate_limit_exceeded", message: `Limited ${init.headers.get("Authorization")}`
  } }, { status: 429, headers: { "Retry-After": "30" } }));
  const response = await instance.fetch(request("/chat/completions", { body: qwenBody }), dualKeyEnv);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "30");
  assert.equal((await response.json()).error.message, "Limited Bearer [REDACTED]");
  assert.equal(calls.mock.callCount(), 2);
  const data = await health(instance);
  assert.deepEqual(data.keys.map((key) => [key.calls, key.error_calls, key.in_flight]), [[1, 1, 0], [1, 1, 0]]);
  assert.equal(data.routing.preferred_key, "UPSTREAM_API_KEY");
  assert.equal(data.routing.selected_key, null);
  assert.equal(data.status, "unavailable");
});

test("an exhausted secondary session bypasses its cooldown while retaining its hashed preference", async (t) => {
  const instance = await freshWorker();
  const keys = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const key = init.headers.get("Authorization");
    keys.push(key);
    if (key === "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1) return new Response("Limited", { status: 429 });
    return Response.json(nativeResponse());
  });
  const options = { headers: { session_id: secondarySession } };
  assert.equal((await routedCall(instance, dualKeyEnv, options)).status, 200);
  assert.equal((await routedCall(instance, dualKeyEnv, options)).status, 200);
  assert.deepEqual(keys, [
    "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1, "Bearer " + env.UPSTREAM_API_KEY, "Bearer " + env.UPSTREAM_API_KEY
  ]);
  const snapshot = await health(instance, dualKeyEnv, { path: "/health?session_id=" + secondarySession });
  assert.equal(snapshot.routing.preferred_key, "UPSTREAM_API_KEY_1");
  assert.equal(snapshot.routing.selected_key, "UPSTREAM_API_KEY");
  assert.deepEqual(snapshot.keys.map((key) => [key.calls, key.success_calls, key.error_calls]), [[2, 2, 0], [1, 0, 1]]);
});

test("a key failure on call 50 does not introduce a rotation boundary", async (t) => {
  const instance = await freshWorker();
  let count = 0;
  const keys = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    keys.push(init.headers.get("Authorization"));
    return ++count === 50 ? new Response("Limited", { status: 429 }) : Response.json(nativeResponse());
  });
  for (let index = 0; index < 50; index++) await routedCall(instance);
  const data = await health(instance);
  assert.deepEqual(data.keys.map((key) => [key.calls, key.success_calls, key.error_calls]), [[50, 49, 1], [1, 1, 0]]);
  await routedCall(instance);
  assert.deepEqual(keys.slice(-3), [
    "Bearer " + env.UPSTREAM_API_KEY, "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1, "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1
  ]);
});

test("concurrent key failures share cooldown without changing hashed session preferences", { timeout: 5000 }, async (t) => {
  const instance = await freshWorker();
  const pending = [];
  let initialReady, retryReady;
  const initial = new Promise((resolve) => { initialReady = resolve; });
  const retried = new Promise((resolve) => { retryReady = resolve; });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init.headers.get("Authorization") === "Bearer " + env.UPSTREAM_API_KEY && pending.length < 2) {
      return new Promise((resolve) => {
        pending.push(resolve);
        if (pending.length === 2) initialReady();
      });
    }
    if (init.headers.get("Authorization") === "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1) retryReady();
    return Response.json(nativeResponse());
  });
  const options = { headers: { session_id: primarySession } };
  const requests = [routedCall(instance, dualKeyEnv, options), routedCall(instance, dualKeyEnv, options)];
  await initial;
  pending[0](new Response("Limited", { status: 429 }));
  await retried;
  await routedCall(instance, dualKeyEnv, options);
  await routedCall(instance, dualKeyEnv, { headers: { session_id: secondarySession } });
  pending[1](new Response("Limited", { status: 429 }));
  await Promise.all(requests);
  const data = await health(instance);
  assert.deepEqual(data.keys.map((key) => [key.calls, key.success_calls, key.error_calls]), [[2, 0, 2], [4, 4, 0]]);
  const primary = (await health(instance, dualKeyEnv, { path: "/health?session_id=" + primarySession })).routing;
  assert.equal(primary.preferred_key, "UPSTREAM_API_KEY");
  assert.equal(primary.selected_key, "UPSTREAM_API_KEY_1");
  assert.equal((await health(instance, dualKeyEnv, { path: "/health?session_id=" + secondarySession })).routing.selected_key, "UPSTREAM_API_KEY_1");
});

test("a delayed key failure shares cooldown while preserving other conversations' preferences", { timeout: 5000 }, async (t) => {
  const instance = await freshWorker();
  let release, initialReady;
  const initial = new Promise((resolve) => { initialReady = resolve; });
  const keys = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    keys.push(init.headers.get("Authorization"));
    if (keys.length === 1) return new Promise((resolve) => { release = resolve; initialReady(); });
    return Response.json(nativeResponse());
  });
  const delayed = routedCall(instance, dualKeyEnv, { headers: { session_id: primarySession } });
  await initial;
  for (let index = 0; index < 101; index++) await routedCall(instance, dualKeyEnv, {
    headers: { session_id: index % 2 ? secondarySession : primarySession }
  });
  release(new Response("Unauthorized", { status: 401 }));
  assert.equal((await delayed).status, 200);
  assert.equal(keys.at(-1), "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1);
  const data = await health(instance);
  assert.deepEqual(data.keys.map((key) => [key.calls, key.success_calls, key.error_calls]), [[52, 51, 1], [51, 51, 0]]);
  await routedCall(instance, dualKeyEnv, { headers: { session_id: primarySession } });
  assert.equal(keys.at(-1), "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1);
});

for (const [name, config] of [
  ["single key", nativeEnv],
  ["duplicate secrets", { ...dualKeyEnv, UPSTREAM_API_KEY_1: env.UPSTREAM_API_KEY }]
]) {
  test(`key failover skips ${name}`, async (t) => {
    const instance = await freshWorker();
    const calls = t.mock.method(globalThis, "fetch", async () => new Response("Limited", { status: 429 }));
    assert.equal((await routedCall(instance, config)).status, 429);
    assert.equal(calls.mock.callCount(), 1);
    assert.equal((await health(instance, config)).keys.filter((key) => !key.duplicate_of).reduce((total, key) => total + key.calls, 0), 1);
  });
}

for (const failFirstEndpoint of [false, true]) {
  test(`auto endpoint fallback shares one key failover budget (${failFirstEndpoint ? "key first" : "endpoint first"})`, async (t) => {
    const instance = await freshWorker();
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const key = init.headers.get("Authorization");
      calls.push([url.split("/v1/")[1], key]);
      if (url.endsWith("/chat/completions")) {
        if (failFirstEndpoint && key === `Bearer ${env.UPSTREAM_API_KEY}`) return new Response("Limited", { status: 429 });
        return Response.json({ error: { message: endpointError } }, { status: 400 });
      }
      if (failFirstEndpoint || key === `Bearer ${env.UPSTREAM_API_KEY}`) return new Response("Limited", { status: 429 });
      return Response.json(nativeResponse());
    });
    const response = await routedCall(instance, { ...dualKeyEnv, UPSTREAM_API: "auto" });
    assert.equal(response.status, failFirstEndpoint ? 429 : 200);
    assert.deepEqual(calls, failFirstEndpoint ? [
      ["chat/completions", `Bearer ${env.UPSTREAM_API_KEY}`],
      ["chat/completions", `Bearer ${dualKeyEnv.UPSTREAM_API_KEY_1}`],
      ["responses", `Bearer ${dualKeyEnv.UPSTREAM_API_KEY_1}`]
    ] : [
      ["chat/completions", `Bearer ${env.UPSTREAM_API_KEY}`],
      ["responses", `Bearer ${env.UPSTREAM_API_KEY}`],
      ["responses", `Bearer ${dualKeyEnv.UPSTREAM_API_KEY_1}`]
    ]);
    const snapshot = await health(instance);
    assert.deepEqual(snapshot.routing_logs.map((log) => log.reason), failFirstEndpoint ?
      ["default", "key_failover", "endpoint_fallback"] : ["default", "endpoint_fallback", "key_failover"]);
    assert.equal(new Set(snapshot.routing_logs.map((log) => log.request_id)).size, 1);
    assert.deepEqual(snapshot.routing_stats, { session_requests: 0, default_requests: 1 });
  });
}

for (const [name, path, body, api, reply, verify] of [
  ["native Responses", "/responses", input, "responses", () => Response.json(nativeResponse()), (text) => assert.equal(JSON.parse(text).object, "response")],
  ["Responses via Chat", "/responses", input, "chat", chatResponse, (text) => assert.equal(JSON.parse(text).output[0].content[0].text, "Hi")],
  ["native Chat", "/chat/completions", qwenBody, "chat", chatResponse, (text) => assert.equal(JSON.parse(text).choices[0].message.content, "Hi")],
  ["Responses SSE", "/responses", { ...input, stream: true }, "responses", () => streamResponse(nativeSSE([{ type: "response.completed", response: nativeResponse() }])), (text) => assert.match(text, /response.completed/)],
  ["Chat SSE via Responses", "/chat/completions", { ...qwenBody, stream: true }, "responses", () => streamResponse(nativeSSE([{ type: "response.completed", response: nativeResponse() }])), (text) => assert.match(text, /\[DONE\]/)],
  ["bodyless passthrough", "/models", null, "responses", () => Response.json({ data: [] }), (text) => assert.deepEqual(JSON.parse(text), { data: [] })]
]) {
  test(`key failover preserves ${name}`, async (t) => {
    const instance = await freshWorker();
    const calls = t.mock.method(globalThis, "fetch", async (_url, init) =>
      init.headers.get("Authorization") === `Bearer ${env.UPSTREAM_API_KEY}` ? new Response("Limited", { status: 429 }) : reply());
    const response = await instance.fetch(request(path, { body, method: body === null ? "GET" : "POST" }), { ...dualKeyEnv, UPSTREAM_API: api });
    assert.equal(response.status, 200);
    verify(await response.text());
    assert.equal(calls.mock.callCount(), 2);
    assert.deepEqual((await health(instance)).keys.map((key) => [key.success_calls, key.error_calls]), [[0, 1], [1, 0]]);
  });
}

test("streaming upload errors do not replay bytes and future requests bypass the failed key", async (t) => {
  const instance = await freshWorker();
  const bytes = new Uint8Array([0, 128, 255, 10]);
  const calls = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.get("Authorization"), "Bearer " + (init.method === "POST" ? env.UPSTREAM_API_KEY : dualKeyEnv.UPSTREAM_API_KEY_1));
    if (init.method === "POST") {
      assert.deepEqual(new Uint8Array(await new Response(init.body).arrayBuffer()), bytes);
      return new Response("Limited", { status: 429 });
    }
    assert.equal(init.body, undefined);
    return Response.json({ data: [] });
  });
  const headers = { "X-Session-ID": primarySession, "Content-Type": "multipart/form-data; boundary=test" };
  const response = await instance.fetch(request("/files", { rawBody: bytes, headers }), dualKeyEnv);
  assert.equal(response.status, 429);
  assert.equal(calls.mock.callCount(), 1);
  const next = await instance.fetch(request("/models", { method: "GET", headers: { "X-Session-ID": primarySession } }), dualKeyEnv);
  assert.equal(next.status, 200);
  await next.text();
  assert.equal(calls.mock.callCount(), 2);
  assert.deepEqual((await health(instance)).keys.map((key) => [key.calls, key.success_calls, key.error_calls]), [[1, 0, 1], [1, 1, 0]]);
});

test("a quota error after SSE starts is recorded without replaying the stream", async (t) => {
  const instance = await freshWorker();
  const wire = nativeSSE([
    { type: "response.output_text.delta", delta: "partial" },
    { type: "response.failed", response: nativeResponse({ status: "failed", error: { code: "insufficient_quota", message: "Insufficient quota" } }) }
  ]);
  const calls = t.mock.method(globalThis, "fetch", async () => streamResponse(wire));
  const response = await instance.fetch(request("/responses", { body: { ...input, stream: true } }), dualKeyEnv);
  assert.equal(await response.text(), wire);
  assert.equal(calls.mock.callCount(), 1);
  const data = await health(instance);
  assert.equal(data.routing.preferred_key, "UPSTREAM_API_KEY");
  assert.equal(data.routing.selected_key, "UPSTREAM_API_KEY_1");
  assert.equal(data.keys[0].available, false);
  assert.equal(data.keys[0].error_calls, 1);
});

test("client cancellation prevents key failover after an HTTP rejection", async (t) => {
  const instance = await freshWorker();
  const abort = new AbortController();
  const calls = t.mock.method(globalThis, "fetch", async () => {
    abort.abort();
    return new Response("Limited", { status: 429 });
  });
  const req = new Request(request("/chat/completions", { body: qwenBody }), { signal: abort.signal });
  const response = await instance.fetch(req, dualKeyEnv);
  assert.equal(response.status, 429);
  assert.equal(calls.mock.callCount(), 1);
  assert.deepEqual((await health(instance)).keys.map((key) => key.calls), [1, 0]);
});

test("a missing secondary key retains single-key operation and is visible in health", async (t) => {
  const instance = await freshWorker();
  const keys = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    keys.push(init.headers.get("Authorization"));
    return Response.json(nativeResponse());
  });
  for (let index = 0; index < 51; index++) await routedCall(instance, nativeEnv);
  const data = await health(instance, nativeEnv);
  assert.equal(data.keys[1].key_configured, false);
  assert.equal(data.keys[1].calls, 0);
  assert.equal(data.keys[0].calls, 51);
  assert.equal(data.routing.selected_key, "UPSTREAM_API_KEY");
  assert.ok(keys.every((key) => key === `Bearer ${env.UPSTREAM_API_KEY}`));
});

test("secondary-only configuration serves requests and health diagnoses missing platform keys", async (t) => {
  const instance = await freshWorker();
  const config = { ...dualKeyEnv, UPSTREAM_API_KEY: undefined };
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.get("Authorization"), `Bearer ${dualKeyEnv.UPSTREAM_API_KEY_1}`);
    return Response.json(nativeResponse());
  });
  await routedCall(instance, config);
  const data = await health(instance, config);
  assert.equal(data.routing.selected_key, "UPSTREAM_API_KEY_1");
  assert.equal(data.keys[0].key_configured, false);
  assert.equal(data.keys[1].success_calls, 1);
  const empty = await instance.fetch(request("/health", { method: "GET" }), { PROXY_API_KEY: env.PROXY_API_KEY });
  assert.equal(empty.status, 503);
  assert.equal((await empty.json()).routing.selected_key, null);
});

test("fresh Worker isolates share session routing, D1 counters and recent diagnostics", async (t) => {
  const first = await freshWorker();
  const second = await freshWorker();
  t.mock.method(globalThis, "fetch", async () => Response.json(nativeResponse()));
  const options = { headers: { session_id: secondarySession } };
  await routedCall(first, dualKeyEnv, options);
  const a = await health(first, dualKeyEnv, options);
  const b = await health(second, dualKeyEnv, options);
  assert.deepEqual(a.routing, b.routing);
  assert.equal(a.routing.selected_key, "UPSTREAM_API_KEY_1");
  assert.equal(a.keys[1].calls, 1);
  assert.equal(b.keys[1].calls, 1);
  assert.deepEqual(a.routing_logs, b.routing_logs);
  assert.notEqual(a.instance.id, b.instance.id);
});

test("native streaming remains in flight until a terminal event is received", async (t) => {
  const instance = await freshWorker();
  let sourceController;
  const created = nativeSSE([{ type: "response.created", response: nativeResponse({ status: "in_progress", output: [] }) }]);
  const completed = nativeSSE([{ type: "response.completed", response: nativeResponse() }]);
  t.mock.method(globalThis, "fetch", async () => streamResponse(new ReadableStream({ start(controller) {
    sourceController = controller;
    controller.enqueue(new TextEncoder().encode(created));
  } })));
  const response = await instance.fetch(request("/responses", { body: { model: "gpt-6.1-sol", input: "Hello", stream: true } }), dualKeyEnv);
  const pending = (await health(instance)).keys[0];
  assert.deepEqual([pending.calls, pending.success_calls, pending.error_calls, pending.in_flight], [1, 0, 0, 1]);
  sourceController.enqueue(new TextEncoder().encode(completed));
  sourceController.close();
  assert.equal(await response.text(), created + completed);
  const finished = (await health(instance)).keys[0];
  assert.deepEqual([finished.calls, finished.success_calls, finished.error_calls, finished.in_flight], [1, 1, 0, 0]);
});

for (const [name, frames] of [
  ["server error", [{ type: "response.failed", response: nativeResponse({ status: "failed", error: { message: `Failure ${dualKeyEnv.UPSTREAM_API_KEY_1}` } }) }]],
  ["truncation", [{ type: "response.output_text.delta", output_index: 0, item_id: "msg_partial", delta: "partial" }]]
]) {
  test(`native SSE ${name} is recorded as failure despite HTTP 200`, async (t) => {
    const instance = await freshWorker();
    t.mock.method(globalThis, "fetch", async () => streamResponse(nativeSSE(frames)));
    const response = await instance.fetch(request("/responses", { body: { model: "gpt-6.1-sol", input: "Hello", stream: true } }), dualKeyEnv);
    assert.equal(response.status, 200);
    await response.text();
    const data = await health(instance);
    assert.deepEqual([data.keys[0].calls, data.keys[0].success_calls, data.keys[0].error_calls, data.keys[0].in_flight], [1, 0, 1, 0]);
    assert.equal(data.keys[0].last_error.status, 200);
    assert.ok(!JSON.stringify(data).includes(dualKeyEnv.UPSTREAM_API_KEY_1));
  });
}

test("Qwen conversion records one successful upstream stream and does not count terminal cancellation as failure", async (t) => {
  const instance = await freshWorker();
  t.mock.method(globalThis, "fetch", async () => streamResponse(nativeSSE([{ type: "response.completed", response: nativeResponse() }])));
  const response = await instance.fetch(request("/chat/completions", { body: { ...qwenBody, stream: true } }), dualKeyEnv);
  assert.equal(chatEvents(await response.text()).at(-1), "[DONE]");
  const key = (await health(instance)).keys[0];
  assert.deepEqual([key.calls, key.success_calls, key.error_calls, key.in_flight], [1, 1, 0, 0]);
});

test("an invalid translated completion is reclassified as failure exactly once", async (t) => {
  const instance = await freshWorker();
  t.mock.method(globalThis, "fetch", async () => streamResponse(nativeSSE([{ type: "response.completed", response: { status: "completed", output: [{ type: "function_call", name: "missing-id", arguments: "{}" }] } }])));
  const response = await instance.fetch(request("/chat/completions", { body: { ...qwenBody, stream: true } }), dualKeyEnv);
  assert.ok(chatEvents(await response.text()).some((event) => event.error));
  const key = (await health(instance)).keys[0];
  assert.deepEqual([key.calls, key.success_calls, key.error_calls, key.in_flight], [1, 0, 1, 0]);
  assert.match(key.last_error.message, /ID/);
});

test("client cancellation before completion becomes a single failed attempt", async (t) => {
  const instance = await freshWorker();
  const cancelled = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async () => streamResponse(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(nativeSSE([{ type: "response.created", response: nativeResponse({ status: "in_progress", output: [] }) }]))); },
    cancel() { cancelled.resolve(); }
  })));
  const response = await instance.fetch(request("/responses", { body: { model: "gpt-6.1-sol", input: "Hello", stream: true } }), dualKeyEnv);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await cancelled.promise;
  const key = (await health(instance)).keys[0];
  assert.deepEqual([key.calls, key.success_calls, key.error_calls, key.in_flight], [1, 0, 1, 0]);
  assert.match(key.last_error.message, /cancelled/);
});

test("an incomplete token-limited response is a successful platform call", async (t) => {
  const instance = await freshWorker();
  t.mock.method(globalThis, "fetch", async () => streamResponse(nativeSSE([{ type: "response.incomplete", response: nativeResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }) }])));
  const response = await instance.fetch(request("/chat/completions", { body: { ...qwenBody, stream: true } }), dualKeyEnv);
  assert.equal(chatEvents(await response.text()).at(-2).choices[0].finish_reason, "length");
  assert.equal((await health(instance)).keys[0].success_calls, 1);
});

test("health errors cannot reveal JSON-escaped keys even without an error message", async (t) => {
  const instance = await freshWorker();
  const raw = JSON.stringify({ error: { code: dualKeyEnv.UPSTREAM_API_KEY_1 } }).replace("platform", "\\u0070latform");
  t.mock.method(globalThis, "fetch", async () => new Response(raw, { status: 429, headers: { "Content-Type": "application/json" } }));
  await routedCall(instance);
  const data = await health(instance);
  assert.equal(data.keys[0].last_error.message, '{"error":{"code":"[REDACTED]"}}');
});

test("health accepts its query token without an Authorization header", async (t) => {
  const instance = await freshWorker();
  const calls = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const path of ["/health", "/v1/health"]) {
    const response = await instance.fetch(request(`${path}?token=${encodeURIComponent(env.PROXY_API_KEY)}`, {
      method: "GET", headers: { Authorization: null }
    }), dualKeyEnv);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.status, "ok");
    assert.ok(data.keys.every((key) => key.calls === 0));
  }
  assert.equal(calls.mock.callCount(), 0);
});

test("health rejects missing, incorrect and platform query tokens", async (t) => {
  const instance = await freshWorker();
  const calls = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const token of ["", "wrong", env.UPSTREAM_API_KEY, dualKeyEnv.UPSTREAM_API_KEY_1]) {
    const response = await instance.fetch(request(`/health?token=${encodeURIComponent(token)}`, {
      method: "GET", headers: { Authorization: null }
    }), dualKeyEnv);
    assert.equal(response.status, 401);
  }
  assert.equal(calls.mock.callCount(), 0);
});

test("query tokens cannot authenticate business APIs or unrelated health suffixes", async (t) => {
  const instance = await freshWorker();
  const calls = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const path of ["/v1/responses", "/v1/chat/completions", "/v1/models", "/unrelated/health"]) {
    const response = await instance.fetch(request(`${path}?token=${encodeURIComponent(env.PROXY_API_KEY)}`, {
      headers: { Authorization: null }
    }), dualKeyEnv);
    assert.equal(response.status, 401);
  }
  assert.equal(calls.mock.callCount(), 0);
});

test("health query tokens support URL-encoded special characters", async (t) => {
  const instance = await freshWorker();
  t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  const proxyKey = "client+key&suffix#=/";
  const response = await instance.fetch(request(`/health?token=${encodeURIComponent(proxyKey)}`, {
    method: "GET", headers: { Authorization: null }
  }), { ...dualKeyEnv, PROXY_API_KEY: proxyKey });
  assert.equal(response.status, 200);
});

for (const header of ["thread-id", "thread_id", "session-id"]) {
  test(`Codex direct ${header} is recognized without turn metadata`, async (t) => {
    const instance = await freshWorker();
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(init.headers.get("Authorization"), "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1);
      return Response.json(nativeResponse());
    });
    await routedCall(instance, dualKeyEnv, { headers: { [header]: secondarySession } });
    const snapshot = await health(instance);
    assert.equal(snapshot.routing_logs[0].source, header);
    assert.deepEqual(snapshot.keys.map((key) => key.calls), [0, 1]);
  });
}

test("D1 initialization is repeatable and preserves all-time counters", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(nativeResponse()));
  await routedCall(worker);
  fixtureDB.sqlite.exec(d1SQL);
  const snapshot = await health(worker);
  assert.deepEqual(snapshot.keys.map((key) => [key.calls, key.success_calls, key.error_calls]), [[1, 1, 0], [0, 0, 0]]);
  assert.deepEqual(snapshot.routing_stats, { session_requests: 0, default_requests: 1 });
  assert.ok(fixtureDB.sessions.length > 0);
  assert.ok(fixtureDB.sessions.every((constraint) => constraint === "first-primary"));
});

test("replayed D1 batches cannot duplicate requests, attempts or outcome counters", async (t) => {
  fixtureDB.replayBatches = true;
  t.mock.method(globalThis, "fetch", async (_url, init) => init.headers.get("Authorization") === "Bearer " + env.UPSTREAM_API_KEY ?
    Response.json({ error: { code: "insufficient_quota", message: "Insufficient quota" } }, { status: 429 }) :
    Response.json(nativeResponse()));
  assert.equal((await routedCall(worker)).status, 200);
  const snapshot = await health(worker);
  assert.deepEqual(snapshot.keys.map((key) => [key.calls, key.success_calls, key.error_calls]), [[1, 0, 1], [1, 1, 0]]);
  assert.deepEqual(snapshot.routing_stats, { session_requests: 0, default_requests: 1 });
  assert.equal(snapshot.routing_logs.length, 2);
});

test("cold Worker isolates bypass cooldown and return to their hashed key after expiry", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const observed = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    observed.push(init.headers.get("Authorization"));
    return observed.length === 1 ? new Response("Limited", { status: 429, headers: { "Retry-After": "30" } }) :
      Response.json(nativeResponse());
  });
  const first = await freshWorker();
  await routedCall(first);
  const second = await freshWorker();
  await routedCall(second);
  const blocked = await health(second);
  assert.equal(blocked.keys[0].retry_after_seconds, 30);
  assert.equal(blocked.routing.preferred_key, "UPSTREAM_API_KEY");
  assert.equal(blocked.routing.selected_key, "UPSTREAM_API_KEY_1");
  assert.equal(blocked.routing_logs.at(-1).reason, "key_cooldown");
  now += 30000;
  const third = await freshWorker();
  await routedCall(third);
  assert.deepEqual(observed, ["Bearer " + env.UPSTREAM_API_KEY, "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1,
    "Bearer " + dualKeyEnv.UPSTREAM_API_KEY_1, "Bearer " + env.UPSTREAM_API_KEY]);
  const recovered = await health(third);
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.keys[0].cooldown_until, null);
  assert.equal(recovered.keys[0].available, true);
  assert.deepEqual(recovered.keys.map((key) => [key.calls, key.success_calls, key.error_calls]), [[2, 1, 1], [2, 2, 0]]);
});

for (const [label, retryAfter, configuredSeconds, expectedSeconds] of [
  ["default cooldown", null, undefined, 300],
  ["configured cooldown", null, "90", 90],
  ["Retry-After seconds", "12", "90", 12],
  ["Retry-After HTTP date", "date", "90", 60],
  ["invalid Retry-After", "not-a-date", "90", 90],
  ["fractional Retry-After", "1.5", "90", 90],
  ["zero Retry-After", "0", "90", 0]
]) {
  test(`shared key cooldown respects ${label}`, async (t) => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    t.mock.method(Date, "now", () => now);
    const config = { ...nativeEnv, ...(configuredSeconds === undefined ? {} : { KEY_COOLDOWN_SECONDS: configuredSeconds }) };
    const headers = retryAfter === null ? {} : { "Retry-After": retryAfter === "date" ? new Date(now + 60000).toUTCString() : retryAfter };
    t.mock.method(globalThis, "fetch", async () => new Response("Limited", { status: 429, headers }));
    await routedCall(worker, config);
    const snapshot = await health(worker, config);
    assert.equal(snapshot.keys[0].retry_after_seconds, expectedSeconds);
    assert.equal(snapshot.keys[0].available, expectedSeconds === 0);
  });
}

test("two cooling keys stop new requests globally without upstream calls or extra counters", async (t) => {
  const calls = t.mock.method(globalThis, "fetch", async () => new Response("Limited", { status: 429, headers: { "Retry-After": "60" } }));
  await routedCall(await freshWorker());
  const second = await freshWorker();
  const response = await routedCall(second);
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("Retry-After")) > 0);
  assert.equal(calls.mock.callCount(), 2);
  const snapshot = await health(second);
  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.routing.selected_key, null);
  assert.deepEqual(snapshot.keys.map((key) => key.calls), [1, 1]);
  assert.deepEqual(snapshot.routing_stats, { session_requests: 0, default_requests: 1 });
  assert.equal(snapshot.routing_logs.length, 2);
});

test("an alternate blocked by a concurrent request preserves the first upstream error", async (t) => {
  let release, ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const calls = t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init.headers.get("Authorization") === "Bearer " + env.UPSTREAM_API_KEY) {
      ready();
      return new Promise((resolve) => { release = resolve; });
    }
    return new Response("Secondary limited", { status: 429, headers: { "Retry-After": "45" } });
  });
  const pending = routedCall(await freshWorker());
  await started;
  await routedCall(await freshWorker(), { ...dualKeyEnv, UPSTREAM_API_KEY: undefined });
  release(Response.json({ error: { message: "Primary unauthorized", code: "invalid_api_key" } }, { status: 401 }));
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal(calls.mock.callCount(), 2);
  assert.deepEqual((await health(worker)).keys.map((key) => [key.calls, key.error_calls]), [[1, 1], [1, 1]]);
});

test("a delayed failure from before recovery cannot cool down the recovered generation", async (t) => {
  let now = Date.now(), release, ready, primaryCalls = 0;
  t.mock.method(Date, "now", () => now);
  const started = new Promise((resolve) => { ready = resolve; });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init.headers.get("Authorization") === "Bearer " + env.UPSTREAM_API_KEY) {
      primaryCalls++;
      if (primaryCalls === 1) { ready(); return new Promise((resolve) => { release = resolve; }); }
      if (primaryCalls === 2) return new Response("Limited", { status: 429, headers: { "Retry-After": "1" } });
    }
    return Response.json(nativeResponse());
  });
  const delayed = routedCall(await freshWorker());
  await started;
  await routedCall(await freshWorker());
  now += 1000;
  await routedCall(await freshWorker());
  release(new Response("Old unauthorized", { status: 401 }));
  await delayed;
  const snapshot = await health(worker);
  assert.equal(snapshot.keys[0].available, true);
  assert.equal(snapshot.routing.selected_key, "UPSTREAM_API_KEY");
  assert.deepEqual(snapshot.keys.map((key) => [key.calls, key.success_calls, key.error_calls]), [[3, 1, 2], [2, 2, 0]]);
});

test("late errors using an old secret cannot disable the replacement secret", async (t) => {
  let release, ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const replacement = { ...dualKeyEnv, UPSTREAM_API_KEY: "replacement-platform-test-key" };
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init.headers.get("Authorization") === "Bearer " + env.UPSTREAM_API_KEY) {
      ready(); return new Promise((resolve) => { release = resolve; });
    }
    return Response.json(nativeResponse());
  });
  const delayed = routedCall(await freshWorker());
  await started;
  await routedCall(await freshWorker(), replacement);
  release(new Response("Old unauthorized", { status: 401 }));
  await delayed;
  const snapshot = await health(worker, replacement);
  assert.equal(snapshot.keys[0].available, true);
  assert.deepEqual([snapshot.keys[0].calls, snapshot.keys[0].success_calls, snapshot.keys[0].error_calls], [1, 1, 0]);
  assert.equal(snapshot.routing.selected_key, "UPSTREAM_API_KEY");
});

for (const scenario of ["missing binding", "uninitialized database", "schema mismatch", "D1 unavailable"]) {
  test(`${scenario} returns actionable 503 before any upstream call`, async (t) => {
    const db = scenario === "missing binding" ? undefined : scenario === "uninitialized database" ? new TestD1(false) : fixtureDB;
    if (scenario === "schema mismatch") db.sqlite.exec("UPDATE proxy_stats SET schema_version = 999");
    if (scenario === "D1 unavailable") db.beforeBatch = () => { throw new Error("database unavailable " + env.UPSTREAM_API_KEY); };
    const config = { ...dualKeyEnv, DB: db };
    const calls = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
    for (const path of ["/responses", "/chat/completions", "/models", "/health"]) {
      const response = await worker.fetch(request(path, { method: path === "/models" || path === "/health" ? "GET" : "POST",
        body: path === "/chat/completions" ? qwenBody : input }), config);
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.match(text, /D1|DB/);
      assert.ok(!text.includes(env.UPSTREAM_API_KEY));
    }
    assert.equal(calls.mock.callCount(), 0);
    if (scenario === "schema mismatch") assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM proxy_requests").get().count, 0);
  });
}

test("D1 reservation failures roll back request and attempt counts atomically", async (t) => {
  fixtureDB.sqlite.exec("CREATE TRIGGER reject_attempt BEFORE INSERT ON proxy_attempts BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  const calls = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  assert.equal((await routedCall(worker)).status, 503);
  const snapshot = await health(worker);
  assert.deepEqual(snapshot.keys.map((key) => key.calls), [0, 0]);
  assert.deepEqual(snapshot.routing_stats, { session_requests: 0, default_requests: 0 });
  assert.equal(snapshot.routing_logs.length, 0);
  assert.equal(calls.mock.callCount(), 0);
});

test("a late D1 metrics failure is logged without corrupting successful model output", async (t) => {
  fixtureDB.beforeBatch = (statements) => {
    if (statements.some((query) => query.sql.startsWith("UPDATE proxy_attempts SET outcome"))) throw new Error("write failed " + env.UPSTREAM_API_KEY);
  };
  const output = t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => Response.json(nativeResponse()));
  const response = await worker.fetch(request("/responses"), dualKeyEnv);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).output[0].content[0].text, "Native answer");
  await fixtureDB.drain();
  assert.equal(output.mock.callCount(), 1);
  const log = JSON.parse(output.mock.calls[0].arguments[0]);
  assert.equal(log.event, "d1_state_error");
  assert.equal(log.operation, "finish_attempt");
  assert.ok(!JSON.stringify(log).includes(env.UPSTREAM_API_KEY));
});

test("scheduled retention keeps counters and classifies abandoned attempts as unknown", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => Response.json(nativeResponse()));
  await routedCall(worker);
  const unconsumed = await worker.fetch(request("/responses"), dualKeyEnv);
  now += 2 * 60 * 60 * 1000;
  const pending = await health(worker);
  assert.deepEqual([pending.keys[0].calls, pending.keys[0].in_flight, pending.keys[0].unknown_calls], [2, 0, 1]);
  now += 8 * 24 * 60 * 60 * 1000;
  await worker.scheduled({}, dualKeyEnv);
  const cleaned = await health(worker);
  assert.deepEqual([cleaned.keys[0].calls, cleaned.keys[0].success_calls, cleaned.keys[0].unknown_calls], [2, 1, 1]);
  assert.deepEqual(cleaned.routing_stats, { session_requests: 0, default_requests: 2 });
  assert.equal(cleaned.routing_logs.length, 0);
  assert.equal(fixtureDB.sqlite.prepare("SELECT COUNT(*) AS count FROM proxy_requests").get().count, 0);
  await unconsumed.body.cancel();
});

test("HTTP-200 JSON quota errors cool the key without replaying the model response", async (t) => {
  const calls = t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "insufficient_quota", message: "Insufficient quota" } }));
  const response = await worker.fetch(request("/responses"), dualKeyEnv);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(calls.mock.callCount(), 1);
  const snapshot = await health(worker);
  assert.equal(snapshot.keys[0].available, false);
  assert.equal(snapshot.routing.selected_key, "UPSTREAM_API_KEY_1");
});

test("POST /init creates an empty database and enables proxy calls using the embedded initializer", async (t) => {
  const db = new TestD1(false);
  const calls = t.mock.method(globalThis, "fetch", async () => Response.json(nativeResponse()));
  const response = await worker.fetch(request("/init"), { PROXY_API_KEY: env.PROXY_API_KEY, DB: db });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { status: "initialized", scope: "d1", schema_version: 1,
    source: "embedded", tables: 4, triggers: 4 });
  assert.equal(calls.mock.callCount(), 0);
  const config = { ...dualKeyEnv, DB: db };
  const empty = await health(worker, config);
  assert.deepEqual(empty.routing_stats, { session_requests: 0, default_requests: 0 });
  await routedCall(worker, config);
  const used = await health(worker, config);
  assert.deepEqual(used.keys.map((key) => [key.calls, key.success_calls, key.error_calls]), [[1, 1, 0], [0, 0, 0]]);
});

test("POST /v1/init reads the Assets binding and preserves existing statistics on repeat calls", async (t) => {
  const db = new TestD1(false);
  const assetFetch = t.mock.fn(async (req) => {
    assert.equal(new URL(req.url).pathname, "/d1-init.json");
    assert.equal(req.headers.get("Authorization"), null);
    return Response.json(initializerAsset);
  });
  const config = { ...dualKeyEnv, DB: db, ASSETS: { fetch: assetFetch } };
  t.mock.method(globalThis, "fetch", async () => new Response("Failure", { status: 503 }));
  assert.equal((await worker.fetch(request("/v1/init"), config)).status, 200);
  await routedCall(worker, config);
  const before = await health(worker, config);
  const response = await worker.fetch(request("/init"), config);
  assert.equal((await response.json()).source, "assets");
  const after = await health(worker, config);
  assert.deepEqual(after.keys, before.keys);
  assert.deepEqual(after.routing_stats, before.routing_stats);
  assert.deepEqual(after.routing_logs, before.routing_logs);
  assert.equal(assetFetch.mock.callCount(), 2);
});

test("initializer statements and Assets reproduce the canonical SQL schema with complete triggers", async () => {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(d1SQL));
  assert.equal(initializerAsset.source_sha256, Buffer.from(hash).toString("hex"));
  const db = new TestD1(false);
  await worker.fetch(request("/init"), { ...dualKeyEnv, DB: db });
  const schema = (database) => database.sqlite.prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'proxy_%' ORDER BY type, name")
    .all().map((row) => ({ ...row, sql: row.sql.replace(/\s+/g, " ").trim() }));
  assert.deepEqual(schema(db), schema(fixtureDB));
});

test("init requires authentication for writes, redirects API readers to login, and ignores request-provided SQL", async (t) => {
  const db = new TestD1(false);
  const config = { ...dualKeyEnv, DB: db };
  const calls = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const path of ["/init", "/v1/init"]) {
    for (const authorization of [null, "Bearer wrong-key", "Bearer " + env.UPSTREAM_API_KEY]) {
      const response = await worker.fetch(request(path, { headers: { Authorization: authorization } }), config);
      assert.equal(response.status, 401);
    }
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(request(path, { method }), config);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("Location"), "/login");
    }
    const query = await worker.fetch(request(path + "?token=" + env.PROXY_API_KEY, { headers: { Authorization: null } }), config);
    assert.equal(query.status, 401);
  }
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'proxy_%'").get().count, 0);
  const response = await worker.fetch(request("/init", { body: { sql: "DROP TABLE proxy_stats;" } }), config);
  assert.equal(response.status, 200);
  assert.equal(db.sqlite.prepare("SELECT schema_version FROM proxy_stats").get().schema_version, 1);
  assert.equal(calls.mock.callCount(), 0);
});

function browserRequest(path, { method = "GET", cookie, form, origin = "https://proxy.example", headers = {}, body, omitOrigin = false, omitFetchSite = false } = {}) {
  return new Request("https://proxy.example" + path, { method,
    headers: { Accept: "text/html", ...(cookie ? { Cookie: cookie } : {}),
      ...(method === "POST" ? { ...(omitOrigin ? {} : { Origin: origin }), "Content-Type": "application/x-www-form-urlencoded",
        ...(omitFetchSite ? {} : { "Sec-Fetch-Site": "same-origin" }) } : {}), ...headers },
    ...(method === "POST" ? { body: body ?? new URLSearchParams(form).toString() } : {}) });
}
async function browserLogin(instance = worker, config = env) {
  const response = await instance.fetch(browserRequest("/login", { method: "POST", form: { key: config.PROXY_API_KEY } }), config);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "/init");
  const cookie = response.headers.get("Set-Cookie").split(";")[0];
  const page = await instance.fetch(browserRequest("/init", { cookie }), config);
  assert.equal(page.status, 200);
  const html = await page.text();
  return { cookie, csrf: /name="csrf" value="([a-f0-9]+)"/.exec(html)[1], html, response };
}

test("browser login and init page work before D1 and upstream keys are configured, without database writes", async (t) => {
  const config = { PROXY_API_KEY: env.PROXY_API_KEY, DB: undefined };
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const path of ["/init", "/v1/init"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(browserRequest(path, { method }), config);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("Location"), "/login");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
  }
  for (const path of ["/login", "/v1/login"]) {
    const response = await worker.fetch(browserRequest(path), config);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /type="password"/);
    assert.ok(!html.includes(env.PROXY_API_KEY));
    assert.ok(!html.includes(env.UPSTREAM_API_KEY));
    assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  }
  const { cookie, html, response } = await browserLogin(worker, config);
  const setCookie = response.headers.get("Set-Cookie");
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=3600"]) assert.ok(setCookie.includes(attribute));
  assert.ok(setCookie.startsWith("__Host-"));
  assert.ok(!setCookie.includes(env.PROXY_API_KEY));
  assert.match(html, /action="\/init"/);
  assert.match(html, /重复初始化会保留已有数据/);
  assert.ok(!html.includes(env.PROXY_API_KEY));
  const head = await worker.fetch(browserRequest("/init", { method: "HEAD", cookie }), config);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await worker.fetch(browserRequest("/login", { cookie }), config)).status, 303);
  assert.equal(fixtureDB.batches.length, 0);
  assert.equal(upstream.mock.callCount(), 0);
});

test("a browser session survives isolate changes, initializes via Assets, and preserves cooldown and statistics on repeats", async (t) => {
  const db = new TestD1(false);
  const assetFetch = t.mock.fn(async () => Response.json(initializerAsset));
  const config = { ...dualKeyEnv, DB: db, ASSETS: { fetch: assetFetch } };
  const instance = await freshWorker();
  const { cookie, csrf } = await browserLogin(instance, config);
  const otherInstance = await freshWorker();
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "insufficient_quota", message: "quota exhausted" } }, { status: 429 }));
  assert.equal(db.batches.length, 0);
  const response = await otherInstance.fetch(browserRequest("/v1/init", { method: "POST", cookie, form: { csrf } }), config);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /初始化完成/);
  assert.equal(upstream.mock.callCount(), 0);
  const beforeCalls = await health(otherInstance, config);
  assert.deepEqual(beforeCalls.routing_stats, { session_requests: 0, default_requests: 0 });
  for (const method of ["GET", "HEAD"]) {
    const status = await otherInstance.fetch(browserRequest("/health", { method, cookie }), config);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("Cache-Control"), "no-store");
    if (method === "HEAD") assert.equal(status.body, null);
    else assert.deepEqual((await status.json()).routing_stats, beforeCalls.routing_stats);
  }
  assert.equal(upstream.mock.callCount(), 0);
  await routedCall(instance, config);
  const before = await health(otherInstance, config);
  assert.ok(before.keys.every((key) => !key.available));
  assert.equal((await otherInstance.fetch(browserRequest("/init", { method: "POST", cookie, form: { csrf } }), config)).status, 200);
  const after = await health(instance, config);
  assert.deepEqual(after.keys, before.keys);
  assert.deepEqual(after.routing_stats, before.routing_stats);
  assert.deepEqual(after.routing_logs, before.routing_logs);
  assert.equal(assetFetch.mock.callCount(), 2);
  const status = await otherInstance.fetch(browserRequest("/v1/health", { cookie }), config);
  assert.equal(status.status, 503); // Both keys are cooling down, but session authentication succeeded.
  assert.equal((await status.json()).scope, "d1");
});

test("browser login rejects incorrect credentials, unsafe origins and invalid forms without reflecting secrets", async () => {
  for (const key of ["wrong-key", env.UPSTREAM_API_KEY, "<script>alert(1)</script>", ""]) {
    const response = await worker.fetch(browserRequest("/login", { method: "POST", form: { key } }), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Set-Cookie"), null);
    const html = await response.text();
    assert.match(html, /代理 Key 不正确/);
    if (key) assert.ok(!html.includes(key));
  }
  for (const origin of ["https://attacker.example", ""]) {
    const response = await worker.fetch(browserRequest("/login", { method: "POST", origin, form: { key: env.PROXY_API_KEY } }), env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Set-Cookie"), null);
  }
  // Safari reports Origin: null on same-origin form POSTs while Sec-Fetch-Site stays same-origin.
  const nullOrigin = await worker.fetch(browserRequest("/login", { method: "POST", origin: "null", form: { key: env.PROXY_API_KEY } }), env);
  assert.equal(nullOrigin.status, 303);
  assert.match(nullOrigin.headers.get("Set-Cookie"), /^__Host-proxy-admin=/);
  for (const options of [{ origin: "null", headers: { "Sec-Fetch-Site": "cross-site" } }, { origin: "null", headers: { "Sec-Fetch-Site": "same-site" } }]) {
    const response = await worker.fetch(browserRequest("/login", { method: "POST", form: { key: env.PROXY_API_KEY }, ...options }), env);
    assert.equal(response.status, 403);
    assert.match(await response.text(), /Origin=null/);
  }
  const denied = await worker.fetch(browserRequest("/login", { method: "POST", origin: "https://attacker.example", form: { key: env.PROXY_API_KEY } }), env);
  const deniedHTML = await denied.text();
  assert.match(deniedHTML, /请求来源=https:\/\/proxy\.example/);
  assert.match(deniedHTML, /Origin=https:\/\/attacker\.example/);
  assert.match(deniedHTML, /Sec-Fetch-Site=same-origin/);
  assert.ok(!deniedHTML.includes(env.PROXY_API_KEY));
  for (const options of [
    { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: env.PROXY_API_KEY }) },
    { body: "key=" + "a".repeat(8200) }, { body: "key=one&key=two" }, { body: "invalid=one" }
  ]) {
    assert.equal((await worker.fetch(browserRequest("/login", { method: "POST", ...options }), env)).status, 400);
  }
  assert.equal((await worker.fetch(browserRequest("/login?token=" + env.PROXY_API_KEY), env)).status, 200);
  assert.equal((await worker.fetch(browserRequest("/login", { method: "HEAD" }), env)).body, null);
  assert.equal((await worker.fetch(browserRequest("/login", { method: "PUT" }), env)).status, 405);
});

test("browser sessions reject tampering, expiry, replacement secrets, duplicate cookies and other hosts", async (t) => {
  const { cookie } = await browserLogin();
  const value = cookie.split("=")[1];
  const parts = value.split(".");
  const nonce = parts[2];
  for (const invalid of [
    cookie.slice(0, -1) + (cookie.endsWith("0") ? "1" : "0"),
    cookie.replace(nonce, "0".repeat(32)),
    cookie + "; " + cookie,
    "__Host-proxy-admin=malformed"
  ]) {
    assert.equal((await worker.fetch(browserRequest("/init", { cookie: invalid }), env)).status, 303);
    assert.equal((await worker.fetch(browserRequest("/health", { cookie: invalid }), env)).status, 401);
  }
  assert.equal((await worker.fetch(browserRequest("/init", { cookie }), { ...env, PROXY_API_KEY: "replacement-secret" })).status, 303);
  const otherHost = new Request("https://other.example/init", { headers: { Cookie: cookie } });
  assert.equal((await worker.fetch(otherHost, env)).status, 303);
  const now = Date.now();
  const date = t.mock.method(Date, "now", () => now + 3601 * 1000);
  assert.equal((await worker.fetch(browserRequest("/init", { cookie }), env)).status, 303);
  assert.equal((await worker.fetch(browserRequest("/health", { cookie }), env)).status, 401);
  date.mock.restore();
});

test("cookie-authenticated writes require the matching session CSRF token and a same-origin form POST", async () => {
  const db = new TestD1(false);
  const config = { ...env, DB: db };
  const first = await browserLogin(worker, config);
  const second = await browserLogin(worker, config);
  for (const path of ["/init", "/logout"]) {
    for (const options of [
      { form: {} }, { form: { csrf: "wrong" } }, { form: { csrf: second.csrf } },
      { form: { csrf: first.csrf }, origin: "https://attacker.example" },
      { form: { csrf: first.csrf }, origin: "" },
      { form: { csrf: first.csrf }, headers: { "Sec-Fetch-Site": "cross-site" } },
      { form: { csrf: first.csrf }, headers: { "Sec-Fetch-Site": "same-site" } },
      { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csrf: first.csrf }) },
      { body: `csrf=${first.csrf}&csrf=${first.csrf}` }
    ]) {
      const response = await worker.fetch(browserRequest(path, { method: "POST", cookie: first.cookie, ...options }), config);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("Set-Cookie"), null);
    }
  }
  assert.equal(db.batches.length, 0);
  const stale = await worker.fetch(browserRequest("/init", { method: "POST", cookie: first.cookie, form: { csrf: second.csrf } }), config);
  assert.equal(stale.status, 403);
  assert.match(await stale.text(), /令牌不匹配/);
  assert.equal((await worker.fetch(browserRequest("/init", { cookie: first.cookie }), config)).status, 200);
  assert.equal(db.batches.length, 0);
});

test("form posts without an Origin header still require the session CSRF token", async () => {
  const db = new TestD1(false);
  const config = { ...env, DB: db };
  const wrongKey = await worker.fetch(browserRequest("/login", { method: "POST", omitOrigin: true, form: { key: "wrong-key" } }), config);
  assert.equal(wrongKey.status, 401);
  const login = await worker.fetch(browserRequest("/login", { method: "POST", omitOrigin: true, form: { key: env.PROXY_API_KEY } }), config);
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("Location"), "/init");
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  const page = await worker.fetch(browserRequest("/init", { cookie }), config);
  const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(await page.text())[1];
  for (const options of [
    { form: { csrf }, omitOrigin: true },
    { form: { csrf }, omitOrigin: true, omitFetchSite: true },
    { form: { csrf }, omitOrigin: true, headers: { "Sec-Fetch-Site": "none" } },
    { form: { csrf }, origin: "null" },
    { form: { csrf }, origin: "null", omitFetchSite: true }
  ]) {
    const response = await worker.fetch(browserRequest("/init", { method: "POST", cookie, ...options }), config);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /初始化完成/);
  }
  for (const options of [
    { form: { csrf }, origin: "https://attacker.example" },
    { form: { csrf }, origin: "null", headers: { "Sec-Fetch-Site": "cross-site" } },
    { form: { csrf }, origin: "null", headers: { "Sec-Fetch-Site": "same-site" } },
    { form: { csrf }, origin: "" },
    { form: { csrf }, headers: { "Sec-Fetch-Site": "cross-site" } },
    { form: { csrf }, omitOrigin: true, headers: { "Sec-Fetch-Site": "cross-site" } },
    { form: { csrf }, omitOrigin: true, headers: { "Sec-Fetch-Site": "same-site" } },
    { omitOrigin: true },
    { form: { csrf: "wrong" }, omitOrigin: true }
  ]) {
    assert.equal((await worker.fetch(browserRequest("/init", { method: "POST", cookie, ...options }), config)).status, 403);
  }
  assert.equal((await worker.fetch(browserRequest("/logout", { method: "POST", omitOrigin: true, form: { csrf } }), config)).status, 303);
});

test("browser sessions cannot authorize model APIs or override explicit invalid credentials", async (t) => {
  const { cookie } = await browserLogin();
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const path of ["/v1/responses", "/v1/chat/completions", "/v1/models", "/unrelated/health", "/d1-init.json"]) {
    const response = await worker.fetch(browserRequest(path, { method: "POST", cookie, form: {} }), env);
    assert.equal(response.status, 401);
  }
  for (const path of ["/init", "/health"]) {
    for (const Authorization of ["Bearer wrong-key", "Basic wrong", "Bearer"]) {
      assert.equal((await worker.fetch(browserRequest(path, { cookie, headers: { Authorization } }), env)).status, 401);
    }
  }
  assert.equal((await worker.fetch(browserRequest("/health?token=wrong", { cookie }), env)).status, 401);
  assert.equal(upstream.mock.callCount(), 0);
});

test("browser init displays controlled DB and Assets errors and permits a retry after configuration is fixed", async () => {
  const db = new TestD1(false);
  const config = { ...env, DB: undefined };
  const { cookie, csrf } = await browserLogin(worker, config);
  for (const options of [{}, { DB: db, ASSETS: { fetch: async () => new Response("missing", { status: 404 }) } }]) {
    const response = await worker.fetch(browserRequest("/init", { method: "POST", cookie, form: { csrf } }), { ...config, ...options });
    assert.equal(response.status, 503);
    const html = await response.text();
    assert.match(html, /初始化未完成/);
    assert.match(html, /action="\/init"/);
    assert.ok(!html.includes(env.PROXY_API_KEY));
  }
  assert.equal(db.batches.length, 0);
  const retry = await worker.fetch(browserRequest("/init", { method: "POST", cookie, form: { csrf } }), { ...config, DB: db });
  assert.equal(retry.status, 200);
  assert.match(await retry.text(), /初始化完成/);
});

test("logout clears the signed browser cookie, requires POST and returns to login", async () => {
  const { cookie, csrf } = await browserLogin();
  assert.equal((await worker.fetch(browserRequest("/logout", { cookie }), env)).status, 405);
  const response = await worker.fetch(browserRequest("/v1/logout", { method: "POST", cookie, form: { csrf } }), env);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "/login");
  assert.match(response.headers.get("Set-Cookie"), /__Host-proxy-admin=;.*Max-Age=0/);
  const cleared = response.headers.get("Set-Cookie").split(";")[0];
  assert.equal((await worker.fetch(browserRequest("/init", { cookie: cleared }), env)).status, 303);
});

for (const scenario of ["missing", "invalid JSON", "outdated", "modified SQL", "fetch failure"]) {
  test(`init rejects ${scenario} Assets without running partial SQL`, async (t) => {
    const db = new TestD1(false);
    const payload = structuredClone(initializerAsset);
    if (scenario === "outdated") payload.schema_version = 999;
    if (scenario === "modified SQL") payload.statements.push("DROP TABLE proxy_stats;");
    const config = { ...dualKeyEnv, DB: db, ASSETS: { async fetch() {
      if (scenario === "fetch failure") throw new Error("Failed " + env.PROXY_API_KEY);
      if (scenario === "missing") return new Response("Not found", { status: 404 });
      if (scenario === "invalid JSON") return new Response("not JSON");
      return Response.json(payload);
    } } };
    const calls = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
    const response = await worker.fetch(request("/init"), config);
    assert.equal(response.status, 503);
    const error = await response.text();
    assert.match(error, /ASSETS|asset/);
    assert.ok(!error.includes(env.PROXY_API_KEY));
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'proxy_%'").get().count, 0);
    assert.equal(calls.mock.callCount(), 0);
  });
}

test("init requires DB and returns a controlled error when D1 is unavailable", async () => {
  for (const db of [undefined, new TestD1(false)]) {
    if (db) db.beforeBatch = () => { throw new Error("Database unavailable"); };
    const response = await worker.fetch(request("/init"), { ...dualKeyEnv, DB: db });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /DB|D1/);
  }
});
