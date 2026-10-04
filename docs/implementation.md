# 实现说明 / Implementation

面向要改这个插件的人。使用者请看 [README](../README.md)。

## 为什么需要单独的 adapter

Harness 自带 `@deepseek-ai/dsh-llm-pi-ai`，它**已经**注册了 ChatGPT 的授权流程
（pi-ai 的 `openai-codex` provider）。但整个产品里**没有任何东西去消费 `ctx.authorization`** ——
那条流程注册得出来、却点不到。同时 `llm-pi-ai` 默认休眠：settings 里没有 provider profile
就不注册任何路由，也不会有模型出现。

更重要的是**协议不一样**。ChatGPT 方案用量是一条受限的 Responses 路由，官方文档明确要求：

- 每个请求都要 `store: false` 与 `stream: true`
- `input` 必须是数组，HTTP 上没有 `previous_response_id` 续接
- `{type:"message", role:"system"}` 输入项会被**拒绝**，system 槽只能走 `instructions`
- 一批字段不支持，必须省略：`background`、`conversation`、`max_output_tokens`、
  `max_tool_calls`、`metadata`、`moderation`、`multi_agent`、`prompt`、`prompt_cache_retention`、
  `safety_identifier`、`temperature`、`top_logprobs`、`top_p`、`truncation`、`user`、
  `previous_response_id`
- `tools` 是**平铺**的 `{type:"function", name, …}`，没有 `function` 嵌套层

把令牌交给通用 OpenAI 适配器是不行的：它会发出这条路由不接受的字段。

## 结构约束：结构化实现，不是子类

Host 半边**不导入任何 `@deepseek-ai/*` 的运行时值**，只用类型导入。插件跑在 Harness 源码树之外，
多一份 Harness 包的副本就是多一个模块实例，`instanceof` 会失效。

适配器因此是**结构化实现**而非 `LlmAdapter` 子类 —— 注册表校验的是行为（路由身份、非空名字、
`stream()` 方法），不是 `instanceof`。错误对象同时带 `code` 与相匹配的 `failure` 自有属性，
这正是 Harness 为「来自包副本的错误」准备的通道；如果这条不成立，重试策略和所有诊断都只会
看到 `UNKNOWN`。

## OAuth（`src/oauth.ts`）

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

- **新注册回调会带回签发的 `client_id`（`oaiapp_…`）**，必须存下来并用于之后所有换 token /
  重新授权 / 刷新。把 `dynamic_agent_client` 当成 client id 存是错的，代码里直接拒绝。
- **ID token 先验证再采信**：用 `https://auth.openai.com/.well-known/jwks.json` 验签，校验 `iss`、
  `aud`（等于签发的 client id）、`exp`、以及本次尝试的 `nonce`，然后才用 `sub` 作为账号身份。
  邮箱只是显示用的 —— 官方明确说两条注册可以共用同一个邮箱。
- **刷新令牌会轮换**，且官方要求「同一 session 的刷新要串行化，避免两个进程抢一个一次性令牌」。
  这一点靠 Harness 的凭据服务满足：刷新在 `modifyRecord` 内部完成，而它是一次带文件锁的跨进程
  read-modify-write，access token、过期时间、scope、refresh token 因此**一起**原子落盘。

## 账号存储（`src/accounts.ts`）

不用插件自己的文件，而是写进 Harness 的凭据文档（`$DSH_HOME/.credentials.yaml`）：

- 每个账号一条 `grant` 记录，key 是 `chatgpt/acct-<hash>`，`hash` 由**已验证的 `sub` + 签发的
  client id** 推出 —— 官方说这两者才是一条注册的身份，所以不能用邮箱当 key
- 本机 host 标识存在同一个文档的保留记录 `chatgpt/host` 里。它不是密钥，放这里是图这个存储
  自带的原子写与 `0600` 权限，而且必须跨重启稳定

## 适配器（`src/adapter.ts`、`src/serialize.ts`、`src/stream.ts`）

- **请求**：`options.system` → `instructions`；历史里的 system 消息折进 `instructions`。
  `temperature` / `maxTokens` / `stop` 这三个字段这条路由无法满足，代码**抛 `UNSUPPORTED`
  而不是静默丢弃** —— 调用方设了就该知道自己设的没生效。
- **图片**：附件字节经 attachments 接缝取出后内联成 `data:` URL（`image_url` 字段）。
  超预算的图片会被跳过，并在原位留下说明文字，同时记一条日志 —— 不是悄悄消失。
  工具返回的图片走**同一条路径**，只是作为紧随 `function_call_output` 之后的 user 消息发出，
  因为该 item 本身只接受文本。
- **工具调用**：参数自始至终是原始 JSON 字符串；`function_call` / `function_call_output`
  平铺在 `input` 里。
- **无损重放**：这条路由是无状态的，官方要求「带工具调用返回的 reasoning item 必须随工具结果
  一起传回」。所以 adapter 通过 Harness 的 `replayState` 把这轮响应的**原生 `output` 项原样存下**，
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
- **成功判定**：只有收到 `response.completed` 才算成功。流提前结束 = 失败（`STREAM_INCOMPLETE`），
  哪怕已经吐了一段文本。

## 登录入口（`src/routes.ts`、`src/client/`）

`ctx.authorization` 只存在于 host 侧，页面上够不到，所以插件自带一个小小的 JSON 接口
（`/chatgpt/api/status|signin|cancel|select|signout|selftest`，挂在既有的 loopback web server 上）。
浏览器那半注册进 `settings.models.provider-card` 插槽，key 用本插件的 settings namespace，
于是按钮正好出现在模型页里本 provider 的卡片上。

**HTTP 表面是第一个注册的东西。** 所有可能抛异常的挂载步骤都在它之后、并且被 try/catch 包住，
失败写进 `mountError` —— 否则挂载失败会连诊断接口一起弄哑，provider 坏了、HTTP 全 404、
没有任何地方能问为什么。
