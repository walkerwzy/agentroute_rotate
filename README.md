# AgentRouter Proxy

运行在 Cloudflare Workers 上的 OpenAI 格式代理，支持 Responses / Chat Completions 双向转换、按会话分配两把平台 Key，以及 D1 共享故障冷却、统计和路由日志。客户端使用独立的代理 Key。

本项目通过 Wrangler 在本地管理数据库绑定、Secrets、普通变量、域名、日志和定时任务。接口行为和转换限制见 [worker.README.md](./worker.README.md)。

## 环境要求

- Node.js 24 或更高版本、npm、Python 3.9 或更高版本。
- Cloudflare 账号；Wrangler 固定为 `4.95.0`，由 `package.json` 安装。
- 至少一把 AgentRouter 平台 Key；第二把可选。

```sh
npm install
npx wrangler login
```

`wrangler login` 打开浏览器授权 Cloudflare 账号。自动化环境可改用 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 环境变量；Token 需要目标账号的 Workers Scripts 和 D1 编辑权限，配置自定义域名时还需要对应 Zone 的权限。Cloudflare 登录凭证不写入 Worker Secrets。

首次联网安装会生成 `package-lock.json`，将其一同提交；之后用 `npm ci` 安装锁定的依赖。管理脚本优先使用项目中的 Wrangler，也支持系统已安装的相同固定版本。

## 首次部署

复制配置并编辑本地的 `wrangler.toml`：

```sh
cp wrangler.example.toml wrangler.toml
```

| 配置 | 设置方法 |
| --- | --- |
| `name` | Worker 名称，默认 `codex-proxy`；更新已有 Worker 时使用其现有名称 |
| `account_id` | 多账号时填写目标账号 ID，或设置 `CLOUDFLARE_ACCOUNT_ID` |
| `database_name` | 默认 `codex-proxy-state`；`setup` 创建或复用这个名称的数据库 |
| `database_id` | 新部署保留模板占位符，`setup` 自动填写；已有部署保留原 ID |
| `[vars]` | 配置上游地址、接口模式、冷却秒数和路由日志开关 |
| `routes` / `workers_dev` | 使用自定义域名，或默认的 `workers.dev` 地址 |
| `[observability.logs]` | 启用 Workers Logs，查看请求与路由诊断 |
| `[triggers]` | 默认每天 UTC 00:00 清理 7 天前日志，保留累计统计 |

`[vars]` 中明确配置的值会更新线上同名变量。`keep_vars = true` 保留其余面板变量；已有 Worker 的 Secrets 会保留。已有项目请保留其他必要 bindings 和路由，避免用模板覆盖本地配置。

执行：

```sh
npm run setup
npm run secrets
npm run deploy
```

`setup` 查询当前账号的 D1：同名数据库存在时复用，否则创建，再只更新 `DB` 的 `database_id`。配置中已有真实 ID 时核对名称与账号，保留当前绑定。这个步骤不初始化表。

`secrets` 在终端隐藏输入，保存到权限为 `600` 的 `.secrets.json`。代理 Key 留空会自动生成，平台 Key 至少输入一把；已有本地 Key 留空会保留。生成的代理 Key 可以从 `.secrets.json` 复制到客户端和浏览器登录页。也可以复制 [.secrets.example.json](./.secrets.example.json) 手动填写，删除未使用的平台 Key 字段。

`deploy` 依次检查 SQL 生成结果、运行测试、打包 Worker 与 Assets，再核对 D1 并部署。Secrets 随同一个版本上传，空值省略，临时上传文件在结束后删除。如果没有 `.secrets.json`，脚本核对并沿用线上已有的必要 Secrets。

部署成功后，在浏览器打开部署地址的 **`/init`**，输入 `PROXY_API_KEY` 登录，再点击「初始化数据库」。成功后点击「查看运行状态」，确认 `scope: "d1"`。之后客户端配置：

```text
Base URL: https://你的Worker域名/v1
API Key:  .secrets.json 中的 PROXY_API_KEY
```

初始化资源会随 `assets/` 一起上传；重复初始化会保留已有数据。部署不会自动执行数据库初始化。

## 自定义域名

默认配置启用 `workers.dev`，不需要自有域名。使用自定义域名时，在 `wrangler.toml` 顶层、`[vars]` 之前设置：

```toml
workers_dev = false
routes = [{ pattern = "proxy.example.com", custom_domain = true }]
```

域名所属 Zone 需要已在当前 Cloudflare 账号中激活。Wrangler 部署会配置 Custom Domain 及相关 DNS / 证书；域名注册和将 Zone 接入 Cloudflare 是前置步骤。使用 Worker Route 模式的已有项目应保留其 `routes` 配置。

当前本机 `wrangler.toml` 已保留现有数据库 ID，并配置 `proxy.wzy.one`。该文件不提交到仓库；新环境从模板开始。

## 日常更新与检查

修改代码后：

```sh
npm run check
npm run deploy
```

`check` 和以下部署预演只做本地检查，不查询账号、不创建数据库、不上传 Worker 或 Secrets：

```sh
npm run deploy -- --dry-run
```

模板的数据库占位符也能用于预演；正式部署前需要完成 `setup`。如果本地已有 Secrets 文件，预演会验证其内容，但不会交给 Wrangler 打包。

修改 `worker.d1.sql` 后先同步生成文件，再检查：

```sh
npm run build:d1
npm run check
```

生成器更新 `assets/d1-init.json` 和 `worker.js` 中的内置初始化数据。检查模式不会改写文件。已有数据库的结构变更需要另行设计迁移；当前初始化仅使用 `CREATE ... IF NOT EXISTS`，不会自动升级已有表。

检查线上状态，不会调用模型：

```sh
npm run health -- --url https://你的Worker域名
```

配置了 Custom Domain 时可省略 `--url`。代理 Key 从 `.secrets.json` 读取，也可通过 `PROXY_API_KEY` 环境变量提供；使用 Bearer 头，不写入 URL，遇到重定向会停止。

Secrets 文件中省略某个字段会保留该字段的线上值；删除本地字段不会删除线上 Secret。确需移除第二把平台 Key 时显式执行：

```sh
npx wrangler secret delete UPSTREAM_API_KEY_1 --config wrangler.toml
```

## 本地开发

```sh
npm run dev
```

首次自动从 [.dev.vars.example](./.dev.vars.example) 创建 `.dev.vars`。本地访问 **`https://127.0.0.1:8787/init`**，登录 Key 默认为 `local-test-key`；这是开发服务器自签名证书，需要在浏览器中接受。模型联调时编辑 `.dev.vars` 填写平台 Key。

`dev --local` 使用独立的本地 D1，不使用线上数据库，也不读取 `.secrets.json`。可以在本地浏览器初始化，也可先执行：

```sh
npm run db:init:local
```

如需通过 CLI 初始化线上库，也提供明确的远程命令：

```sh
npm run db:init
```

这两个命令执行同一份 `worker.d1.sql`，分别显式使用 `--local` / `--remote`；远程命令会先核对账号与 D1 绑定。浏览器初始化仍是默认操作流程。

## 文件与仓库

| 文件 | 用途 |
| --- | --- |
| `worker.js` | Worker 入口，包含浏览器管理页面及内置初始化数据 |
| `worker.d1.sql` | D1 初始化 SQL |
| `assets/d1-init.json` | Assets 初始化数据，由生成器同步 |
| `wrangler.example.toml` | 可提交的配置模板 |
| `scripts/manage.mjs` | 本地设置、检查、部署、开发与状态检查命令 |
| `scripts/build-d1-init.py` | 初始化数据生成及一致性检查 |
| `worker.test.mjs`、`scripts/manage.test.mjs` | Worker 回归和部署流程测试 |

`.gitignore` 已排除真实配置、Secrets、`.dev.vars`、`.env`、Wrangler 状态、依赖和导出的会话记录。提交源文件、配置示例、README、`package.json` 及联网安装生成的 `package-lock.json`。测试使用模拟上游和内存 SQLite，不消耗平台额度。
