[![English](https://img.shields.io/badge/English-README-6e7681?style=for-the-badge)](README.md) [![简体中文](https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-README-0969da?style=for-the-badge)](README.zh.md)

# dsh-coding-plan-quota

一个**额度圆环**，就贴在 DSH 输入框工具行里**模型选择器的左侧**。它最初只为 OpenCode Go 而生，现在能读取**约 15 个 coding plan 与账户余额**，且**同时只显示一个来源**。

- **点击**圆环即可循环切换该来源的用量窗口：**5 小时（`session`）→ 每周 → 每月**。纯余额类来源改为刷新。
- **按紧急程度着色**：绿（`<50%`）→ 蓝（`<75%`）→ 橙（`<90%`）→ 红（`≥90%`）。
- **悬停 / 聚焦**会在圆环上方弹出一张卡片，显示已用百分比、重置倒计时（每秒跳动）以及各窗口的进度条。
- 卡片标题是插件名（`Coding Plan 额度` / `Coding Plan Quota`），正文只点出**当前**来源——就是一行 `额度来源 · <名称> ›`。点这一行，卡片翻到**来源选择页**；在那里点某个来源即可切换圆环并翻回主页。把列表藏在一次点击之后是刻意的：当配置了十来个套餐时，常驻的列表会把「它本来要展示的数字」埋掉。选择页默认只列**能真正答上来**的来源，另有一个 `显示未配置的 N 个来源` 开关，展开后才显示其余来源（并注明各自需要的凭据）。
- 采集失败的来源会继续显示**上一次成功的数字**并标记 `stale`，而不是变成空白。
- 圆环用 DSH 主题 token 着色，因此自动跟随明暗主题，并且尊重 `prefers-reduced-motion`（开启时不播放呼吸动画）。

所选**来源**与所选**窗口**都会持久化在 `localStorage`（`dsh-coding-plan-quota.provider`、`dsh-coding-plan-quota.window`）。

## 挂载点

圆环注册进列表槽 **`conversation.input.right`**，外壳把它渲染成 `conversation.input.model` 的**紧邻前一个兄弟节点**（见 `@deepseek-ai/dsh-client-ui-conversation/lib/client.js`：`standardControls` 分组先渲染 `renderSlot("conversation.input.right")`，再渲染 `renderSlot("conversation.input.model")`）。这正是它紧贴模型读数、又不遮蔽任何官方 UI 的原因——该槽位 `replaceRisk: none`，且默认空置。

组件外面包了一层错误边界，所以渲染出错最坏也只是圆环自己消失，绝不会把官方输入框拖下水。

## 来源

`windows` 类来源提供用量窗口；`balance` 类来源提供账户余额，没有重置时间。`status` 一列描述的是**在真实机器上实际确认过**的程度，而不是厂商文档里写了什么。

| 来源 | `id` | 接口 | 凭据 | 状态 |
| --- | --- | --- | --- | --- |
| OpenCode Go | `opencode-go` | `GET https://opencode.ai/zen/go/v1/usage` | `OPENCODE_GO_API_KEY` | **真机验证通过**（真密钥、真请求） |
| 智谱 GLM Coding Plan | `glm` | `GET https://api.z.ai/api/monitor/usage/quota/limit`（国内：`open.bigmodel.cn` 同路径） | `ZHIPU_API_KEY` | 路径已确认；解析器单测 |
| Kimi Coding Plan | `kimi` | `GET https://api.kimi.com/coding/v1/usages` | `KIMI_API_KEY` | 路径已确认；字段名是推断的 |
| MiniMax Coding Plan | `minimax` | `GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains`（国内：`api.minimaxi.com`） | `MINIMAX_COOKIE`（**浏览器 Cookie**） | 路径已确认；需要会话 Cookie |
| 火山方舟 | `ark` | **未知——未内置** | `ARK_API_KEY` | 在你填入 `endpoint` 之前一直显示**未配置** |
| Claude 订阅 | `claude` | `GET https://api.anthropic.com/api/oauth/usage` | `CLAUDE_CODE_OAUTH_TOKEN` | 路径已确认（403 → 需要 OAuth） |
| Codex / ChatGPT | `codex` | `GET https://chatgpt.com/backend-api/wham/usage` | `CHATGPT_ACCESS_TOKEN` + `CHATGPT_ACCOUNT_ID` | 本机网络不通；解析器单测 |
| Gemini CLI | `gemini` | `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` | `GEMINI_ACCESS_TOKEN` | 本机网络不通；解析器单测 |
| GitHub Copilot | `copilot` | `GET https://api.github.com/copilot_internal/user` | `COPILOT_API_TOKEN` | 本机路径/TLS 受阻；解析器单测 |
| DeepSeek 余额 | `deepseek` | `GET https://api.deepseek.com/user/balance` | `DEEPSEEK_API_KEY` | 路径已确认；解析器单测 |
| Moonshot 余额 | `moonshot` | `GET https://api.moonshot.cn/v1/users/me/balance` | `MOONSHOT_API_KEY` | 路径已确认；解析器单测 |
| OpenRouter 余额 | `openrouter` | `GET https://openrouter.ai/api/v1/credits` | `OPENROUTER_API_KEY` | 路径已确认；解析器单测 |
| 硅基流动余额 | `siliconflow` | `GET https://api.siliconflow.cn/v1/user/info` | `SILICONFLOW_API_KEY` | 路径已确认；解析器单测 |
| 阶跃星辰余额 | `stepfun` | `GET https://api.stepfun.com/v1/accounts` | `STEPFUN_API_KEY` | 路径已确认；解析器单测 |
| Novita 余额 | `novita` | `GET https://api.novita.ai/v3/user/balance` | `NOVITA_API_KEY` | 路径已确认；解析器单测 |

请把「状态」一列当作警告来读，而不是装饰：

- **不存在独立的「OpenCode Zen」来源。** `https://opencode.ai/zen/v1/usage` 返回 404；Zen 与 Go 共用 `/zen/go/v1/usage`。
- **火山方舟确实没有可查到的额度地址。** 它内置的 endpoint 是空的，会如实报 `unconfigured` 并给出说明，而不是瞎猜。等你知道了自己的地址，填 `providers.ark.endpoint` 即可。
- **MiniMax 要的是 Cookie，不是 API key。** 只发 Bearer token 会得到
  `{"base_resp":{"status_code":1004,"status_msg":"cookie is missing, log in again"}}`。
- **GLM 会在 HTTP 200 里报鉴权失败**（`{"code":401,"success":false}`），所以解析器会检查响应体并抛出错误，而不是把空字段当成 `0%`。
- **Codex 和 Gemini 在构建这台机器上根本连不通**（对 `chatgpt.com` 与 `cloudcode-pa.googleapis.com` 均 `UND_ERR_CONNECT_TIMEOUT`），GitHub Copilot 的握手也会被 TLS 中间人代理挡掉（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）。它们的解析器只针对真实感较强的载荷做过单测，从未见过活的响应。如果你的网络同样被 TLS 拦截挡住 Copilot，为该来源设置 `insecureTls: true`。
- 百分比可能来自两个方向，所以 **`remaining` 会被反相成 `used`**。当厂商按模型各报一个窗口时（GLM、Gemini），取**最差**的那个模型——圆环显示的是最接近耗尽的数字。

## 工作原理

浏览器半边永远看不到凭据。它轮询由宿主半边提供的同源路由：

```
GET /plugins/dsh-coding-plan-quota/usage.json                 cached (60 s)
GET /plugins/dsh-coding-plan-quota/usage.json?refresh=1       bypass the cache
GET /plugins/dsh-coding-plan-quota/usage.json?provider=glm    fetch just one source
GET /plugins/dsh-coding-plan-quota/usage.json?debug=1         add resolved endpoints
```

```jsonc
{
  "ok": true,                       // 至少有一个来源给出了应答时为 true
  "fetchedAt": 1791260412542,
  "defaultProvider": "opencode-go",
  "thresholds": [50, 75, 90],
  "windows": ["session", "weekly", "monthly"],
  "providers": [
    {
      "id": "opencode-go",
      "label": { "zh": "OpenCode Go", "en": "OpenCode Go" },
      "kind": "windows",            // 或 "balance"
      "status": "ok",               // ok | stale | error | unconfigured | disabled
      "plan": null,                 // 厂商自报的套餐名（若有）
      "windows": {
        "session": { "percent": 0, "resetsAt": "2026-10-06T09:14:11.790Z", "status": "ok" },
        "weekly":  { "percent": 0, "resetsAt": "2026-10-12T00:00:00.000Z", "status": "ok" },
        "monthly": { "percent": 2, "resetsAt": "2026-10-29T07:02:24.000Z", "status": "ok" }
      },
      "balances": null,
      "keySource": "credentials-file:…",
      "stale": false,
      "cacheAgeMs": 0
    }
  ]
}
```

所有厂商都会被归一到这同一个形状，因此浏览器半边完全不认识厂商。它只需要理解 `status`、`windows` 与 `balances`。

每个来源按 `cacheMs` 缓存，并做**并发去重**（两个并发的请求只会触发一次上游调用）。刷新失败时，该来源会继续用上一次成功的载荷应答，附带 `stale: true` 与失败的 `errorMessage`。

请求走 `node:http` / `node:https` 而不是 `fetch`，这样单个来源可以通过 `insecureTls` 放弃证书校验。跨站与外来 Origin 的调用者得到 `403`，非 `GET`/`HEAD` 得到 `405`。

## 配置

`apply(ctx, config)` 会把配置合并到这些默认值之上：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `cacheMs` | `60000` | 每个来源的宿主侧缓存时长 |
| `timeoutMs` | `12000` | 上游请求超时 |
| `thresholds` | `[50, 75, 90]` | 绿→蓝→橙→红的分界 |
| `defaultProvider` | `"opencode-go"` | 还没有存储选择时显示哪个 |
| `hideUnconfigured` | `false` | 隐藏没有凭据的来源 |
| `insecureTls` | `false` | 跳过证书校验（全局默认） |
| `providers` | `{}` | 按 `id` 索引的单来源覆盖项 |

单来源覆盖项：

| 键 | 含义 |
| --- | --- |
| `enabled` | 设为 `false` 会把该来源从卡片里彻底移除 |
| `endpoint` | 替换内置地址（这也是启用 `ark` 的方式） |
| `apiKey` | 直接写字面量密钥，优先级高于其他所有凭据来源 |
| `apiKeyEnv` | 改为从这个环境变量读取密钥 |
| `region` | `"cn"` 切换到该厂商的国内地址 |
| `insecureTls` | 单来源覆盖全局开关 |

```yaml
- insert:
    - id: coding-plan-quota
      name: dsh-coding-plan-quota
      config:
        cacheMs: 60000
        timeoutMs: 12000
        thresholds: [50, 75, 90]
        defaultProvider: opencode-go
        providers:
          opencode-go:
            enabled: true
          deepseek:
            enabled: true
          ark:
            endpoint: "https://<your-ark-quota-url>"
```

### 凭据

对每个来源，先命中者胜：

1. 插件配置里的 `providers.<id>.apiKey`（字面量），
2. `providers.<id>.apiKeyEnv` 指名的环境变量（或内置名称），
3. 通过 `credentials` 服务读取 DSH 托管的凭据库，
4. `$DSH_HOME/.credentials.yaml`，
5. 该厂商自己 CLI 的凭据文件（若存在）。

会去读的厂商 CLI 文件：OpenCode Go（`~/.local/share/opencode/auth.json`）、Claude（`~/.claude/.credentials.json`）、Codex/ChatGPT（`~/.codex/auth.json`，同时取 access token 与 account id）、Gemini（`~/.gemini/oauth_creds.json`）与 Copilot（`~/.config/github-copilot/hosts.json`）。凭据的**取值绝不会**送到浏览器——路由只回报 `keySource`，并且 `scripts/verify.mjs` 会断言响应里不出现任何形似密钥的字符串。

## 安装，以及一次无法绕过的重启

可以从 DSH 插件市场安装（归在 **Usage & Billing** 分类下），也可以在终端里直接装：

```bash
dsh plugin --profile web add dsh-coding-plan-quota                  # from npm
dsh plugin --profile web add github:sxwer001/dsh-coding-plan-quota  # from GitHub
```

**装完请重启 DSH**——本节末尾的方框解释了为什么宿主半边永远不会热重载。

手动安装的话，把目录拷进当前 profile 的 `node_modules`，再把对应的一行插入该 profile 的 `cordis.patch.yml`（见[配置](#配置)）。

若要对着源码目录边改边调，用目录联接（junction）代替拷贝：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-coding-plan-quota" -Target "D:\Antigravityproject\dsh-coding-plan-quota"
```

联接对 profile 的 `package.json` 不可见，所以之后在该 profile 里跑 `pnpm install` 可能把它删掉；圆环消失时重建即可。

> **改宿主半边必须重启 DSH。** 两个半边重载方式完全不同，以下是实验得出的结论：
>
> - **配置 / `cordis.patch.yml` 的改动能热生效。** 改动补丁文件会立刻被重新读取并重新调用 `apply(ctx, config)`。（验证方式：改补丁里的 `thresholds`，路由立刻回传了新数组。）
> - **`lib/host.js` 的代码改动不会。** 宿主半边只在启动时被 import 一次，那个模块实例会一直保留到进程结束。改名模块、改 `main` 指向、往同一目录再加一个联接、使用子路径说明符、把插件关掉再打开——**全部无效**；往 `lib/host.js` 顶注入的模块级探针一次都没触发，而路由照旧服务旧代码。只有重启 DSH 才会加载新的宿主半边代码。
>   （`@deepseek-ai/cordis/lib/index.js` 里的 `Fiber._reload` 只是重跑 fiber，不会重新 import。）
> - **`lib/client.js` 的改动刷新页面（Ctrl+R）即生效**，因为浏览器是从磁盘取这个 bundle 的。
>
> 正因为两个半边重载时机不同，浏览器半边也接受**重启前的载荷**（`{ usage: { rolling, weekly, monthly } }`）并把它重塑成一个 `opencode-go` 条目。没有这层兼容，刷新后的页面会在还没重启的宿主上渲染出一个空圆环。

## 本地化

所有文案都跟随 **DSH 当前的 UI 语言**，无需刷新，也没有自己的语言设置：

- `locale.getLocale()` 返回的是 `LocaleSnapshot`——`{ active, locales, revision }`，**不是字符串**。唯一正确的语言 id 取法是读 `.active`（`"zh"` / `"en"`，见 `@deepseek-ai/dsh-client-locale` 的 `LOCALE_IDS`）；`String(snapshot)` 会得到 `"[object Object]"`，让所有语言判断静默失效。
- `locale.subscribe` 会触发圆环重绘，因此在设置里切换语言时，圆环中心标签、卡片与 `aria-label` 会同时跟着变。
- `5h` / `1w` / `1M` 这个中心标签刻意保持语言中立。任何非中文的语言都渲染英文。

## 验证

```bash
node scripts/verify.mjs        # or: pnpm verify
```

共 75 条断言，覆盖来源注册表、每个解析器、保守的通用兜底、配置合并、**用本机真实凭据打 OpenCode Go 的在线接口**、坏密钥的 `401` 分支、运行中宿主的自建路由及其跨站 / 外来 Origin / 方法硬化，以及浏览器半边的静态契约。依赖网络的检查在机器离线时会报 `NOTE … skipped` 而不是失败。任何一条失败都会以非零码退出。要指向别处就设 `DSH_WEB_URL=http://127.0.0.1:<port>`。

宿主仍在服务重启前的载荷不会让这次运行失败：脚本会明确打印一条提示，说明需要重启才能发布来源注册表。

## 目录结构

```
dsh-coding-plan-quota/
├── package.json          dsh.bundle.patch + dsh.client { platform: web }
├── cordis.patch.yml      - insert: [{ id, name }]
├── lib/
│   ├── host.js           宿主半边——来源注册表、凭据、http、缓存、HTTP 路由
│   └── client.js        浏览器半边——圆环、悬浮卡片与来源选择
├── scripts/
│   └── verify.mjs        75 条断言的端到端检查
├── README.md
└── README.zh.md
```

`lib/host.js` 是本包的 `main`。它使用 `node:http` / `node:https` 并读取文件，因此无法被打包；`lib/client.js` 全手写、无构建步骤，按原样加载。

## 已知限制

- **通用兜底是刻意保守的。** 对于没有专用解析器的来源，它只接受同时带有重置时间、窗口名或 used/limit 配对的条目——孤零零一个百分比不会被当作证据。它也拒绝凭空造窗口：未命名的条目只在**整个载荷都无法归类**时才会被使用，而且绝不重复使用。显示一个错误的百分比比不显示更糟，因为圆环会照着这个编造出来的数字给自己上色。
- **火山方舟在你填入 endpoint 之前无法工作。**
- Codex、Gemini 与 Copilot 在这里**从未被真正跑通过一次在线接口**（网络不通 / TLS 拦截）。如果厂商改过载荷，请做好修字段名的准备。
- 仓库里没有基于截图的检查；视觉效果只能在运行中的 GUI 里确认。
