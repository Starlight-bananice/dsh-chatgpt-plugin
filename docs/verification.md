# 验证 / Verification

六个测试套件，共 **99 项**，全部通过。它们不需要真实账号（除 `live-models.mjs`）：

```bash
pnpm test                    # 六个一起跑
node tests/verify.mjs        # 24 项：请求契约、流翻译、授权 URL、失败分类、账号寻址
node tests/mount.mjs         # 14 项：插件挂载、注册内容、适配器契约、HTTP 表面
node tests/adapter.mjs       # 12 项：适配器整条请求链路（对本地假 API 服务器）
node tests/signin.mjs        # 20 项：完整登录 / 刷新 / 撤销 / 并发串行化（对本地假授权服务器）
node tests/client.mjs        # 20 项：浏览器半边（jsdom + 真实 React 渲染，含两个插槽）
node tests/registry.mjs      #  9 项：接进**真实**的 LlmRuntime（不是桩）
node tests/live-models.mjs   # 真实账号：清单里有哪些、哪些 id 真能跑（只读凭据）
```

CI 在每次 push 与 PR 上跑前六个（`.github/workflows/tests.yml`）。

## 各套件证明什么

### `registry.mjs` —— 最接近「模型真的会出现在选择器里吗」

其余测试都是直接调适配器，证明的是「适配器能用」，而不是「Harness 收得下」。这个测试加载
Harness 自己编译出来的 `LlmRuntime` 和 cordis，把插件的适配器**真正注册进去**，然后断言路由、
模型发现、元数据解析、call-config 校验、以及终止失败归一化都成立。

最关键的一条是**抛出的错误码能否活着穿过注册表的归一化器**。Harness 会优先采信错误对象自带的
`failure` 快照而不是它的类，因为跨包副本的 `instanceof` 不成立 —— 这正是本插件「结构化实现
而非子类」这一设计成立与否的判据。

没有 checkout 时它会打印跳过信息并以 0 退出，所以发布出去的包里跑也不会失败。

### `signin.mjs` —— 端到端走插件自己的代码

起一个本地假的授权 / token / JWKS 服务器，然后走完整条链路：PKCE 生成、授权 URL、loopback
回调监听、state 校验、code 交换、**真实 RS256 验签（对着服务器提供的 JWKS）**、grant 落盘、
取用 access token、轮换刷新、撤销。

因此能断言手写单测断言不了的东西：

- **PKCE 正确性**：假服务器拿收到的 `code_verifier` 重算 challenge 并比对 —— 证明生成的 PKCE
  是**对的**，而不只是「有」
- **刷新令牌一次性**：刷新后旧 refresh token 必须失效
- **不刷新时不轮换**：令牌还新鲜时不得触发刷新，否则会白白作废一个 refresh token
- **并发刷新串行化**：用两个（以及八个）并发解析打同一个过期令牌，断言 token 端点**只被调用
  一次**、所有调用方拿到同一个新令牌、落盘的是轮换后的那个
- **新鲜令牌走无锁读路径**（`modifyRecord` 不被触碰），否则每个模型请求都要去抢一次凭据文档的
  文件锁
- state 不匹配的回调不能结算这次尝试；拒绝授权 = `cancelled` 而非 `failed`；新注册回调缺少
  签发的 `client_id` 必须拒绝；nonce / audience 不对的 ID token 必须拒绝且不留任何账号记录；
  token 端点报错时不得写入任何东西
- 同一时刻只允许一个登录尝试；重新授权会复用已签发的 client id 并省略 `agent_name_hint`
- 本机 host 标识并发首次使用时只产生一个值

### `adapter.mjs` —— 真实线上请求的样子

把 API base 换成本地服务器（`apiBase` 接缝），其余全走插件自己的代码：凭据解析、HTTP 请求、
请求头、流式解析、图片内联。断言：

- 请求头齐全：`Authorization: Bearer`、`content-type`、`accept: text/event-stream`，
  以及**强制的应用标识 `user-agent`**
- 请求体里 `store:false` / `stream:true` 恒为真，且**每一个**文档列出的不支持字段都**不存在**
  （逐个断言 `in` 而不是「没用到」）
- SSE 帧被**拆成两个 chunk** 发送，证明读取端能处理跨 chunk 的帧边界
- 工具调用参数原样保留、图片变成 `data:` URL
- 429 的方案错误码能保住 `code`、`failure.code`、HTTP 状态与 `openai-request-id`
- 未登录时**一次网络请求都不发**；已 abort 的 signal 也不会发出请求

### `verify.mjs` —— 关键不变量

`store:false`/`stream:true` 恒为真、system 消息永不进入 `input`、平铺 tools、不支持字段被拒绝、
流里 `usage` 必在 `finish` 之前且其后无内容、工具参数保持原始 JSON、usage 计数不重复计缓存、
限流错误码原样透出、流未终止即失败、以及**终止性的方案错误码不在可重试集合里**。

### `client.mjs` —— 构建抓不到的那一类问题

client bundle 是页面求值的懒加载 CJS 工厂，构建能过不代表它能跑。这个测试按页面的方式捕获
`window.__ModuleLoader__.load(...)` 注册、跑工厂、用桩 client context 调 `apply()`，然后用
**React 在 jsdom 里真的把卡片挂载起来**，让它的 effect、fetch、状态迁移都真实发生。

它覆盖：注册形状写错、`apply` 抛异常、某一门语言少一个 key、组件首屏就崩或**静默什么都不渲染**。
还断言了 OpenAI UI 规范要求的文案（`Continue with ChatGPT`、`Manage usage` 链接指向
`chatgpt.com/settings/usage`）。

## 测试抓到的真实 bug

开发过程中这些测试抓到 **7 个真 bug**，全部已修 —— 列在这里是为了说明测试覆盖的**类型**，
而不是罗列历史：

| bug | 后果 |
| --- | --- |
| `OAuthError` 四处参数顺序写反 | 用户点「拒绝授权」被报成**登录失败**而不是取消 |
| host 标识首次写入先读后写 | 两个进程同时首登会各铸一个不同的 host id |
| `callApi` 的 rejection 无人接管 | host 不可达时卡片永远停在 "Loading…" |
| loading 分支在 error 分支之前 return | 错误就算被捕获也**永远显示不出来** |
| 已选账号退出后 `resolveAccountId` 返回 `undefined` | 还有别的账号可用时 provider 却整个不可用 |
| assistant 文本块写成 `input_text` | 该路由只接受 `output_text`/`refusal`，于是**只有第一轮能跑** |
| 工具返回的图片被替换为占位文字 | 模型看不见图，截图检查 / 视觉验证静默失效 |

还有两个同类但源自产品契约、而非笔误的问题，见
[development.md](development.md#两条隐性契约)。
