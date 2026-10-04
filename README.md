# @bananiceee/dsh-chatgpt-provider

在 DeepSeek Harness 里用 **ChatGPT 账号登录**，然后直接把 ChatGPT 方案（Plus / Pro）的模型当成一个普通 provider 使用。

A DeepSeek Harness plugin that signs in with ChatGPT and serves ChatGPT-plan models as a normal `chatgpt` provider route.

---

## 这是什么 / What it does

它往 Harness 里加三样东西：

1. **一个 provider 路由**（`chatgpt`）——注册在 `ctx.llm` 上，走 OpenAI **公开的** Responses API
   `POST https://api.openai.com/v1/responses`，用 Sign in with ChatGPT 的 OAuth access token 认证。
   模型会像其它 provider 一样出现在模型选择器里。
2. **一个登录入口**——设置 → 模型 页面里，本 provider 卡片上的「使用 ChatGPT 继续登录」按钮。
3. **持久化的账号状态**——存在 Harness 的凭据文档里，每个账号一条注册记录，外加本机稳定的 host 标识。

配置全部可选：登录本身就是让这个 provider 可用的前提，模型列表来自账号本身。

## 为什么需要这个插件 / Why a plugin is needed

Harness 自带 `@deepseek-ai/dsh-llm-pi-ai`，而它**已经**注册了 ChatGPT 的授权流程
（pi-ai 的 `openai-codex` provider）。但整个产品里**没有任何东西去消费 `ctx.authorization`** ——
换句话说那条流程注册得出来、却点不到。同时 `llm-pi-ai` 默认休眠：settings 里没有 provider
profile 就不注册任何路由，也不会有模型出现。

更重要的是**协议不一样**。ChatGPT 方案用量是一条受限的 Responses 路由，官方文档明确要求：

- 每个请求都要 `store: false` 与 `stream: true`；
- `input` 必须是数组，HTTP 上没有 `previous_response_id` 续接；
- `{type:"message", role:"system"}` 输入项会被**拒绝**，system 槽只能走 `instructions`；
- 一批字段不支持，必须省略：`background`、`conversation`、`max_output_tokens`、`max_tool_calls`、
  `metadata`、`moderation`、`multi_agent`、`prompt`、`prompt_cache_retention`、`safety_identifier`、
  `temperature`、`top_logprobs`、`top_p`、`truncation`、`user`、`previous_response_id`；
- `tools` 是**平铺**的 `{type:"function", name, …}`，没有 `function` 嵌套层。

所以把 token 塞给通用的 OpenAI 适配器是不行的：它会发出这条路由不接受的字段。
本插件因此自带一个专用 adapter，严格控制 wire format。

## 安装 / Install

```bash
# 从目录安装（开发）
dsh plugin --profile desktop add /path/to/dsh-chatgpt-provider

# 或从 npm 安装
dsh plugin --profile desktop add @bananiceee/dsh-chatgpt-provider
```

`dsh plugin` 会转发给 profile 目录里的 pnpm，然后按已安装状态重建 bundle 层：
只要包装了 `dsh.bundle.patch`，它就会自动进入 profile 的层栈。

**关于生效时机**（这点容易踩坑，实测结论）：

- **从"没装过"到"装上了"是热生效的**：在「设置 → 插件」里把本 bundle 关掉再打开即可，host 半边当场挂载。
- **但改了插件代码之后再 toggle 是没用的**：Node 的 ESM 模块缓存已经持有旧的 `lib/index.js`，
  toggle 只会重跑 `apply`，不会重新读文件。要让**新代码**生效必须重启应用。
- **浏览器那半边（设置页卡片）需要重启**：client module 注册表在启动时扫描 `dsh.client` 包并生成
  脚本表；启动时还不存在的包不会凭空出现在表里。所以卡片要在重启后（并刷新页面）才会出现。
- 尚需注意：注册表对**无法解析的包名**会缓存一个"否定结论"且不过期，但那只影响启动时就已存在的包；
  本插件是在启动后才装进去的，因此不受这条影响。

## 使用 / Usage

1. 打开 **设置 → ChatGPT**（设置侧栏里本插件自己的页面，与本插件同时安装的 `settings.section` 入口）。
   这个页面不依赖模型页，直接和插件自己的 host 接口通信，所以即使 settings 命名空间出问题它照样能用。
2. 点 **使用 ChatGPT 继续登录**（Continue with ChatGPT）。

> **也可以在模型页里用**：本插件同时注册进 `settings.models.provider-card`，所以模型页里
> `chatgpt` 那一行的卡片上也有同一套控件。但那条路径有个额外前提 —— 模型页会把它收到的
> provider 目录和**已服务的 settings 命名空间**做 join，命名空间没注册成功就建不出这一行，
> 而且**界面上不会有任何提示**。所以插件自己的设置页是更可靠的入口。
>
> `/chatgpt/api/status` 是一个**不需要登录**的自检端点，它直接报告四件事：
> `directory.routeLive`（适配器路由注册了吗）、`directory.inDirectory`（provider 目录里有这条吗）、
> `settingsSectionMounted` + `settingsSectionError`（settings 命名空间注册了吗、为什么没注册）、
> 以及 `clientModule`（浏览器半边注册了吗，带一个对照包防止探针自己说谎）。
3. 浏览器会打开 OpenAI 的官方授权页；登录并同意把 ChatGPT 方案用于本应用的请求。
4. 回到 Harness，卡片会显示已登录账号与「正在使用 ChatGPT 方案」。
5. 在模型选择器里挑一个 ChatGPT 模型即可。

设置里可以切换账号（每个账号一条注册记录，互不覆盖）、重新授权、退出登录。
卡片上还有 **管理用量** 链接，指向 ChatGPT 的用量设置页；以及 **测试连接** 按钮 ——
它会真的发一个小请求（"Reply with exactly: ok"）给模型，并回报模型名、回复内容和 token 用量。
这一步是把「凭据存在」变成「凭据能用」：账号过期、额度用尽、会话被撤销都会在这里按名字报出来，
而不是等你下次提问时才炸。

## 工作方式 / How it works

### OAuth（`src/oauth.ts`）

严格照官方 OSS 文档实现：

| 步骤 | 取值 |
| --- | --- |
| 授权端点 | `https://auth.openai.com/api/accounts/authorize` |
| 首次注册 client id | `dynamic_agent_client`（**只**用于注册，绝不存下来当连接用） |
| 回调地址 | `http://127.0.0.1:<port>/auth/callback` —— host 必须是 `127.0.0.1`，path 必须正好是 `/auth/callback`，只有端口可以变 |
| scope | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| resource | `https://api.openai.com/v1` |
| PKCE | 每次尝试新生成 verifier，`S256`；同时新生成 `state` 与 OIDC `nonce` |
| 换 token | `POST https://auth.openai.com/api/accounts/oauth/token`，form-encoded，**无 client secret** |
| 刷新 | 同一端点，`grant_type=refresh_token` + **已签发的** client id + `refresh_token` + `resource`，**省略 `scope`** |
| 撤销 | 从 `https://auth.openai.com/.well-known/openid-configuration` 取 `revocation_endpoint` |

要点：

- **新注册回调会带回签发的 `client_id`（`oaiapp_…`）**，必须存下来并用于之后所有换 token / 重新授权 /
  刷新；把 `dynamic_agent_client` 当成 client id 存是错的，代码里直接拒绝。
- **ID token 先验证再采信**：用 `https://auth.openai.com/.well-known/jwks.json` 验签，校验
  `iss`、`aud`（等于签发的 client id）、`exp`、以及本次尝试的 `nonce`，然后才用 `sub` 作为账号身份。
  邮箱只是显示用的，官方明确说两条注册可以共用同一个邮箱。
- **刷新令牌会轮换**，且官方要求「同一 session 的刷新要串行化，避免两个进程抢一个一次性令牌」。
  这一点靠 Harness 的凭据服务满足：刷新在 `modifyRecord` 内部完成，而它是一次带文件锁的跨进程
  read-modify-write，access token、过期时间、scope、refresh token 因此**一起**原子落盘。

### 账号存储（`src/accounts.ts`）

不用插件自己的文件，而是写进 Harness 的凭据文档（`$DSH_HOME/.credentials.yaml`）：

- 每个账号一条 `grant` 记录，key 是 `chatgpt/acct-<hash>`，`hash` 由**已验证的 `sub` + 签发的 client id**
  推出 —— 官方说这两者才是一条注册的身份，所以不能用邮箱当 key。
- 本机 host 标识存在同一个文档的保留记录 `chatgpt/host` 里。它不是密钥，放这里是图这个存储
  自带的原子写与 `0600` 权限，而且必须跨重启稳定。

### 适配器（`src/adapter.ts`、`src/serialize.ts`、`src/stream.ts`）

- **请求**：`options.system` → `instructions`；历史里的 system 消息折进 `instructions`。
  `temperature` / `maxTokens` / `stop` 这三个字段这条路由无法满足，代码**抛 `UNSUPPORTED` 而不是
  静默丢弃** —— 调用方设了就该知道自己设的没生效。
- **图片**：附件字节经 attachments 接缝取出后内联成 `data:` URL（`image_url` 字段）。超预算的图片
  会被跳过，并在原位留下说明文字，同时记一条日志 —— 不是悄悄消失。
- **工具调用**：参数自始至终是原始 JSON 字符串；`function_call` / `function_call_output` 平铺在
  `input` 里。
- **无损重放**：这条路由是无状态的，官方要求「带工具调用返回的 reasoning item 必须随工具结果一起
  传回」。所以 adapter 通过 Harness 的 `replayState` 把这轮响应的**原生 `output` 项原样存下**，
  下一轮原样回放（`encrypted_content`、assistant `phase` 都没有中立表示，只有原生回显才忠实）。
  同时按块记录元数据：一旦 harness 因截断丢弃某个块导致长度对不上，整份信封会被丢弃，
  退回到中立重建而不是回放半份响应。
- **token 计数**：Harness 的 `inputTokens` 定义是**未命中缓存**的输入，而 provider 报的
  `input_tokens` 是含缓存的总额，所以缓存部分会被减出去、单独报在 `cacheReadTokens` /
  `cacheWriteTokens` 里，不重复计数。
- **失败分类**：官方给 ChatGPT 方案的错误码**原样保留**
  （`subscription_sharing_usage_limit_exceeded`、`subscription_sharing_usage_unavailable` 等）。
  这些码按官方要求**不重试**：用量超限要求「暂停新请求」，用户不符合资格要求「不要重复请求、
  也不要循环走 OAuth」。而两个 503 类瞬时错误（`..._usage_unavailable`、`..._user_unavailable`）
  则加入可重试集合，做有界退避。
- **成功判定**：只有收到 `response.completed` 才算成功。流提前结束 = 失败
  （`STREAM_INCOMPLETE`），哪怕已经吐了一段文本。

### 登录入口（`src/routes.ts`、`src/client/`）

`ctx.authorization` 只存在于 host 侧，页面上够不到，所以插件自带一个小小的 JSON 接口
（`/chatgpt/api/status|signin|cancel|select|signout|selftest`，挂在既有的 loopback web server 上），
浏览器那半注册进 `settings.models.provider-card` 这个插槽、key 用本插件的 settings namespace
（`chatgpt`），于是按钮正好出现在模型页里本 provider 的卡片上。

## 已验证 / What is verified

`tests/` 下有六个可直接运行的检查，共 **98 项**，全部通过：

```bash
pnpm test                 # 六个一起跑
node tests/verify.mjs     # 23 项：请求契约、流翻译、授权 URL、失败分类、账号寻址
node tests/mount.mjs      # 12 项：插件挂载、注册内容、适配器契约、HTTP 表面
node tests/adapter.mjs    # 12 项：适配器整条请求链路（对本地假 API 服务器）
node tests/signin.mjs     # 20 项：完整登录 / 刷新 / 撤销 / 并发串行化（对本地假授权服务器）
node tests/client.mjs     # 20 项：浏览器半边（jsdom + 真实 React 渲染，含两个插槽）
node tests/registry.mjs   #  9 项：接进**真实**的 LlmRuntime（不是桩）
node tests/live-models.mjs  # 真实账号：清单里有哪些、哪些 id 真能跑（只读凭据，不打令牌）
```

`registry.mjs` 是这批测试里最接近"模型真的会出现在选择器里吗"的一项：其余测试都是直接调适配器，
证明的是"适配器能用"，而不是"Harness 收得下"。这个测试加载 Harness 自己编译出来的 `LlmRuntime`
和 cordis，把插件的适配器**真正注册进去**，然后断言路由、模型发现、元数据解析、call-config
校验、以及终止失败归一化都成立。其中最关键的一条是**抛出的错误码能否活着穿过注册表的归一化器** ——
Harness 会优先采信错误对象自带的 `failure` 快照而不是它的类，因为跨包副本的 `instanceof` 不成立；
如果这条不成立，重试策略和所有诊断都只会看到 `UNKNOWN`。这正是本插件"结构化实现而非子类"这一
设计成立与否的判据。

没有 checkout 时它会打印跳过信息并以 0 退出，所以发布出去的包里跑也不会失败。

`signin.mjs` 里最要紧的一项是**并发刷新**：刷新令牌是一次性的、每次刷新都会轮换，官方因此
明确要求「同一 session 的刷新必须串行化，避免两个进程抢一个一次性令牌」。测试用两个（以及
八个）并发解析打同一个过期令牌，断言 token 端点**只被调用一次**、所有调用方拿到同一个新令牌、
且落盘的就是轮换后的那个。它还断言**新鲜令牌走的是无锁读路径**（`modifyRecord` 不被触碰）——
否则每个模型请求都要去抢一次凭据文档的文件锁。

`client.mjs` 解决了一个别扭的事实：client bundle 是页面求值的懒加载 CJS 工厂，构建能过不代表它能跑。
这个测试按页面的方式捕获 `window.__ModuleLoader__.load(...)` 注册、跑工厂、用桩 client context 调
`apply()`，然后**用 React 在 jsdom 里真的把卡片挂载起来**，让它的 effect、fetch、状态迁移都真实发生。
它覆盖的正是构建抓不到的那一类问题：注册形状写错、`apply` 抛异常、某一门语言少一个 key、
组件首屏就崩或者**静默什么都不渲染**。它还断言了 OpenAI UI 规范要求的文案（首次登录的
`Continue with ChatGPT`、以及 `Manage usage` 链接指向 `chatgpt.com/settings/usage`）。

这个测试抓到两个真 bug：`callApi` 在 host 不可达时抛出的 rejection 无人接管（卡片永远停在
"Loading…"），以及 **loading 分支在 error 分支之前 return** —— 就算捕获了错误也永远显示不出来。

测试在开发过程中一共抓到 **5 个真 bug**，全部已修：

| bug | 后果 |
| --- | --- |
| `OAuthError` 四处参数顺序写反（`(code, message)` 而非 `(message, code)`） | 用户在浏览器点「拒绝授权」会被报成**登录失败**而不是取消 |
| host 标识首次写入先读后写 | 两个进程同时首登会各铸一个不同的 host id，而它必须跨重启稳定 |
| `callApi` 的 rejection 无人接管 | host 不可达时卡片永远停在 "Loading…" |
| loading 分支在 error 分支之前 return | 错误就算被捕获也**永远显示不出来** |
| 已选账号被退出登录后 `resolveAccountId` 返回 `undefined` | 还有别的账号可用时，provider 却整个不可用（`MISSING_CREDENTIAL`） |
| assistant 消息的文本块写成了 `input_text` | 这条路由只接受 `output_text` / `refusal`，于是**只有第一轮能跑**：一旦历史里有 assistant 回合，下一次请求就被 400 拒掉（`invalid_value`） |
| 把 `off` 当成一个推理档位提供 | 这条路由的模型不接受"关闭推理"的 wire 值，选了就是必失败；同时缺了 `xhigh` / `max` 两档 |
| settings 地址用了自造命名空间 `chatgpt` 而非 profile 条目 id | 模型页那一行**永远建不出来**，且扩展区无注册者时静默渲染空 —— 界面上没有任何提示 |
| 模型页卡片的 `key` 与目录条目的 `settingsNs` 不一致 | 同上，页面派发一个 key、没人认领，静默渲染空 |
| 挂载步骤抛异常时，插件的诊断接口还没注册 | **它把自己的报警器一起弄哑了**：provider 坏了、HTTP 全 404、没有任何地方能问为什么。现在 HTTP 表面是**第一个**注册的东西，所有可能抛异常的步骤都在它之后、并且被 try/catch 包住，失败写进 `mountError` |
| 一次空目录注册（`registerConfigurableProviders([])`） | 空注册是非法的（`replace([])` 才合法），它会抛 —— 而上一条让这个异常直接变成"插件整体不工作"。这是我自己在改代码时留下的一行垃圾，代价是你重启一轮 |
| 把 `earliest_refresh_at` 当成"在此之前令牌不可用" | 它在 60 分钟令牌的第 ~54 分钟才到，于是**大部分时间里每个模型请求都去做一次 token 交换并轮换 refresh token**；provider 容忍提前刷新，所以看起来完全正常，只是每次调用白付一个往返、并把一次性凭据反复作废 |

还有一个**不是**插件 bug、但同样致命的坑：`ctx.settings.register()` 抛出的异常会被 cordis 静默吞掉，
命名空间只是"没出现"而已 —— 而模型页恰恰用"已服务的 settings 命名空间"来 join provider 行，
于是 provider 明明注册成功了（路由活着、目录里有），界面上却一行都没有、也不报错。
`settingsSectionMounted` / `settingsSectionError` 两个字段就是为这件事加的。

`adapter.mjs` 把适配器**真的跑一遍** —— 凭据解析、HTTP 请求、请求头、流式解析、图片内联 ——
只把 API base 换成本地服务器（用的就是 `apiBase` 这个接缝）。它因此能断言真实线上请求的样子：

- 请求头齐全：`Authorization: Bearer`、`content-type`、`accept: text/event-stream`，以及
  **强制的应用标识 `user-agent`**；
- 请求体里 `store:false` / `stream:true` 恒为真，且**每一个**文档列出的不支持字段都**不存在**
  （逐个断言 `in` 而不是"没用到"）；
- SSE 帧被**拆成两个 chunk** 发送，证明读取端能处理跨 chunk 的帧边界；
- 工具调用参数原样保留、图片变成 `data:` URL；
- 429 的方案错误码能保住 `code`、`failure.code`、HTTP 状态与 `openai-request-id`；
- 未登录时**一次网络请求都不发**；已 abort 的 signal 也不会发出请求。

`verify.mjs` 覆盖的关键不变量：`store:false`/`stream:true` 恒为真、system 消息永不进入
`input`、平铺 tools、不支持字段被拒绝、流里 `usage` 必在 `finish` 之前且其后无内容、工具参数
保持原始 JSON、usage 计数不重复计缓存、限流错误码原样透出、流未终止即失败、以及**终止性的
方案错误码不在可重试集合里**。

`signin.mjs` 是端到端的那一个：它起一个本地假的授权 / token / JWKS 服务器，然后**走插件自己的
代码**跑完整条链路 —— PKCE 生成、授权 URL、loopback 回调监听、state 校验、code 交换、
**真实 RS256 验签（对着服务器提供的 JWKS）**、grant 落盘、取用 access token、轮换刷新、撤销。
它因此能断言手写单测断言不了的东西：

- **PKCE 正确性**：假服务器会拿收到的 `code_verifier` 重算 challenge 并比对 —— 证明我们生成的
  PKCE 是**对的**，而不只是"有"。
- **刷新令牌一次性**：刷新后旧 refresh token 必须失效（这正是"刷新必须串行化"的原因）。
- **不刷新时不轮换**：令牌还新鲜时不得触发刷新，否则会白白作废一个 refresh token。
- **state 不匹配的回调不能结算这次尝试**（返回 400 且尝试仍在等待）。
- **拒绝授权 = cancelled 而非 failed**；**新注册回调缺少签发的 `client_id` 必须拒绝**；
  **nonce 不对 / audience 不对的 ID token 必须拒绝且不留任何账号记录**；
  **token 端点报错时不得写入任何东西**。
- **同一时刻只允许一个登录尝试**；**重新授权会复用已签发的 client id 并省略 `agent_name_hint`**。
- **本机 host 标识并发首次使用时只产生一个值**。

这个测试确实抓到了两个真 bug：`OAuthError` 在四处把「消息」和「错误码」两个参数写反了
（导致用户拒绝授权时被报成失败而不是取消），以及 host 标识的首次写入存在竞态 ——
先读后写会让两个进程各铸一个不同的 host id，而 host id 必须跨重启稳定。
两者都已修复。

## 两个只有真实运行才会暴露的坑

这两个都不是"写错了函数名"，而是**版本/命名约定与另一处代码的隐性契约**，而且**失败时完全不报错**。

### 1. `settings` 服务在 0.2 没有 `register`，而且地址必须是 profile 条目 id

0.1.x 的 settings 是"插件注册一个自己的命名空间"，0.2.x 完全改了：

```
describe(): { ns, revision, schema, value, base, user, ... }[]
update(ns, patch, expectedRevision)
replace(ns, section, expectedRevision)
mutate(ns, ops, expectedRevision)      // 没有 register
```

新模型是**把插件自己的 Config schema 投影成表单**，`ns` 就是 **profile 条目 id**。
内置适配器看起来像是在用一个私有命名空间（`llm-pi-ai`、`llm-deepseek`），但那只是因为
**它们的命名空间字符串恰好等于自己的条目 id** —— 这个巧合掩盖了一条硬约束。

本插件一开始把命名空间起名 `chatgpt`、而条目 id 是 `dsh-chatgpt-provider`，于是：

- `settings.register` 不存在 → `TypeError`，被 cordis 静默吞掉
- 模型页拿 provider 目录和"已服务的 settings 条目"做 join → **建不出这一行**
- 而 `settings.models.provider-card` 扩展区在**没有注册者时就是渲染空**，也不报错
- 结果：路由活着、目录里有、卡片代码也加载了，**界面上什么都没有**

现在两处都对齐到 `dsh-chatgpt-provider`：目录条目的 `settingsNs`、客户端注册的 `key`、
以及 `describe()` 查的 id 必须是同一个字符串。`cordis.patch.yml` 里那个 `id:` 就是它。

### 2. 清单外的模型 id 是**能用的** —— 清单只是"账号报告了什么"

`GET /v1/models` 对这个账号实际返回 7 条，其中 2 条 `visibility: "hide"`：

| id | visibility |
| --- | --- |
| gpt-6-astra / gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / gpt-5.5 | `list` → 展示 |
| gpt-reserve / codex-auto-review | `hide` → 不展示 |

按官方文档只展示 `visibility == "list"`，所以显示 5 个是**正确**的。Codex 那边能看到
`GPT-6.1 Sol` / `GPT-6 Sol` / `GPT-6 Luna`，是因为它用的是**自带的静态目录** —— 官方文档原文：
「如果使用 Codex app-server，它的 `model/list` RPC 可能使用**内置或缓存的目录**；当你的 UI 需要
当前账号的模型选择时，请使用上面的请求。」

**但这不等于它们不能用。** 实测（`tests/live-models.mjs`，各发一个真实请求）：

```
gpt-6-luna    unlisted  OK  reply="ok"
gpt-6-sol     unlisted  OK  reply="ok"
gpt-6.1-sol   unlisted  OK  reply="ok"
gpt-5.6-luna  listed    OK  reply="ok"
```

所以本插件的策略是：**默认不展示清单没有的模型**（展示一个用不了的模型比不展示更糟），
但**显式配置就会出现**，而且配置进去的 id 会正常参与请求（适配器按契约接受未列出的 id）：

```yaml
- id: dsh-chatgpt-provider      # profile 的 cordis.patch.yml
  name: "@bananiceee/dsh-chatgpt-provider"
  config:
    models:
      - id: gpt-6.1-sol
        name: GPT-6.1 Sol
      - id: gpt-6-sol
        name: GPT-6 Sol
      - id: gpt-6-luna
        name: GPT-6 Luna
    testModel: gpt-6-luna      # 测试连接打哪个；省略时优先选 id 含 luna 的
```

`tests/live-models.mjs` 可以直接回答"这个 id 到底能不能用"：

```bash
node tests/live-models.mjs                 # 默认探测 gpt-6-luna / gpt-6-sol / gpt-6.1-sol / gpt-5.6-luna
node tests/live-models.mjs gpt-6-astra     # 或指定任意 id
```

它**只读**凭据文档，绝不刷新令牌（刷新会轮换那个一次性 refresh token，在凭据服务的锁之外做
可能作废正在运行的实例手里的值）；令牌过期时它会拒绝运行并让你先在界面上刷新。

### 3. settings 地址是 profile 条目 id，而且拼写取决于行是怎么进树的

除了上面那条"必须等于条目 id"，还有一层：**bundle `insert:` 进去的行与 profile patch 直接声明的行，
寻址拼写不同**（`include:<id>` 与 `<id>`）。猜错是静默失败 —— 地址解析不到的 provider 就是没有行。

所以插件不再猜：它在挂载时问 `settings.describe()` 实际服务了哪些名字，按候选顺序取第一个命中的，
一个都没有时就把**服务实际提供的名字全列出来**，让不匹配变得可读。诊断字段：
`settingsSettingsNamespace`（本插件声明的）与 `settingsNamespaces`（服务提供的全部）。

## 变更 / Changelog

### 未发布

- **修复：工具返回的图片不再丢失。** `function_call_output` 这个 item 只接受文本，此前图片被替换为
  一句占位文本、模型完全看不到 —— 截图检查、网页视觉验证、Office 排版检查都因此静默失效。
  现在图片作为**紧随该输出项之后的一条 user 消息**发出（`input_image`），复用用户上传图片的同一
  路径：同一个 `readImage` seam、同一套单图/单请求字节上限、同一个 data URL 拼法，超限时同样是
  明确文字的占位符而非静默丢弃。工具结果的**文本内容一字不丢**。
  回归测试：`tests/verify.mjs` 的 "an image a TOOL returned reaches the model instead of being dropped"
  （在修复前必然失败）。

## 已知限制 / Known limitations

- **依赖非官方之外的官方预览能力**。这条路径是 OpenAI 面向开源客户端新开放的
  「Sign in with ChatGPT / ChatGPT plan usage」，目前是 Preview：字段限制、scope 名、
  端点都可能在正式版前变化。
- **Plus 的五小时限额是与其它应用共享的**，本应用拿不到单独额度（Pro 不受五小时限制影响）。
- **不在 OpenAI 的通知范围内**：用户在 ChatGPT 设置里断开应用时 OpenAI 不会通知本插件；
  要等某次请求或刷新确认失效才会发现。官方也明确说「不要仅因为临时的网络或基础设施故障就
  清除凭据」——所以本插件不会那样做。
- **`/chatgpt/api/*` 不带额外鉴权**。它只监听 `127.0.0.1`（和其它插件注册的 web 路由一样），
  暴露的是账号邮箱/身份与登录控制，不含令牌本身。在本机多用户场景下应当知道这一点。
- **用量不显示余额**。官方文档没有给出查询 ChatGPT 方案剩余额度的接口，所以卡片只显示
  「正在使用 ChatGPT 方案」并给出「管理用量」链接，不猜数字。
- **图片有内联上限**（默认单张 8 MiB、单请求 24 MiB），超出的图片会被跳过并留下说明文字。

## 安全说明 / Security notes

- 令牌只落在 Harness 的凭据文档里（`0600`、原子写、带文件锁），不写日志、不进环境变量。
- 本机 host 标识是 `urn:uuid:` 形式的固定标识，只是标识符、不是凭据，官方也说明它不构成
  私钥持有证明。
- 登录流程全程只与 `auth.openai.com` 与 `api.openai.com` 通信；令牌**不会**被发往
  ChatGPT 的 `backend-api`（官方明确禁止这样做）。

## 文档来源 / References

- [Sign in with ChatGPT — Overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
- [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)

## 开发 / Development

```bash
pnpm install
pnpm run build          # 编译 host（lib/）+ 类型检查 client
pnpm run build:client   # 只打浏览器包（tsdown → lib/client.js）
node tests/verify.mjs
node tests/mount.mjs
```

`scripts/build.sh` 会探测 Harness checkout（`DSH_CHECKOUT` 或常见路径），把插件链接进去以便
client 的 tsconfig 走 `../packages/...` 视图，并用 checkout 的 tsc 编译。

**本仓库提交 `lib/`**，与常见的"只提交源码"不同：`package.json` 的 `main` 指向
`./lib/index.js`，而 `build.sh` 需要一个完整的 Harness checkout —— 也就是说没有 `lib/`
的 clone **根本装不上**。改完 `src/` 记得跑一次 `npm run build` 再提交，否则仓库里的产物会落后于源码。

Host 半边**不导入任何 `@deepseek-ai/*` 的运行时值**，只用类型导入：插件在 Harness 源码树之外，
多一份 Harness 包的副本就是多一个模块实例（`instanceof` 会失效）。适配器因此是
**结构化实现**而非 `LlmAdapter` 子类 —— 注册表校验的是行为（路由身份、非空名字、`stream()`
方法），不是 `instanceof`；错误对象同时带 `code` 与相匹配的 `failure` 自有属性，这正是 Harness
为「来自包副本的错误」准备的通道。唯一的运行时依赖是 `jose`（ID token 验签）与
`@deepseek-ai/schemastery`（settings section 的 schema，它用 `Symbol.for('schemastery')` 做品牌，
跨实例安全）。

## License

MIT
