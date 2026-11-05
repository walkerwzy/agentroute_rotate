import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, copyFile, rm, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManager, installedWrangler, validateSecrets, configuredURL } from "./manage.mjs";

const { api } = installedWrangler();
const template = await readFile(new URL("../wrangler.example.toml", import.meta.url), "utf8");
const DB_ID = "12345678-1234-1234-1234-123456789abc";
const DB = { uuid: DB_ID, name: "codex-proxy-state" };
const SECRET = { PROXY_API_KEY: "proxy-test-key", UPSTREAM_API_KEY: "platform-test-key" };
async function fixture(t, { bound = false, handler, config = template } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentrouter-manage-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "wrangler.example.toml"), config);
  if (bound) await writeFile(join(root, "wrangler.toml"), config.replace("REPLACE_WITH_YOUR_D1_DATABASE_ID", DB_ID));
  else await copyFile(join(root, "wrangler.example.toml"), join(root, "wrangler.toml"));
  const calls = [], local = [], output = [];
  const manager = createManager({ root, api, log: (text) => output.push(text),
    run: async (...args) => { local.push(args); },
    wrangler: async (args, options) => {
      calls.push({ args, options });
      if (handler) return handler(args, options);
      if (args[0] === "d1" && args[1] === "list") return JSON.stringify([DB]);
      if (args[0] === "secret") return JSON.stringify(Object.keys(SECRET).map((name) => ({ name })));
      return "";
    }
  });
  return { root, manager, calls, local, output };
}

test("setup reuses a matching D1 and preserves routes, ordinary variables and comments", async (t) => {
  const config = template.replace("workers_dev = true", 'workers_dev = false\nroutes = [{ pattern = "proxy.example.com", custom_domain = true }]');
  const { root, manager, calls } = await fixture(t, { config });
  await manager.setup();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ["d1", "list", "--json"]);
  assert.equal(await readFile(join(root, "wrangler.toml"), "utf8"), config.replace("REPLACE_WITH_YOUR_D1_DATABASE_ID", DB_ID));
  await manager.setup();
  assert.equal(calls.length, 2);
});

test("setup creates a missing D1 without Wrangler appending duplicate bindings", async (t) => {
  let lists = 0;
  const { root, manager, calls } = await fixture(t, { handler: async (args) => {
    if (args[1] === "list") return JSON.stringify(++lists === 1 ? [] : [DB]);
    return "";
  } });
  await manager.setup();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].args.slice(0, 4), ["d1", "create", DB.name, "--update-config=false"]);
  const text = await readFile(join(root, "wrangler.toml"), "utf8");
  assert.equal(text.match(/\[\[d1_databases\]\]/g).length, 1);
  assert.ok(text.includes(DB_ID));
});

test("setup rejects a wrong account without replacing a configured D1 or creating another database", async (t) => {
  const { root, manager, calls } = await fixture(t, { bound: true, handler: async () => "[]" });
  const before = await readFile(join(root, "wrangler.toml"), "utf8");
  await assert.rejects(manager.setup(), /当前账号/);
  assert.equal(calls.length, 1);
  assert.equal(await readFile(join(root, "wrangler.toml"), "utf8"), before);
});

test("deployment dry run is entirely local and does not supply secrets to Wrangler", async (t) => {
  const { manager, root, calls, local } = await fixture(t);
  await writeFile(join(root, ".secrets.json"), JSON.stringify(SECRET));
  await manager.deploy({ dryRun: true });
  assert.equal(local.length, 2);
  assert.equal(local[0][0], "python3");
  assert.equal(local[0][1].at(-1), "--check");
  assert.ok(local[1][1].includes("--test"));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("--dry-run"));
  assert.ok(!calls[0].args.includes("--secrets-file"));
});

test("deployment uploads normalized secrets with the version and removes its temporary file on failure", async (t) => {
  let uploadedPath;
  const { root, manager, calls } = await fixture(t, { bound: true, handler: async (args) => {
    if (args[0] === "d1") return JSON.stringify([DB]);
    if (args.includes("--secrets-file")) {
      uploadedPath = args[args.indexOf("--secrets-file") + 1];
      assert.deepEqual(JSON.parse(await readFile(uploadedPath, "utf8")), SECRET);
      assert.equal((await stat(uploadedPath)).mode & 0o777, 0o600);
      throw new Error("simulated deployment failure");
    }
    return "";
  } });
  await writeFile(join(root, ".secrets.json"), JSON.stringify({ ...SECRET, UPSTREAM_API_KEY_1: "" }));
  await assert.rejects(manager.deploy(), /simulated deployment failure/);
  assert.ok(uploadedPath);
  await assert.rejects(access(uploadedPath));
  assert.ok(!calls.some((call) => call.args.includes("bulk")));
});

test("deployment without local credentials preserves existing Cloudflare Secrets", async (t) => {
  const { manager, calls } = await fixture(t, { bound: true });
  await manager.deploy();
  assert.ok(calls.some((call) => call.args[0] === "secret" && call.args[1] === "list"));
  assert.deepEqual(calls.at(-1).args.slice(0, -2), ["deploy"]);
});

test("missing Cloudflare Secrets or a placeholder DB stops the upload", async (t) => {
  const first = await fixture(t, { bound: true, handler: async (args) => args[0] === "d1" ? JSON.stringify([DB]) : "[]" });
  await assert.rejects(first.manager.deploy(), /缺少必要 Secrets/);
  assert.ok(!first.calls.some((call) => call.args[0] === "deploy" && !call.args.includes("--dry-run")));
  const second = await fixture(t);
  await assert.rejects(second.manager.deploy(), /npm run setup/);
  assert.equal(second.calls.length, 1);
});

test("initialization explicitly separates local and remote databases and verifies the remote account", async (t) => {
  const { manager, calls } = await fixture(t, { bound: true });
  await manager.initialize(true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("--local"));
  assert.ok(!calls[0].args.includes("--remote"));
  await manager.initialize(false);
  assert.equal(calls[1].args[1], "list");
  assert.ok(calls[2].args.includes("--remote"));
  assert.ok(!calls[2].args.includes("--local"));
});

test("interactive Secrets preserve existing credentials, save privately and never echo keys", async (t) => {
  const { manager, root, output } = await fixture(t);
  await writeFile(join(root, ".secrets.json"), JSON.stringify(SECRET));
  await manager.secrets(async () => "");
  assert.deepEqual(JSON.parse(await readFile(join(root, ".secrets.json"), "utf8")), SECRET);
  assert.equal((await stat(join(root, ".secrets.json"))).mode & 0o777, 0o600);
  for (const key of Object.values(SECRET)) assert.ok(!output.join("\n").includes(key));
  assert.throws(() => validateSecrets({ ...SECRET, CLOUDFLARE_API_TOKEN: "not-a-worker-secret" }), /Cloudflare/);
  assert.throws(() => validateSecrets({ ...SECRET, PROXY_API_KEY: "Bearer bad" }), /空白/);
  assert.throws(() => validateSecrets({ ...SECRET, UPSTREAM_API_KEY: "REPLACE_WITH_YOUR_PLATFORM_KEY" }), /实际 key/);
});

test("health rejects unsafe origins and redirects, uses a header and redacts returned credentials", async (t) => {
  for (const url of ["http://proxy.example", "https://key@proxy.example", "https://proxy.example/path", "https://proxy.example?token=secret"]) {
    assert.throws(() => configuredURL({}, url), /HTTPS/);
  }
  const { root } = await fixture(t);
  await writeFile(join(root, ".secrets.json"), JSON.stringify(SECRET));
  const output = [];
  const manager = createManager({ root, api, log: (text) => output.push(text), fetcher: async (url, options) => {
    assert.equal(url, "https://proxy.example/health");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, "Bearer " + SECRET.PROXY_API_KEY);
    return Response.json({ status: "ok", diagnostic: SECRET.PROXY_API_KEY });
  } });
  await manager.health("https://proxy.example");
  assert.ok(!output.join("\n").includes(SECRET.PROXY_API_KEY));
  const redirecting = createManager({ root, api, fetcher: async () => new Response(null, { status: 302 }) });
  await assert.rejects(redirecting.health("https://proxy.example"), /重定向/);
});
