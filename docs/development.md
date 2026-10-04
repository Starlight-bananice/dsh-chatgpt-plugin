# 开发 / Development

## 构建与测试

```bash
pnpm install
pnpm run build            # 编译 host（lib/）+ 类型检查 client
pnpm run build:client     # 只打浏览器包（tsdown → lib/client.js）
pnpm test                 # 六个套件，99 项
```

`scripts/build.sh` 会探测 Harness checkout（`DSH_CHECKOUT` 或常见路径），把插件链接进去以便
client 的 tsconfig 走 `../packages/...` 视图，并用 checkout 的 tsc 编译。

**本仓库提交 `lib/`**，与常见的「只提交源码」不同：`package.json` 的 `main` 指向
`./lib/index.js`，而 `build.sh` 需要一个完整的 Harness checkout —— 没有 `lib/` 的 clone
**根本装不上**。改完 `src/` 记得跑一次 `pnpm run build` 再提交，否则仓库里的产物会落后于源码。

CI 跑测试套件（它们导入**已提交的** `lib/`，不是现场构建），因此 CI **同时**是对发布产物的检查。
反过来说：只改 `src/` 而忘记重新构建，测试仍会对着旧的 `lib/` 通过 —— 这条只能靠人记住。

## 两条隐性契约

这两条都不是「写错了函数名」，而是**版本 / 命名约定与另一处代码之间的隐性契约**，
而且**失败时完全不报错**。改动相关代码前值得先读。

### 1. `settings` 服务在 0.2 没有 `register`，且地址必须是 profile 条目 id

0.1.x 的 settings 是「插件注册一个自己的命名空间」，0.2.x 完全改了：

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
- 模型页拿 provider 目录和「已服务的 settings 条目」做 join → **建不出这一行**
- 而 `settings.models.provider-card` 扩展区在**没有注册者时就是渲染空**，也不报错
- 结果：路由活着、目录里有、卡片代码也加载了，**界面上什么都没有**

现在两处都对齐到 `dsh-chatgpt-provider`：目录条目的 `settingsNs`、客户端注册的 `key`、
以及 `describe()` 查的 id 必须是同一个字符串。`cordis.patch.yml` 里那个 `id:` 就是它。

**还有一层**：bundle `insert:` 进去的行与 profile patch 直接声明的行，寻址拼写不同
（`include:<id>` 与 `<id>`）。猜错同样是静默失败。

所以插件不再猜：它在挂载时问 `settings.describe()` 实际服务了哪些名字，按候选顺序取第一个
命中的，一个都没有时就把**服务实际提供的名字全列出来**，让不匹配变得可读。诊断字段：
`settingsSettingsNamespace`（本插件声明的）与 `settingsNamespaces`（服务提供的全部）。

### 2. 清单外的模型 id 是能用的 —— 清单只是「账号报告了什么」

`GET /v1/models` 对这个账号实际返回 7 条，其中 2 条 `visibility: "hide"`：

| id | visibility |
| --- | --- |
| gpt-6-astra / gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / gpt-5.5 | `list` → 展示 |
| gpt-reserve / codex-auto-review | `hide` → 不展示 |

按官方文档只展示 `visibility == "list"`，所以显示 5 个是**正确**的。Codex 那边能看到
`GPT-6.1 Sol` / `GPT-6 Sol` / `GPT-6 Luna`，是因为它用的是**自带的静态目录** —— 官方文档原文：
「如果使用 Codex app-server，它的 `model/list` RPC 可能使用**内置或缓存的目录**；
当你的 UI 需要当前账号的模型选择时，请使用上面的请求。」

**但这不等于它们不能用。** 实测（各发一个真实请求）：

```
gpt-6-luna    unlisted  OK  reply="ok"
gpt-6-sol     unlisted  OK  reply="ok"
gpt-6.1-sol   unlisted  OK  reply="ok"
gpt-5.6-luna  listed    OK  reply="ok"
```

所以策略是：**默认不展示清单没有的模型**（展示一个用不了的模型比不展示更糟），
但**显式配置就会出现**。配置方法见 [README](../README.md#模型)。

## `live-models.mjs` 的只读约束

它**只读**凭据文档，绝不刷新令牌：刷新会轮换那个一次性 refresh token，在凭据服务的锁之外做
可能作废正在运行的实例手里的值。令牌过期时它会拒绝运行，并让你先在界面上刷新。
