# @bananiceee/dsh-chatgpt-provider

在 DeepSeek Harness 里用 **ChatGPT 账号登录**，把 ChatGPT 方案（Plus / Pro）的模型当成普通 provider 使用。

A DeepSeek Harness plugin that signs in with ChatGPT and serves ChatGPT-plan models as a normal `chatgpt` provider route.

- 走 OpenAI **公开的** Responses API，用 Sign in with ChatGPT 的 OAuth 令牌认证
- 模型出现在 Harness 自带的模型选择器里，与其它 provider 无异
- 账号、令牌、刷新全部托管在 Harness 的凭据文档中；本插件不做代理、不经第三方服务器
- 唯一的运行时依赖是 `jose`（ID token 验签）与 `@deepseek-ai/schemastery`

> **Preview 依赖。** 它建立在 OpenAI 面向开源客户端新开放的 Sign in with ChatGPT 之上，
> 该能力目前是 Preview：端点、scope 名与字段限制都可能变化。

## 为什么需要它 / Why a plugin

Harness 自带的 `@deepseek-ai/dsh-llm-pi-ai` **已经**注册了 ChatGPT 的授权流程，但整个产品里
没有东西去消费它 —— 那条流程注册得出来、却点不到；而且它默认休眠，没有 provider profile
就不注册任何路由，选择器里也不会出现模型。

更关键的是协议不同。ChatGPT 方案用量是一条**受限的** Responses 路由：强制 `store: false` /
`stream: true`、没有 `previous_response_id` 续接、system 槽只能走 `instructions`、
一批字段必须省略。把这些令牌交给通用 OpenAI 适配器是不行的 —— 它会发出这条路由不接受的字段。

细节见 [docs/implementation.md](docs/implementation.md)。

---

## 环境要求 / Requirements

- DeepSeek Harness **0.2.x**
- 一个 ChatGPT **Plus 或 Pro** 账号
- 本机 `127.0.0.1` 上的可用端口（OAuth 回调固定走 loopback）

## 安装 / Install

```bash
dsh plugin --profile desktop add @bananiceee/dsh-chatgpt-provider
```

从源码目录安装（开发用）：

```bash
dsh plugin --profile desktop add /path/to/dsh-chatgpt-provider
```

## 快速上手 / Quick start

1. 重启 Harness，打开 **设置 → ChatGPT**
2. 点 **使用 ChatGPT 继续登录**，浏览器会打开 OpenAI 官方授权页
3. 登录并同意把 ChatGPT 方案用于本应用的请求
4. 回到 Harness，卡片显示已登录账号
5. 在模型选择器里挑一个 ChatGPT 模型，开始对话

设置页里随时可以 **测试连接** —— 它会真的发一个小请求并回报模型名、回复与 token 用量，
用来把「凭据存在」变成「凭据能用」。

## 使用 / Usage

### 登录与账号

入口在 **设置 → ChatGPT**。同一个 provider 的卡片也会出现在 **设置 → 模型** 里，
但插件自己的页面更可靠：模型页那条路径依赖「已服务的 settings 命名空间」来 join provider 行，
命名空间出问题时那一行**不会出现也不报错**。

- **使用其他 ChatGPT 账号** —— 每个账号一条独立注册记录，互不覆盖
- **重新授权** —— 复用已签发的 client id 重走一次授权
- **退出登录** —— 撤销授权并清除本地记录
- **管理用量** —— 跳转 ChatGPT 的用量设置页
- **测试连接** —— 真的发一次请求，按名字报出账号过期、额度用尽、会话被撤销

### 模型

模型列表默认取自你的账号（`GET /v1/models`，只展示 `visibility: "list"` 的条目）。

要在选择器里出现**清单之外的**模型，显式配置即可 —— 清单外的 id 是能用的，
它只表示「账号没主动报告这个模型」：

```yaml
# profile 的 cordis.patch.yml
- id: dsh-chatgpt-provider
  name: "@bananiceee/dsh-chatgpt-provider"
  config:
    models:
      - id: gpt-6.1-sol
        name: GPT-6.1 Sol
        contextWindow: 1050000     # 建议写：压缩阈值依赖它
      - id: gpt-6-sol
        name: GPT-6 Sol
        contextWindow: 1050000
      - id: gpt-6-luna
        name: GPT-6 Luna
        contextWindow: 1050000
    testModel: gpt-6-luna          # 「测试连接」打哪个
```

`contextWindow` 建议一并声明：Harness 的上下文压缩按「窗口 × 比例」计算触发点，
provider 不报窗口时压缩无法按预期触发。GPT-6 全系是 1,050,000。

想确认某个 id 到底能不能用：

```bash
node tests/live-models.mjs gpt-6-astra
```

它会各发一个真实请求并报告结果。**只读**凭据文档，绝不刷新令牌。

### 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `displayName` | `ChatGPT` | 选择器里显示的名字 |
| `account` | 最近登录的 | 指定使用哪个已登录账号 |
| `agentName` | `DeepSeek Harness` | 授权页上显示的应用名 |
| `reasoningEfforts` | `low/medium/high/xhigh/max` | 选择器提供的推理档位 |
| `reasoningEffort` | 模型默认 | 默认档位 |
| `models` | 账号清单 | 附加/覆盖的模型条目 |
| `testModel` | 优先选含 `luna` 的 | 「测试连接」使用的模型 |
| `callbackPort` | `1455` | OAuth 回调端口 |
| `maxImageBytes` | 8 MiB | 单张图片上限 |
| `maxInlineImageBytes` | 24 MiB | 单请求图片总量上限 |

## 排障 / Troubleshooting

### 设置页里看不到 ChatGPT 卡片

先重启 Harness。浏览器那半边的模块注册表在**启动时**扫描并生成脚本表，
启动时不存在的包不会凭空出现在表里。

### 卡片在，但登录按钮点了没反应

`/chatgpt/api/status` 是**不需要登录**的自检端点，它直接回答四件事：

| 字段 | 含义 |
| --- | --- |
| `directory.routeLive` | 适配器路由注册了吗 |
| `directory.inDirectory` | provider 目录里有这条吗 |
| `settingsSectionMounted` / `settingsSectionError` | settings 命名空间注册了吗、为什么没注册 |
| `clientModule` | 浏览器半边注册了吗 |

```bash
curl -s http://127.0.0.1:<port>/chatgpt/api/status | python3 -m json.tool
```

### 出现了 `invalid_value` / 只有第一轮能跑

历史里有 assistant 回合时，文本块必须是 `output_text`，写成 `input_text` 会被 400 拒绝。
若遇到，请附上 `/chatgpt/api/status` 与错误原文提 issue。

### 提示余额或额度不足

Plus 的**五小时限额是与其它应用共享的**，本应用拿不到单独额度；Pro 不受该限制影响。
官方没有提供查询剩余额度的接口，所以卡片不显示数字，只给「管理用量」链接。

### 更新插件代码后行为没变

Node 的 ESM 模块缓存持有旧的 `lib/index.js`，在「设置 → 插件」里 toggle 只会重跑 `apply`，
不会重新读文件。**要让新代码生效必须重启应用。**

## 隐私与安全 / Privacy and security

- 令牌只落在 Harness 的凭据文档（`$DSH_HOME/.credentials.yaml`，`0600`、原子写、带文件锁），
  不写日志、不进环境变量
- 登录流程全程只与 `auth.openai.com` 和 `api.openai.com` 通信。
  令牌**不会**被发往 ChatGPT 的 `backend-api`（官方明确禁止）
- 本机 host 标识是 `urn:uuid:` 形式的固定标识符，不是凭据
- `/chatgpt/api/*` 不带额外鉴权，只监听 `127.0.0.1`。
  它暴露账号邮箱/身份与登录控制，**不含令牌本身**。本机多用户场景下应当知道这一点

## 已知限制 / Known limitations

- 依赖 Preview 能力，字段、scope 与端点可能在正式版前变化
- 共享五小时限额（Plus），无单独额度
- 不在 OpenAI 的通知范围内：用户在 ChatGPT 设置里断开应用时 OpenAI 不会通知本插件，
  要等某次请求或刷新确认失效才会发现
- 用量不显示余额（官方未提供查询接口）
- 图片有内联上限（单张 8 MiB、单请求 24 MiB），超出的图片被跳过并留下说明文字

## 更多文档 / More

| 文档 | 内容 |
| --- | --- |
| [docs/implementation.md](docs/implementation.md) | OAuth 流程、账号存储、适配器 wire format、登录入口的内部实现 |
| [docs/verification.md](docs/verification.md) | 六个测试套件各自证明什么，以及它们抓到的真实 bug |
| [docs/development.md](docs/development.md) | 构建、测试、以及两条只有真实运行才会暴露的契约约束 |

## 变更记录 / Changelog

### 未发布

- **修复：工具返回的图片不再丢失。** `function_call_output` 只接受文本，此前图片被替换为占位文字、
  模型完全看不到 —— 截图检查、网页视觉验证、Office 排版检查因此静默失效。现在图片作为紧随该输出项
  之后的 user 消息发出，复用用户上传图片的同一条路径（同样的字节上限与 data URL 拼法，
  超限同样是明确文字的占位符）。工具结果的文本内容一字不丢。

## 参考 / References

- [Sign in with ChatGPT — Overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)

## License

MIT
