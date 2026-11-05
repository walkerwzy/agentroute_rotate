import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { copyFile, readFile, writeFile, chmod, access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_NAMES = ["PROXY_API_KEY", "UPSTREAM_API_KEY", "UPSTREAM_API_KEY_1"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const require = createRequire(import.meta.url);

export function installedWrangler() {
  let packagePath;
  try { packagePath = require.resolve("wrangler/package.json"); }
  catch {
    try {
      const globalRoot = execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim();
      packagePath = require.resolve(join(globalRoot, "wrangler/package.json"));
    } catch { throw new Error("请先运行 npm install，安装项目固定版本的 Wrangler。"); }
  }
  const pkg = require(packagePath);
  if (pkg.version !== "4.95.0") throw new Error("需要 Wrangler 4.95.0；请运行 npm install。");
  return { api: require(dirname(packagePath)), cli: join(dirname(packagePath), pkg.bin.wrangler) };
}

export async function runCommand(command, args, { capture = false, cwd = ROOT } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "", stderr = "";
    if (capture) {
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
    }
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolveResult(stdout);
      else {
        // Captured output can contain configuration details; do not echo it on failure.
        reject(new Error(`${command} ${args[0] || ""} 执行失败（${signal || code}）。请单独运行该命令查看原因。`));
      }
    });
  });
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
function parseJSON(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} 不是有效 JSON。`); }
}
export function validateSecrets(value, { required = true } = {}) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Secrets 必须是 JSON 对象。");
  const secrets = {};
  for (const [name, valueOfKey] of Object.entries(value)) {
    if (!SECRET_NAMES.includes(name)) throw new Error("Secrets 文件只能包含代理和平台 API key；Cloudflare 登录凭证使用环境变量。");
    if (typeof valueOfKey !== "string") throw new Error(`${name} 必须是字符串。`);
    const key = valueOfKey.trim();
    if (!key) continue;
    if (/\s/.test(key) || /REPLACE_WITH|YOUR_.*KEY/.test(key)) throw new Error(`${name} 需要填写实际 key，不能包含空白或 Bearer 前缀。`);
    secrets[name] = key;
  }
  if (required && (!secrets.PROXY_API_KEY || !(secrets.UPSTREAM_API_KEY || secrets.UPSTREAM_API_KEY_1))) {
    throw new Error("需要 PROXY_API_KEY 和至少一把平台 key；运行 npm run secrets。");
  }
  return secrets;
}
export function bindDatabase(text, id) {
  if (!UUID.test(id)) throw new Error("Cloudflare 返回的数据库 ID 无效。");
  let count = 0;
  const result = text.split(/(?=^\[)/m).map((section) => {
    if (!/^\[\[d1_databases\]\]/.test(section) || !/^\s*binding\s*=\s*["']DB["']\s*(?:#.*)?$/m.test(section)) return section;
    count++;
    if (!/^\s*database_id\s*=\s*["'][^"']*["']/m.test(section)) throw new Error("DB binding 缺少 database_id。");
    return section.replace(/^(\s*database_id\s*=\s*)["'][^"']*["']/m, `$1"${id}"`);
  }).join("");
  if (count !== 1) throw new Error("配置应包含且仅包含一个顶层 DB binding。");
  return result;
}
export function configuredURL(config, suppliedURL) {
  const customDomain = (config.routes || (config.route ? [config.route] : [])).find((route) => route.custom_domain)?.pattern;
  const value = suppliedURL || (customDomain ? `https://${customDomain}` : null);
  if (!value) throw new Error("请通过 --url https://你的Worker域名 指定地址（workers.dev 地址见部署输出）。");
  let url;
  try { url = new URL(value); } catch { throw new Error("Worker 地址不是有效 URL。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("Worker 地址必须为 HTTPS 来源地址，不能带路径、凭证、查询参数或片段。");
  }
  return url.origin;
}

export function createManager({ root = ROOT, api, wrangler, run = runCommand, log = console.log, fetcher = fetch } = {}) {
  const configPath = join(root, "wrangler.toml");
  const secretsPath = join(root, ".secrets.json");
  const command = (args, options = {}) => wrangler([...args, "--config", configPath], { cwd: root, ...options });
  const config = async () => {
    if (!await exists(configPath)) throw new Error("缺少 wrangler.toml；先复制 wrangler.example.toml 或运行 npm run setup。");
    const value = api.unstable_readConfig({ config: configPath });
    if (SECRET_NAMES.some((name) => Object.hasOwn(value.vars, name))) throw new Error("API key 应放在 .secrets.json，不能写入 [vars]。");
    const databases = value.d1_databases.filter((db) => db.binding === "DB");
    if (!value.name || databases.length !== 1) throw new Error("配置需要 Worker name 和一个 DB binding。");
    if (value.assets?.binding !== "ASSETS" || value.assets?.run_worker_first !== true) throw new Error("Assets 需要绑定 ASSETS 并设置 run_worker_first = true。");
    return { value, db: databases[0] };
  };
  const readSecrets = async (required = true) => {
    if (!await exists(secretsPath)) return null;
    return validateSecrets(parseJSON(await readFile(secretsPath, "utf8"), "Secrets 文件"), { required });
  };
  const remoteDatabases = async () => {
    const result = parseJSON(await command(["d1", "list", "--json"], { capture: true }), "D1 数据库列表");
    if (!Array.isArray(result)) throw new Error("D1 数据库列表格式异常。");
    return result;
  };
  const validateRemoteDB = async (db) => {
    const databases = await remoteDatabases();
    if (!databases.some((item) => item.uuid === db.database_id && item.name === db.database_name)) {
      throw new Error("配置的 D1 名称或 ID 不属于当前账号；请检查 Cloudflare 账号和 wrangler.toml。");
    }
  };
  return {
    async setup() {
      if (!await exists(configPath)) await copyFile(join(root, "wrangler.example.toml"), configPath, constants.COPYFILE_EXCL);
      const { db } = await config();
      if (UUID.test(db.database_id)) {
        await validateRemoteDB(db);
        log("已有 D1 binding 已核对，保留当前数据库和配置。");
        return;
      }
      if (db.database_id !== "REPLACE_WITH_YOUR_D1_DATABASE_ID") throw new Error("database_id 不是 UUID 或模板占位符。");
      let databases = await remoteDatabases();
      let database = databases.find((item) => item.name === db.database_name);
      if (!database) {
        await command(["d1", "create", db.database_name, "--update-config=false"]);
        databases = await remoteDatabases();
        database = databases.find((item) => item.name === db.database_name);
      }
      if (!database) throw new Error("未找到新建的 D1；请重试 npm run setup。");
      const text = await readFile(configPath, "utf8");
      await writeFile(configPath, bindDatabase(text, database.uuid));
      log(`D1 ${db.database_name} 已绑定为 DB。下一步运行 npm run secrets。`);
    },
    async secrets(ask) {
      const previous = await readSecrets(false) || {};
      const proxy = (await ask(previous.PROXY_API_KEY ? "代理 Key（回车保留）：" : "代理 Key（回车自动生成）：")).trim();
      const primary = (await ask(previous.UPSTREAM_API_KEY ? "平台 Key 1（回车保留）：" : "平台 Key 1：")).trim();
      const backup = (await ask(previous.UPSTREAM_API_KEY_1 ? "平台 Key 2（回车保留）：" : "平台 Key 2（可选）：")).trim();
      const secrets = validateSecrets({
        PROXY_API_KEY: proxy || previous.PROXY_API_KEY || randomBytes(32).toString("hex"),
        UPSTREAM_API_KEY: primary || previous.UPSTREAM_API_KEY || "",
        UPSTREAM_API_KEY_1: backup || previous.UPSTREAM_API_KEY_1 || ""
      });
      await writeFile(secretsPath, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
      await chmod(secretsPath, 0o600);
      log("Secrets 已保存到 .secrets.json（权限 600）；代理 Key 可从该文件复制到客户端或浏览器登录页。尚未上传。");
    },
    async check() {
      await config();
      await readSecrets();
      await run("python3", [join(root, "scripts/build-d1-init.py"), "--check"], { cwd: root });
      await run(process.execPath, ["--test", "worker.test.mjs", "scripts/manage.test.mjs"], { cwd: root });
      await command(["deploy", "--dry-run", "--outdir", join(root, ".wrangler/build")]);
      log("本地 SQL、测试和 Worker/Assets 打包检查通过，未上传。只有 setup 会自动写入数据库 ID。");
    },
    async deploy({ dryRun = false } = {}) {
      await this.check();
      if (dryRun) return;
      const { db, value } = await config();
      if (!UUID.test(db.database_id)) throw new Error("部署前先运行 npm run setup 完成 D1 binding。");
      await validateRemoteDB(db);
      const secrets = await readSecrets();
      if (!secrets) {
        const existing = parseJSON(await command(["secret", "list", "--format", "json"], { capture: true }), "Cloudflare Secrets 列表");
        const names = existing.map((item) => item.name);
        if (!names.includes("PROXY_API_KEY") || !names.some((name) => name === "UPSTREAM_API_KEY" || name === "UPSTREAM_API_KEY_1")) {
          throw new Error("Cloudflare 缺少必要 Secrets；运行 npm run secrets 后重试。");
        }
      }
      // Upload secrets with the version, avoiding an intermediate deployment with missing credentials.
      if (secrets) {
        const directory = await mkdtemp(join(tmpdir(), "agentrouter-secrets-"));
        try {
          const uploadPath = join(directory, "secrets.json");
          await writeFile(uploadPath, JSON.stringify(secrets), { mode: 0o600 });
          await command(["deploy", "--secrets-file", uploadPath]);
        } finally { await rm(directory, { recursive: true, force: true }); }
      } else await command(["deploy"]);
      const customDomain = (value.routes || []).find((route) => route.custom_domain)?.pattern;
      log(customDomain ? `部署完成。在浏览器打开 https://${customDomain}/init 登录并初始化。` : "部署完成。使用部署输出中的 workers.dev 地址，打开 /init 登录并初始化。");
    },
    async dev() {
      await config();
      const devVars = join(root, ".dev.vars");
      if (!await exists(devVars)) {
        await copyFile(join(root, ".dev.vars.example"), devVars, constants.COPYFILE_EXCL);
        await chmod(devVars, 0o600);
        log("已创建 .dev.vars，默认登录 Key 为 local-test-key；模型联调时填写平台 Key。");
      }
      await command(["dev", "--local", "--local-protocol", "https", "--ip", "127.0.0.1", "--port", "8787"]);
    },
    async initialize(local = false) {
      const { db } = await config();
      await run("python3", [join(root, "scripts/build-d1-init.py"), "--check"], { cwd: root });
      if (!local) {
        if (!UUID.test(db.database_id)) throw new Error("先运行 npm run setup。");
        await validateRemoteDB(db);
      }
      await command(["d1", "execute", "DB", local ? "--local" : "--remote", "--file", join(root, "worker.d1.sql")]);
      log(`${local ? "本地" : "线上"}数据库已初始化，已有统计和冷却数据保留。`);
    },
    async health(url) {
      const { value } = await config();
      const origin = configuredURL(value, url);
      const secrets = await readSecrets(false);
      const key = process.env.PROXY_API_KEY || secrets?.PROXY_API_KEY;
      if (!key) throw new Error("需要 .secrets.json 中的代理 Key，或通过 PROXY_API_KEY 环境变量提供。");
      const response = await fetcher(origin + "/health", { headers: { Authorization: `Bearer ${key}` }, redirect: "manual", signal: AbortSignal.timeout(15000) });
      if (response.status >= 300 && response.status < 400) throw new Error("health 返回重定向，请核对 Worker 地址。");
      let data;
      try { data = await response.json(); } catch { throw new Error(`health 返回非 JSON（HTTP ${response.status}）。`); }
      let output = JSON.stringify(data, null, 2);
      for (const secret of Object.values(secrets || {}).concat(key)) output = output.split(secret).join("[redacted]");
      log(output);
      if (!response.ok) throw new Error(`health 检查返回 HTTP ${response.status}。`);
    }
  };
}

async function askSecrets(manager) {
  if (!process.stdin.isTTY) throw new Error("交互输入需要终端；自动化时创建 .secrets.json 后运行 npm run deploy。");
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    await manager.secrets(async (prompt) => {
      process.stdout.write(prompt);
      const answer = await input.question("");
      process.stdout.write("\n");
      return answer;
    });
  } finally { input.close(); }
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!["setup", "secrets", "check", "deploy", "dev", "db:init", "db:init:local", "health"].includes(action)) {
    console.log("用法：npm run setup|secrets|check|deploy|dev|db:init|db:init:local|health\n部署检查：npm run deploy -- --dry-run\n状态检查：npm run health -- --url https://你的Worker域名");
    process.exitCode = action ? 1 : 0;
    return;
  }
  if (args.length && !(action === "deploy" && args.length === 1 && args[0] === "--dry-run") &&
      !(action === "health" && args.length === 2 && args[0] === "--url")) throw new Error("命令参数不支持；运行 node scripts/manage.mjs 查看用法。");
  const { api, cli } = installedWrangler();
  const manager = createManager({ api, wrangler: (args, options) => runCommand(process.execPath, [cli, ...args], options) });
  if (action === "secrets") await askSecrets(manager);
  else if (action === "deploy") await manager.deploy({ dryRun: args.includes("--dry-run") });
  else if (action === "db:init" || action === "db:init:local") await manager.initialize(action.endsWith(":local"));
  else if (action === "health") await manager.health(args[1]);
  else await manager[action]();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
