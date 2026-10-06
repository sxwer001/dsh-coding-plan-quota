[![English](https://img.shields.io/badge/English-README-6e7681?style=for-the-badge)](README.md) [![简体中文](https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-README-0969da?style=for-the-badge)](README.zh.md)

# dsh-coding-plan-quota

DSH 输入框工具行里的一个额度圆环，就在模型选择器的左侧。它读取你的 coding plan 用量窗口或账户余额，**同时只显示一个来源**。

- **点击**圆环循环切换该来源的窗口：**5 小时 → 每周 → 每月**。纯余额类来源改为刷新。
- **按紧急程度着色**：绿 `<50%` → 蓝 `<75%` → 橙 `<90%` → 红 `≥90%`。
- **悬停**可看到已用百分比、实时重置倒计时，以及每个窗口的进度条。
- 卡片用一行 `额度来源 · <名称> ›` 标出当前来源。点它即可切换——选择页只列**能真正答上来**的来源，其余收在开关后面。
- 采集失败的来源会保留上一次成功的数字并标记 `stale`，而不是变成空白。

所选来源与窗口都会持久化在 `localStorage`。

## 截图

![额度卡片](assets/screenshot-1-card.png)
![来源选择](assets/screenshot-2-picker.png)

## 安装

从 DSH 插件市场安装（分类 **Usage & Billing**），或在终端里直接装：

```bash
dsh plugin --profile web add dsh-coding-plan-quota                  # npm
dsh plugin --profile web add github:sxwer001/dsh-coding-plan-quota  # GitHub
```

装完请重启 DSH。

若要对着源码目录边改边调，用目录联接（junction）代替拷贝：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-coding-plan-quota" -Target "D:\Antigravityproject\dsh-coding-plan-quota"
```

## 来源

| 来源 | `id` | 凭据 | 说明 |
| --- | --- | --- | --- |
| OpenCode Go | `opencode-go` | `OPENCODE_GO_API_KEY` | 5 小时 / 每周 / 每月 |
| 智谱 GLM | `glm` | `ZHIPU_API_KEY` | 5 小时 / 每周；`region: cn` 走 `open.bigmodel.cn` |
| Kimi | `kimi` | `KIMI_API_KEY` | |
| MiniMax | `minimax` | `MINIMAX_COOKIE` | 要浏览器会话 Cookie，不是 API key |
| 火山方舟 | `ark` | `ARK_API_KEY` | 没有公开额度地址——请自行填 `endpoint` |
| Claude 订阅 | `claude` | `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token，不是 API key |
| Codex / ChatGPT | `codex` | `CHATGPT_ACCESS_TOKEN` + `CHATGPT_ACCOUNT_ID` | `chatgpt.com` 在部分网络下不可达 |
| Gemini CLI | `gemini` | `GEMINI_ACCESS_TOKEN` | `cloudcode-pa.googleapis.com` 在部分网络下不可达 |
| GitHub Copilot | `copilot` | `COPILOT_API_TOKEN` | 若 TLS 代理拦握手，请设 `insecureTls: true` |
| DeepSeek 余额 | `deepseek` | `DEEPSEEK_API_KEY` | 仅余额 |
| Moonshot 余额 | `moonshot` | `MOONSHOT_API_KEY` | 仅余额 |
| OpenRouter 余额 | `openrouter` | `OPENROUTER_API_KEY` | 仅余额 |
| 硅基流动余额 | `siliconflow` | `SILICONFLOW_API_KEY` | 仅余额 |
| 阶跃星辰余额 | `stepfun` | `STEPFUN_API_KEY` | 仅余额 |
| Novita 余额 | `novita` | `NOVITA_API_KEY` | 仅余额 |

没有凭据的来源只会说明它需要哪一个。厂商按 `remaining` 报的百分比会被反相成 `used`；当套餐按模型各报一个窗口时（GLM、Gemini），取最差的那个。

## 配置

`apply(ctx, config)` 会把配置合并到这些默认值之上：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `cacheMs` | `60000` | 每个来源的宿主侧缓存时长 |
| `timeoutMs` | `12000` | 上游请求超时 |
| `thresholds` | `[50, 75, 90]` | 绿 → 蓝 → 橙 → 红的分界 |
| `defaultProvider` | `"opencode-go"` | 还没选择时显示哪个 |
| `hideUnconfigured` | `false` | 隐藏没有凭据的来源 |
| `insecureTls` | `false` | 跳过证书校验 |
| `providers` | `{}` | 按 `id` 索引的单来源覆盖项 |

单来源覆盖项：

| 键 | 含义 |
| --- | --- |
| `enabled` | 设为 `false` 会把该来源从卡片里移除 |
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
        thresholds: [50, 75, 90]
        defaultProvider: opencode-go
        providers:
          ark:
            endpoint: "https://<your-ark-quota-url>"
```

### 凭据

对每个来源，先命中者胜：`providers.<id>.apiKey` → `providers.<id>.apiKeyEnv` 指名的环境变量（或内置名称）→ DSH 的 `credentials` 服务 → `$DSH_HOME/.credentials.yaml` → 该厂商自己 CLI 的凭据文件（OpenCode、Claude、Codex、Gemini、Copilot 有）。

凭据只在宿主半边读取，绝不送到浏览器。

## 说明

- 卡片跟随 DSH 当前 UI 语言（中 / 英）实时切换，自身没有语言设置。
- 浏览器半边读取宿主半边的同源路由：`/plugins/dsh-coding-plan-quota/usage.json`（支持 `?refresh=1`、`?provider=<id>`、`?debug=1`）。
- 改 `lib/host.js` 需要重启 DSH；改 `lib/client.js` 只需刷新页面。
- `node scripts/verify.mjs` 跑端到端检查。

## 目录结构

```
dsh-coding-plan-quota/
├── package.json          dsh.bundle.patch + dsh.client { platform: web }
├── cordis.patch.yml      - insert: [{ id, name }]
├── lib/
│   ├── host.js           宿主半边——来源、凭据、缓存、HTTP 路由
│   └── client.js        浏览器半边——圆环、卡片与来源选择
├── scripts/
│   └── verify.mjs        端到端检查
├── README.md
└── README.zh.md
```

## 许可

MIT
