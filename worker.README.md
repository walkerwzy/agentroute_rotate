# AgentRouter Worker：D1 状态与会话分流

`worker.js` 为 Responses 和 Chat Completions 客户端提供统一鉴权、会话分流与双向格式适配。稳定会话标识决定首选 key，Cloudflare D1 共享 key 故障冷却、调用统计和路由日志。默认优先使用客户端请求的上游接口；上游明确拒绝该接口时，切换接口并转换请求和返回结果。浏览器管理使用 `/login`、`/init` 和 `/logout`，其他路径透传到上游。

## 配置

通过本地 Wrangler 脚本管理 D1、Secrets、域名和部署，见 [仓库 README](./README.md)。下方保留 Dashboard 操作与接口配置说明。

先创建并绑定 D1、配置 Secrets、部署 `worker.js`，再在浏览器中登录并打开 `/init` 初始化。

| 名称 | 类型 | 值与用途 |
| --- | --- | --- |
| `DB` | D1 binding，必填 | 绑定数据库 `codex-proxy-state`；不是普通环境变量 |
| `ASSETS` | Workers Assets binding，可选 | 从 `assets/d1-init.json` 读取初始化数据；未配置时使用脚本内置的相同数据 |
| `PROXY_API_KEY` | Secret，必填 | 自定义客户端 key，例如自行生成的随机字符串；客户端只配置这个 key |
| `UPSTREAM_API_KEY` | Secret | 第一个 AgentRouter 平台 key；保留原配置名称 |
| `UPSTREAM_API_KEY_1` | Secret | 第二个平台 key；配置两个 key 后按稳定会话标识分配，明确的 key 错误可重试另一把 |
| `UPSTREAM_BASE` | 普通环境变量，可选 | 默认 `https://agentrouter.org/v1`；配置其他地址时须包含 API 路径并使用 HTTPS，可带尾斜杠 |
| `UPSTREAM_API` | 普通环境变量，可选 | `auto`（默认）、`responses` 或 `chat`；使用仅支持 Responses 的模型时建议配置为 `responses` |
| `KEY_COOLDOWN_SECONDS` | 普通环境变量，可选 | 默认 `300` 秒；允许 `1`–`86400` 的整数。上游有效的 `Retry-After` 优先 |
| `ROUTING_LOGS` | 普通环境变量，可选 | 默认输出路由诊断日志；设为 `off`、`false` 或 `0` 关闭控制台输出，D1 和 `/health` 仍保留日志 |

至少配置一个平台 key；要启用两个 key 的会话分流，同时配置 `UPSTREAM_API_KEY` 和 `UPSTREAM_API_KEY_1`。自定义客户端 key 与平台 key 分开，填写原始 key，不包含 `Bearer ` 前缀。不要将真实 key 写入脚本。
key 中不能包含空白字符，否则 Worker 返回配置错误。

### D1 创建、绑定、部署、初始化

1. 在 Cloudflare 控制台的 **Storage & databases → D1** 创建数据库，名称建议为 **`codex-proxy-state`**。
2. 打开现有 **`codex-proxy` Worker → Bindings → Add binding → D1 database**，变量名填 **`DB`**，选择刚创建的数据库。测试环境和生产环境需要各自绑定到预期数据库。
3. 在 Worker 的 **Settings → Variables and Secrets** 配置上表变量，将 [`worker.js`](./worker.js) 部署到现有 Worker。
4. 在浏览器打开 **`https://proxy.wzy.one/init`**，未登录时自动进入登录页。输入 **`PROXY_API_KEY`** 的值，点击「登录」，成功后返回 `/init`，点击「初始化数据库」。出现「初始化完成」即已建立 **4 张表、4 个触发器和索引**。重复初始化会保留已有冷却、日志和统计，无需插入 API key 或初始轮换序号。
5. 点击「查看运行状态」，或在同一浏览器打开 **`https://proxy.wzy.one/health`**，确认 `scope` 为 **`d1`**、`storage.binding` 为 **`DB`**。同一数据库上的不同实例会看到同一份统计和冷却状态。

### 浏览器登录与初始化

也可以先打开 **`https://proxy.wzy.one/login`** 登录，再进入 `/init`。此流程不需要终端命令，也不需要把 key 放在地址栏中。登录和打开初始化页面不依赖已初始化的数据库；页面访问不会执行 SQL，点击初始化按钮才会执行。

登录成功后设置有效期 **1 小时**的签名 Cookie，带 `HttpOnly`、`Secure`、`SameSite=Strict` 和 `__Host-` 前缀，使用 HTTPS 访问。Cookie 不包含原始 key，Worker 的不同实例都能验证；更换 `PROXY_API_KEY` 后需重新登录。初始化页的「退出登录」按钮清除当前浏览器的登录 Cookie。

初始化和退出登录的表单使用与登录会话绑定的 CSRF token，并校验请求来源：`Origin` 缺失或为字面量 `null` 时以 `Sec-Fetch-Site` 和 CSRF token 为准，其余情况 `Origin` 必须与请求同源，`Sec-Fetch-Site` 为 `cross-site` 或 `same-site` 时一律拒绝。Safari 27 在 macOS 的同源表单 POST 上发送的正是 `Origin: null`（`Sec-Fetch-Site: same-origin`），因此这两者必须一起判断。登录表单同样使用这套校验，浏览器登录状态仅用于管理页面和只读 `/health`，模型 API 仍使用 Bearer key。

`/v1/login`、`/v1/init`、`/v1/logout` 也支持，页面表单统一提交到不带 `/v1` 的路径。初始化失败时页面显示原因，可修正数据库绑定或资源配置后再次点击按钮。初始化操作不请求上游，也不增加模型调用统计。

来源校验或 CSRF 校验失败时返回 **403**，页面上会写明是哪一项没通过：来源校验会附带本次请求的 `Origin`、`Sec-Fetch-Site`、`User-Agent` 与 Worker 侧计算出的来源，便于判断是浏览器还是中间代理改写了请求头；令牌不匹配则提示重新登录。

Dashboard 直接粘贴 `worker.js` 部署时，内置数据即可完成初始化；使用 Assets 部署时，读取下方的初始化资源。触发器定义作为完整语句执行。

如需自动化，仍支持 Bearer 鉴权的 `POST /init`，返回 JSON：

```sh
curl -X POST 'https://proxy.wzy.one/init' \
  -H 'Authorization: Bearer 你的代理key'
```

成功返回：

```json
{"status":"initialized","scope":"d1","schema_version":1,"source":"embedded","tables":4,"triggers":4}
```

初始化不接受 query token，也不执行客户端提交的 SQL。

### 用 Workers Assets 存放初始化数据

[`assets/d1-init.json`](./assets/d1-init.json) 由 `worker.d1.sql` 生成，保存完整的 SQL 语句数组。示例 Wrangler 配置包含：

```toml
[assets]
directory = "assets"
binding = "ASSETS"
run_worker_first = true
```

部署时 Wrangler 会上传 `assets/`，`POST /init` 从 `env.ASSETS` 读取 `/d1-init.json`，成功响应的 `source` 为 `assets`。`run_worker_first` 确保 API 请求先进入 Worker 的鉴权逻辑。配置了 ASSETS 时，缺失、损坏或与脚本版本不一致的初始化文件返回 `503`，请一起部署脚本和资源文件。

修改初始化 SQL 后，用 `python3 scripts/build-d1-init.py` 同步更新 Assets 文件和 Worker 内置数据。

如果使用项目部署脚本，从本目录执行（完整设置见 [README](./README.md)）：

```sh
npm install
npx wrangler login
# 已有 wrangler.toml 时保留该文件；新环境从模板复制后编辑。
npm run setup
npm run secrets
npm run deploy
# 然后在浏览器中登录并打开 /init 初始化。
```

也保留整份 SQL 文件的 Wrangler 初始化方式：`wrangler d1 execute codex-proxy-state --remote --file=./worker.d1.sql`。`--remote` 操作 Cloudflare 数据库，不加时通常操作本地开发数据库。示例配置见 [`wrangler.example.toml`](./wrangler.example.toml)，使用 Dashboard 部署时不需要这个配置文件。

建议在 Worker 的 Cron Triggers 添加 **`0 0 * * *`**（每天 UTC 00:00，北京时间 08:00）。脚本的 `scheduled` 处理器删除超过 7 天的请求和调用日志，保留累计统计；示例 Wrangler 配置已包含该定时任务。仅绑定 D1 不会自动启用 Cron，未配置时历史记录会持续保留。

缺少 `DB`、数据库未初始化或 D1 无法访问时，业务请求返回带原因的 **`503`**，不调用上游；绑定 DB 后可在浏览器登录并打开 `/init` 创建表。API key 仍只保存在 Workers Secrets；D1 保存凭证 SHA-256 摘要、计数、冷却期限和脱敏诊断。

如果使用 Wrangler，可以在已创建的 Worker 上交互式设置 secrets，替换命令中的 Worker 名称：

```sh
wrangler secret put PROXY_API_KEY --name YOUR_WORKER_NAME
wrangler secret put UPSTREAM_API_KEY --name YOUR_WORKER_NAME
wrangler secret put UPSTREAM_API_KEY_1 --name YOUR_WORKER_NAME
```

部署到 `proxy.wzy.one` 后，Codex 和 Qwen 的 OpenAI API base URL 都配置为 **`https://proxy.wzy.one/v1`**，API key 配置为 `PROXY_API_KEY` 的值。Worker 同时兼容不带 `/v1` 的端点路径，推荐客户端统一带上 `/v1`。请求示例：

```sh
curl 'https://proxy.wzy.one/v1/responses' \
  -H 'Authorization: Bearer 你的自定义key' \
  -H 'Content-Type: application/json' \
  -H 'X-Session-ID: conversation-123' \
  -d '{"model":"你在AgentRouter使用的模型名","input":"你好","stream":false}'
```

Worker 先验证客户端 `Authorization: Bearer <PROXY_API_KEY>`，通过后使用选中的平台 key 请求上游。Responses、Chat Completions 和其他透传接口仅接受这一鉴权方式。只读 `/health` 还支持浏览器登录 Cookie，并保留 query 参数 `token=<PROXY_API_KEY>`。Bearer 或 query token 优先于 Cookie，明确提交错误凭证时返回 `401`。`OPTIONS` 预检不要求 key，也不会请求平台。

缺失 `PROXY_API_KEY` 或业务请求没有可用的平台 key 时返回 `500`；缺失或错误的客户端 key 返回 `401`。上游地址格式错误返回 `500`，上游重定向或网络失败返回 `502`。不会自动跟随上游重定向。

## 按会话分配 key

脚本固定读取 `UPSTREAM_API_KEY` 和 `UPSTREAM_API_KEY_1`。配置两把 key 时，将稳定会话标识做 SHA-256，再按哈希值的奇偶选择 key：

```text
SHA-256(会话标识) % 2 = 0 → UPSTREAM_API_KEY
SHA-256(会话标识) % 2 = 1 → UPSTREAM_API_KEY_1
```

相同标识始终对应同一把**首选 key**；追加对话、并发请求或更换 Worker isolate 都不改变哈希结果。计算不依赖实例内存，也不再按每 50 次调用切换。首选 key 在冷却时，实际调用暂时使用另一把可用 key；到期后恢复首选分配。不同会话可以分配到两把 key，但请求次数不保证严格各占一半。

会话标识按以下顺序读取，使用第一个非空字符串，计算前去除首尾空白：

| 优先级 | 来源 |
| --- | --- |
| 1 | 请求头 `X-Session-ID` |
| 2 | 请求头 `session_id` |
| 3 | 请求头 `X-Conversation-ID` |
| 4 | 请求头 `conversation_id` |
| 5 | 请求头 `X-Codex-Turn-Metadata` 的 JSON 字段 `thread_id` 或 `threadId` |
| 6 | 请求头 `thread-id`、`thread_id`、`session-id`，依次检查 |
| 7 | 请求体 `metadata.session_id`、`metadata.sessionId`、`metadata.conversation_id`、`metadata.conversationId`，依次检查 |
| 8 | 请求体 `prompt_cache_key` |

`X-Codex-Turn-Metadata` 只读取线程标识；每轮变化的 `turnId`、`callId` 不参与哈希。无效 JSON、空值和非字符串标识会被跳过。原始请求头和原生请求体继续按已有规则转发，路由不会重写 `prompt_cache_key` 或对话内容。

客户端可以在创建会话时生成一个 ID，在该会话的每轮请求里发送相同的 `X-Session-ID`。不要用每轮变化的请求 ID、`previous_response_id` 或不断增长的完整历史作为固定会话标识。

**没有识别到会话标识时，首选第一把已配置的 key：优先 `UPSTREAM_API_KEY`，未配置时使用 `UPSTREAM_API_KEY_1`。** 这种请求仍能正常代理，但不会自动按会话分流。共享冷却仍然生效；日志中的 `source: "default"` 可以帮助发现缺失标识。

会话固定分配有助于减少跨账户切换造成的缓存补算。实际 prompt 缓存命中仍取决于上游缓存范围、保留时间、路由和相同输入前缀，可以通过客户端返回的 `cached_tokens` 观察。

### Codex、Qwen 与其他客户端

用户提供的生产日志已确认 Codex TUI **0.166.0** 发送 `thread-id`、`session-id`、`x-codex-turn-metadata.thread_id`，请求体还包含 `prompt_cache_key`。日志实际选中 `x-codex-turn-metadata.thread_id`。两条日志的线程标识不同，均哈希到第二把 key，不能据此判断轮换失败或多轮稳定性；同一线程的连续日志才可用于检查稳定性。

本机 Qwen 源码中，通用 OpenAI provider 默认仅设置 `User-Agent`，没有自动附带固定会话 ID；DashScope 请求分支会添加 `metadata.sessionId`，其中 `promptId` 会随请求变化。具体选中哪个 provider、是否配置自定义请求头或额外请求体，会影响实际发送字段。

客户端字段无法穷尽。已有通用 `X-Session-ID` 入口，并通过日志保留请求字段名，便于识别其他客户端的会话字段。没有明确稳定标识时使用默认 key，避免把每轮变化的字段误当作会话 ID。

### 错误时换 key 重试与共享冷却

识别到下面的上游 HTTP 错误，会先在 D1 写入该凭证的冷却状态，再尝试另一把值不同且不在冷却中的 key：

| 上游错误 | 行为 |
| --- | --- |
| HTTP `401`、`429` | 换 key 重试，分别视为平台鉴权失败和限流 |
| HTTP `400`、`402`、`403`，且错误码或消息明确表示限额、余额不足或 key 失效 | 换 key 重试 |
| 其他错误，包括参数错误、上下文过长、模型不存在、普通权限错误、HTTP `5xx` 和网络失败 | 返回错误，计一次调用 |

识别的错误码包括 `rate_limit_exceeded`、`insufficient_quota`、`insufficient_user_quota`、`insufficient_token_quota`、`quota_exceeded`、`billing_hard_limit_reached`、`invalid_api_key`、`api_key_expired` 等；检查 JSON 的 `error.code`、`error.type`、顶层 `code` 和 `type`。也识别明确的中英文错误消息，如“额度不足”“令牌已过期”和 `insufficient balance`。完整白名单位于 `worker.js` 的 `KEY_FAILOVER_CODES`。

换 key 后，同一客户端请求里的 `auto` 接口切换继续使用替换后的 key。**后续请求由任何实例处理，都会避开仍在冷却的 key**。冷却默认 300 秒，可配置 `KEY_COOLDOWN_SECONDS`；上游有效的 `Retry-After` 秒数或 HTTP 日期优先，`0` 表示允许立即再次尝试。

冷却结束后，下一次相关请求重新尝试首选 key，没有后台主动探测或永久禁用。若仍失败，会再次冷却。恢复首选账户时，冷却期间新增的上下文仍可能需要补算，缓存命中由上游决定。

key 选择、冷却检查、调用预留和计数在同一个 D1 原子批次中完成；读状态从主库开始，避免读副本的旧冷却数据。冷却按凭证摘要保存，更换 Secret 会使用新状态；旧恢复阶段的迟到失败不会重新阻断已进入下一恢复阶段的 key。

每个客户端请求最多因错误换 key 一次。另一把 key 也失败时返回它的错误；另一把在并发期间已被冷却时，保留本次原上游错误。两把都在冷却时，新业务请求直接返回 `429` 和 `Retry-After`，不预留调用、不请求上游。`auto` 最多另外切换一次接口，合计最多三次上游调用。只有一把 key 或两项配置值相同时不换 key；相同凭证共享冷却和统计，health 用 `duplicate_of` 标记重复项，统计不能重复相加。

自动重试支持原生生成接口、双向格式转换、建立 SSE 连接前的 HTTP 错误和无请求体的透传接口。HTTP `200` 中的 JSON 错误或已建立 SSE 流中的失败不会重放；明确的额度或凭证错误仍会写入共享冷却。multipart 等不可重放的上传不重试，但其 key 故障也会影响后续请求。客户端取消后不再重试。两把 key 共用账户额度或平台整体限流时，换 key 也可能失败。

## /health 与路由诊断日志

`/health` 检查 D1 与 key 配置、查看跨实例统计和冷却状态、预览指定会话的首选与实际 key。

在浏览器中先通过 `/login` 登录，再访问：

```text
https://proxy.wzy.one/health
```

也支持 Bearer 鉴权和旧的 `/health?token=你的自定义key`。`GET /health` 和 `GET /v1/health` 等价，支持 HEAD，带 `Cache-Control: no-store`，不请求平台、不增加调用次数或路由日志。没有平台 key 时返回 `503`。使用 query token 时，特殊字符需要 URL 编码。

### 查看指定会话会选哪把 key

`/health` 支持额外的 `session_id` 或 `prompt_cache_key` 查询参数，例如：

```text
https://proxy.wzy.one/health?session_id=conversation-123
```

`routing.preferred_key` 是哈希决定的首选 key，`routing.selected_key` 是考虑当前冷却后可使用的 key；全部冷却时后者为 `null`。也可以在 health 请求里携带业务请求相同的会话请求头。查询参数仅用于 health 预览，业务接口仍按请求头或请求体读取标识。

填写实际的标识值，日志中的 `session_fingerprint` 是摘要，不能拿它代替原标识进行预览。未提供标识时，`routing.source` 为 `default`，显示默认 key；它不是全局“当前 key”，也不是最近一条业务请求的选择。

两个 key 配置完成后，初始输出类似：

```json
{
  "status": "ok",
  "scope": "d1",
  "storage": { "binding": "DB", "schema_version": 1 },
  "instance": {
    "id": "6f7abe95-345a-43b2-9e23-018fe3d49b10",
    "started_at": "2026-11-04T00:00:00.000Z"
  },
  "routing": {
    "mode": "session_hash",
    "source": "default",
    "preferred_key": "UPSTREAM_API_KEY",
    "selected_key": "UPSTREAM_API_KEY"
  },
  "routing_stats": {
    "session_requests": 0,
    "default_requests": 0
  },
  "routing_logs": [],
  "keys": [
    {
      "name": "UPSTREAM_API_KEY",
      "key_configured": true,
      "calls": 0,
      "success_calls": 0,
      "error_calls": 0,
      "last_error": null,
      "in_flight": 0,
      "unknown_calls": 0,
      "available": true,
      "cooldown_until": null,
      "cooldown_reason": null,
      "retry_after_seconds": 0
    },
    {
      "name": "UPSTREAM_API_KEY_1",
      "key_configured": true,
      "calls": 0,
      "success_calls": 0,
      "error_calls": 0,
      "last_error": null,
      "in_flight": 0,
      "unknown_calls": 0,
      "available": true,
      "cooldown_until": null,
      "cooldown_reason": null,
      "retry_after_seconds": 0
    }
  ]
}
```

`routing_stats.session_requests` 是识别到会话标识并已预留上游调用的客户端请求数；`default_requests` 是没有标识的请求数。接口切换和换 key 重试不会重复计数。`default_requests` 持续增加，说明客户端缺少已支持的会话标识。

`keys[].calls` 统计数据库中预留的上游调用，HTTP 错误、网络失败和重试也占次数。数据库预留与外部网络调用无法组成同一事务，实例异常终止时可能留下一次未发出或未完成的调用。成功、失败在结果确定后计入；最近一小时仍未确定结果的调用显示在 `in_flight`，更早的未确定调用显示在 `unknown_calls`，不补造成功或失败。

流式 HTTP `200` 若发生失败事件、中断或提前取消，会计为失败；正常 token 上限终止仍算成功。`last_error` 保留最近一次错误的状态、脱敏消息和 UTC 时间，消息最多 1024 字符。没有上游 HTTP 响应时状态为 `null`。`available`、`cooldown_until`、`cooldown_reason` 和 `retry_after_seconds` 显示当前冷却情况，过期后即恢复可用。

**`scope: "d1"` 表示统计与日志来自共享数据库。** 使用同一 D1 的实例共享这些数据，实例回收或重新部署不会清零；更换凭证后，key 统计显示新凭证的数据，路由总数仍保留。`instance.id` 和 `started_at` 仅标记处理本次 health 的实例。

`status: "ok"` 表示配置了 key 且均未冷却；部分冷却为 `degraded`（HTTP 200），全部冷却为 `unavailable`（HTTP 503），没有 key 为 `error`（HTTP 503）。health 不请求上游，不能验证余额或模型缓存命中。

每次上游调用在预留和结束时读写 D1，不会为每个 SSE token 写数据库。D1 不可用会阻止新调用；已返回成功内容后的统计写入失败只输出脱敏 `d1_state_error` 日志，不损坏模型响应，未确认的统计会保留为待定。

### 查看实际客户端发送了哪些字段

每次成功预留上游调用，Worker 输出一条 `event: "upstream_routing"` 的结构化控制台日志。`/health` 从 D1 读取全局最近 20 条，按先后顺序显示。日志包括：

- `source`：实际选用的标识来源；`default` 表示没有识别到。
- `session_fingerprint`：标识的 SHA-256 前 12 位十六进制摘要，方便比较多轮请求是否使用相同标识。
- `preferred_key`、`selected_key`、`reason`：首选与实际使用的 key 名称；原因包括 `session_hash`、`default`、`key_cooldown`、`key_failover` 和 `endpoint_fallback`。
- `request_id`、`attempt`、`instance_id`：关联同一请求的重试，并区分 Worker 实例。
- `user_agent`、`header_names`、`body_fields`、`metadata_fields`：查看客户端和实际出现的字段名；字段名列表最多保留 32 项。

路由日志记录字段名和摘要，不保存完整 prompt、响应正文、原始会话 ID 或鉴权字段值；诊断字符串中的平台 key 和客户端 key 会被遮盖。

观察同一会话的连续几轮请求：`session_fingerprint` 和 `preferred_key` 应保持一致；限额或鉴权失败的重试显示 `key_failover`，后续请求避开共享冷却显示 `key_cooldown`。如果一直显示 `source: "default"`，可从字段名列表检查其他会话字段，或让客户端提供 `X-Session-ID`。

`/health` 已能查看跨实例最近记录。更多实时日志可在 Cloudflare 启用对应 Worker 的 Workers Logs 并筛选 `upstream_routing`；也可以用 Wrangler：

```sh
wrangler tail YOUR_WORKER_NAME --format=json
```

Worker 默认输出控制台日志。设置 `ROUTING_LOGS=off`、`false` 或 `0` 可关闭控制台输出，health 中的最近 20 条记录仍会保留。

## 仅支持 Responses 的模型与 Qwen

如果 AgentRouter 返回“模型 gpt-6.1-sol 不支持 /v1/chat/completions，请改用 /v1/responses”，需要切换上游接口。base URL 仍使用 `https://proxy.wzy.one/v1`。

在 Cloudflare 中设置普通环境变量 **`UPSTREAM_API=responses`**，并部署最新 `worker.js`。此时：

- Codex 请求 `/v1/responses`，Worker 使用真正的平台 key 调用 AgentRouter `/v1/responses`，保留原生 Responses 字段和事件。
- Qwen 请求 `/v1/chat/completions`，Worker 将 messages、函数工具、参数等转换为 Responses 请求；把上游的输出、工具调用、usage 和 SSE 转回 Qwen 需要的 Chat Completions 格式。
- Qwen 流式响应使用 `data: {...chat.completion.chunk...}`，正常终止后发送 `data: [DONE]`；不把原始 Responses 事件直接交给 Qwen。

配置为 `responses` 时不会先发出一次必然失败的 Chat Completions 请求。如果混用支持不同接口的模型，可以保留默认 `auto`。

| 客户端请求 | `auto`（默认） | `responses` | `chat` |
| --- | --- | --- | --- |
| `/v1/responses` | 优先原生 Responses；明确不支持时转换为 Chat | 原生 Responses | Responses → Chat → Responses |
| `/v1/chat/completions` | 优先原生 Chat；明确不支持时转换为 Responses | Chat → Responses → Chat | 原生 Chat |

自动切换最多一次，仅发生在“接口不支持”或明确的端点缺失错误上。参数错误、模型不存在、鉴权失败、限流、网络失败和流中途失败不会触发切换。没有模型名称硬编码，也不会自动更换模型。

## 原脚本的问题与此次修复

| 原问题 | 修改后的行为 |
| --- | --- |
| 没有独立代理鉴权，直接转发客户端 `Authorization`，客户端必须使用平台 key | 统一验证自定义 key；上游凭证只从 secret 读取，同时移除客户端其他凭证头和 Cookie |
| 透传响应没有 CORS 头 | 透传成功、上游 HTTP 错误和本地错误均带 CORS 头，保留透传状态码、响应体和其他响应头 |
| 上游尾斜杠可能拼出双斜杠；路径用贪婪正则删除 `/v1`；任何以 `/responses` 结尾的路径都会被转换 | 规范化上游尾斜杠，只移除开头的完整 `/v1` 路径段，只转换两个明确的 Responses 创建路径 |
| `null` 等请求体可能触发异常；异常上游 JSON 可能被包装成空的成功响应 | 校验请求体、模型、输入、stream 和工具参数；无效请求返回 `400`，无效上游响应返回 `502` |
| Responses 指定函数的 `tool_choice` 被原样交给 Chat Completions | 转换为 `{ "type": "function", "function": { "name": "..." } }` |
| 图片 URL 为对象时转发错误，图片 detail 丢失 | 提取 URL 字符串并保留 detail |
| 上游流中的错误或非法 JSON 被跳过，缺少结束标记时仍报告成功 | 返回 `response.failed`；流式请求收到非 SSE 响应时返回 HTTP `502` |
| 达到 token 上限仍报告 completed | `finish_reason: "length"` 转换为 `incomplete`，流式输出 `response.incomplete` |
| 工具与文本交错时，最终输出顺序与 output_index 不一致，文本缓冲可能重复 | 按 output_index 保存最终输出，重置新文本缓冲，并拼接工具名称与参数片段 |
| 客户端断开后可能继续消费上游流 | 取消上游读取，并释放 reader |
| `text.format` 和 `reasoning.effort` 被忽略 | 转换结构化输出格式、推理强度和 `text.verbosity`，推理请求使用相应的 token 预算字段 |
| 模型拒答内容丢失，过滤或截断时输出项仍标为 completed | 保留 refusal 内容与流式事件；顶层状态和未完成输出项标记一致，支持 content_filter 原因 |
| 上游错误码、请求 ID、Retry-After 丢失，错误信息可能回显平台 key | 保留 JSON 错误结构与相关响应头，遮盖错误信息中的完整平台 key，包括 JSON 转义后的值 |
| 文件、音频和未知内容类型被静默丢弃 | 对不支持或格式错误的输入返回明确的 `400` |
| SSE 按行单独解析，无法处理多行 data 事件 | 按完整事件拼接 data 行，支持 LF、CRLF、CR、注释和 ping；中断时保留已经生成的内容 |
| 304 条件请求响应被当作重定向拒绝 | 透传不含响应体的 `304`，保留 CORS 和缓存响应头 |
| 只支持 Responses → Chat，导致仅支持 Responses 的模型在 Codex/Qwen 上失败 | 原生 Responses 优先与可配置接口模式；新增 Chat → Responses 的请求、JSON、SSE 和工具调用转换 |

格式参考：[OpenAI Docs — Function calling](https://developers.openai.com/api/docs/guides/function-calling)、[OpenAI Docs — Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。

## 结构化输出与推理

`text.format` 支持 `text`、`json_object` 和 `json_schema`。JSON Schema 请求示例：

```json
{
  "model": "你在AgentRouter使用的模型名",
  "input": "返回一句问候",
  "text": {
    "format": {
      "type": "json_schema",
      "name": "greeting",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": { "message": { "type": "string" } },
        "required": ["message"],
        "additionalProperties": false
      }
    }
  }
}
```

转换到 Chat 上游时，Worker 将 `text.format` 转换为 `response_format`，将 `text.verbosity` 转换为 `verbosity`。转换到 Responses 上游时进行相反映射。是否支持这些参数和 schema 由上游与模型决定；Worker 保留上游的错误状态和错误码。

转换到 Chat 上游时，`reasoning.effort` 映射为 `reasoning_effort`。请求包含此参数时，`max_output_tokens` 映射为 `max_completion_tokens`，预算包括推理 token；未指定推理强度时使用 `max_tokens`。转换到 Responses 上游时，`reasoning_effort` 映射为 `reasoning.effort`，`max_completion_tokens` 或 `max_tokens` 映射为 `max_output_tokens`。具体可用推理强度由所选模型决定。

## 格式适配范围

使用与上游相同的接口时，Worker 保留原生 API 字段和成功响应体。例如 Codex 直接调用原生 Responses 时，推理摘要、加密推理项、previous_response_id、store 等均交给上游处理，其支持情况由平台决定。

**跨接口转换**支持文本、通过 URL/data URL 传入的图片、普通函数工具、结构化输出、推理强度，以及流式/非流式文本和拒答输出。函数结果支持字符串或文本内容数组；普通 JSON 对象也会序列化为文本。转换层有以下限制：

- 转换层无服务端对话存储。Responses → Chat 时，`previous_response_id`、`conversation` 请求明确返回 `400`；多轮对话需要在 `input` 中发送历史，返回的 `store` 始终为 `false`。Chat → Responses 时将完整 messages 历史转成 input，并设置 `store: false`。
- 工具仅支持 `type: "function"`；web search、file search 等内置工具明确返回 `400`。
- 推理摘要与加密推理历史未转换，`reasoning` 输入项仍被忽略。`reasoning.effort` 以外的推理配置、`include` 和自动上下文裁剪尚未实现，不能依赖其原生 Responses 行为。
- 文件/音频输入、仅传入图片 file_id、含图片等非文本内容的函数结果明确返回 `400`；后台任务 `background: true` 明确返回 `400`。
- Chat → Responses 支持一个 completion（`n=1`）。stop、logprobs、logit_bias、seed 等无法表达的 Chat 专用功能返回 `400`；函数调用 ID 和参数会在往返转换中保留。推理输出项不会作为普通 Chat 回答正文返回。
- Chat 上游流必须有 `[DONE]`；Responses 上游流必须有 `response.completed` 或 `response.incomplete` 终结事件。支持多行 `data:`。上游失败或中断会转换为客户端对应的失败事件，不补造成功结束。

其他透传接口的能力由 AgentRouter 决定。透传请求保留原始请求体与 Content-Type，成功响应保留原始响应体，支持 multipart 和流式响应。HTTP 错误响应会遮盖完整平台 key：JSON 错误保留原有结构，非 JSON 错误包装为统一的 JSON error。

## 本地验证

使用 Node.js **24 或更高版本**执行（测试通过 `node:sqlite` 验证真实 SQL 和触发器）：

```sh
node --test worker.test.mjs
```

213 项测试使用真实内存 SQLite、模拟上游与测试 key，不访问 AgentRouter、不消耗平台额度。覆盖浏览器登录、无 `Origin` 的同源表单、跨实例 Cookie、过期与凭证替换、CSRF 与 Origin 校验、退出登录、内置/Assets 初始化、重复初始化保留统计、完整触发器和损坏资源处理，以及跨实例统计与冷却、原子预留、重复批次幂等、历史清理和既有的格式转换、SSE、multipart 等场景。生产部署后在浏览器完成 `/init`；本地验证未操作线上资源。
