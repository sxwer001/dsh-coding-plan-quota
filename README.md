[![English](https://img.shields.io/badge/English-README-2ea44f?style=for-the-badge)](README.md) [![简体中文](https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-README-6e7681?style=for-the-badge)](README.zh.md)

# dsh-coding-plan-quota

A **quota ring** that sits immediately to the **left of the model selector** in the DSH composer
tool row. It started as an OpenCode Go ring and now reads **any of ~15 coding plans and account
balances**, showing **one source at a time**.

- **Click** the ring to cycle that source's usage windows: **5h (`session`) → weekly → monthly**.
  A balance-only source refreshes instead of cycling.
- **Colour** by urgency: green (`<50%`) → blue (`<75%`) → orange (`<90%`) → red (`≥90%`).
- **Hover / focus** opens a card above the ring with the used percentage, the reset countdown
  (ticking every second) and every window as a bar.
- The card header carries the plugin name (`Coding Plan 额度` / `Coding Plan Quota`); the body names
  only the **current** source, as a single `额度来源 · <name> ›` row. Clicking that row
  flips the card to the **source picker**; clicking a source there switches the ring and flips back.
  The list sits behind that click on purpose — with a dozen plans configured, an always-visible list
  buries the numbers it exists to show. The picker lists only sources that can actually answer, plus
  a `显示未配置的 N 个来源` toggle that reveals the rest (naming the credential each one needs).
- A source that fails keeps showing its **last good numbers**, flagged `stale`, rather than blanking.
- The ring tints itself with DSH theme tokens, so it follows light/dark automatically, and it
  respects `prefers-reduced-motion` (no breathing animation when set).

Both the selected **source** and the selected **window** persist in `localStorage`
(`dsh-coding-plan-quota.provider`, `dsh-coding-plan-quota.window`).

## Mount point

The ring registers into the list slot **`conversation.input.right`**, which the shell renders as the
immediate previous sibling of `conversation.input.model`
(`@deepseek-ai/dsh-client-ui-conversation/lib/client.js`: the `standardControls` group renders
`renderSlot("conversation.input.right")` and then `renderSlot("conversation.input.model")`). That is
what puts it directly against the model readout without shadowing any shipped UI — the slot is
`replaceRisk: none` and empty by default.

The component is wrapped in an error boundary, so a rendering fault can only remove the ring; it can
never take down the official composer.

## Sources

`windows` sources expose usage windows; `balance` sources expose an account balance and have no reset
time. `status` describes what has actually been **confirmed on a real machine**, not what the vendor
might document.

| Source | `id` | Endpoint | Credential | Status |
| --- | --- | --- | --- | --- |
| OpenCode Go | `opencode-go` | `GET https://opencode.ai/zen/go/v1/usage` | `OPENCODE_GO_API_KEY` | **Verified live** (real key, real fetch) |
| Zhipu GLM Coding Plan | `glm` | `GET https://api.z.ai/api/monitor/usage/quota/limit` (CN: `open.bigmodel.cn` same path) | `ZHIPU_API_KEY` | Path confirmed; parser unit-tested |
| Kimi Coding Plan | `kimi` | `GET https://api.kimi.com/coding/v1/usages` | `KIMI_API_KEY` | Path confirmed; field names inferred |
| MiniMax Coding Plan | `minimax` | `GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains` (CN: `api.minimaxi.com`) | `MINIMAX_COOKIE` (**browser cookie**) | Path confirmed; needs a session cookie |
| Volcengine Ark | `ark` | **unknown — none shipped** | `ARK_API_KEY` | **Unconfigured** until you supply `endpoint` |
| Claude subscription | `claude` | `GET https://api.anthropic.com/api/oauth/usage` | `CLAUDE_CODE_OAUTH_TOKEN` | Path confirmed (403 → needs OAuth) |
| Codex / ChatGPT | `codex` | `GET https://chatgpt.com/backend-api/wham/usage` | `CHATGPT_ACCESS_TOKEN` + `CHATGPT_ACCOUNT_ID` | Host unreachable here; parser unit-tested |
| Gemini CLI | `gemini` | `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` | `GEMINI_ACCESS_TOKEN` | Host unreachable here; parser unit-tested |
| GitHub Copilot | `copilot` | `GET https://api.github.com/copilot_internal/user` | `COPILOT_API_TOKEN` | Path/TLS blocked here; parser unit-tested |
| DeepSeek balance | `deepseek` | `GET https://api.deepseek.com/user/balance` | `DEEPSEEK_API_KEY` | Path confirmed; parser unit-tested |
| Moonshot balance | `moonshot` | `GET https://api.moonshot.cn/v1/users/me/balance` | `MOONSHOT_API_KEY` | Path confirmed; parser unit-tested |
| OpenRouter balance | `openrouter` | `GET https://openrouter.ai/api/v1/credits` | `OPENROUTER_API_KEY` | Path confirmed; parser unit-tested |
| SiliconFlow balance | `siliconflow` | `GET https://api.siliconflow.cn/v1/user/info` | `SILICONFLOW_API_KEY` | Path confirmed; parser unit-tested |
| StepFun balance | `stepfun` | `GET https://api.stepfun.com/v1/accounts` | `STEPFUN_API_KEY` | Path confirmed; parser unit-tested |
| Novita balance | `novita` | `GET https://api.novita.ai/v3/user/balance` | `NOVITA_API_KEY` | Path confirmed; parser unit-tested |

Please read the Status column as a warning, not decoration:

- **There is no separate "OpenCode Zen" source.** `https://opencode.ai/zen/v1/usage` returns 404;
  Zen and Go share the `/zen/go/v1/usage` endpoint.
- **Volcengine Ark genuinely has no discoverable quota URL.** It ships with an empty endpoint and
  reports `unconfigured` with an explanatory message instead of guessing. Set
  `providers.ark.endpoint` once you know yours.
- **MiniMax wants a cookie, not an API key.** A bearer token gets
  `{"base_resp":{"status_code":1004,"status_msg":"cookie is missing, log in again"}}`.
- **GLM reports auth failures inside HTTP 200** (`{"code":401,"success":false}`), so the parser
  inspects the body and raises rather than reading empty fields as `0%`.
- **Codex and Gemini were unreachable from the machine this was built on** (`UND_ERR_CONNECT_TIMEOUT`
  against `chatgpt.com` and `cloudcode-pa.googleapis.com`), and GitHub Copilot's handshake fails
  behind a TLS-inspecting proxy (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). Their parsers are unit-tested
  against realistic payloads but have never seen a live response. If Copilot is blocked by TLS
  interception for you too, set `insecureTls: true` for that provider.
- Percentages come from either direction, so **`remaining` is inverted into `used`**. Where a vendor
  reports one window per model (GLM, Gemini), the **worst** model wins — the ring shows the number
  closest to exhaustion.

## How it works

The browser half never sees a credential. It polls a same-origin route served by the node half:

```
GET /plugins/dsh-coding-plan-quota/usage.json                 cached (60 s)
GET /plugins/dsh-coding-plan-quota/usage.json?refresh=1       bypass the cache
GET /plugins/dsh-coding-plan-quota/usage.json?provider=glm    fetch just one source
GET /plugins/dsh-coding-plan-quota/usage.json?debug=1         add resolved endpoints
```

```jsonc
{
  "ok": true,                       // true when at least one source answered
  "fetchedAt": 1791260412542,
  "defaultProvider": "opencode-go",
  "thresholds": [50, 75, 90],
  "windows": ["session", "weekly", "monthly"],
  "providers": [
    {
      "id": "opencode-go",
      "label": { "zh": "OpenCode Go", "en": "OpenCode Go" },
      "kind": "windows",            // or "balance"
      "status": "ok",               // ok | stale | error | unconfigured | disabled
      "plan": null,                 // vendor plan name when it reports one
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

Every vendor is normalised into that one shape, so the browser half knows nothing about vendors. It
only has to understand `status`, `windows` and `balances`.

Each source caches for `cacheMs` with **in-flight de-duplication** (two concurrent requests cause one
upstream call). When a refresh fails, the source is re-served from its last good payload with
`stale: true` and the failing `errorMessage` alongside it.

Requests are made with `node:http` / `node:https` rather than `fetch`, so a single source can opt out
of certificate verification via `insecureTls`. Cross-site and foreign-origin callers get `403`, and
anything but `GET`/`HEAD` gets `405`.

## Configuration

`apply(ctx, config)` merges the config over these defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `cacheMs` | `60000` | host-side cache lifetime per source |
| `timeoutMs` | `12000` | upstream request timeout |
| `thresholds` | `[50, 75, 90]` | green→blue→orange→red boundaries |
| `defaultProvider` | `"opencode-go"` | what to show when nothing is stored yet |
| `hideUnconfigured` | `false` | hide sources with no credential |
| `insecureTls` | `false` | skip certificate verification (global default) |
| `providers` | `{}` | per-source overrides, keyed by `id` |

Per-source overrides:

| Key | Meaning |
| --- | --- |
| `enabled` | `false` removes the source from the card entirely |
| `endpoint` | replace the built-in URL (this is how you enable `ark`) |
| `apiKey` | a literal key, which beats every other credential source |
| `apiKeyEnv` | read the key from this environment variable instead |
| `region` | `"cn"` switches to the vendor's mainland endpoint |
| `insecureTls` | per-source override of the global flag |

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

### Credentials

For each source, the first hit wins:

1. `providers.<id>.apiKey` in the plugin config (a literal),
2. the environment variable named by `providers.<id>.apiKeyEnv` (or the built-in name),
3. DSH's managed credential store via the `credentials` service,
4. `$DSH_HOME/.credentials.yaml`,
5. the vendor's own CLI file, when it has one.

Vendor CLI files are read for: OpenCode Go (`~/.local/share/opencode/auth.json`), Claude
(`~/.claude/.credentials.json`), Codex/ChatGPT (`~/.codex/auth.json`, both the access token and the
account id), Gemini (`~/.gemini/oauth_creds.json`) and Copilot
(`~/.config/github-copilot/hosts.json`). A credential value is **never** sent to the browser — the
route reports only `keySource`, and `scripts/verify.mjs` asserts that no key-shaped string appears in
the response.

## Installation, and one unavoidable restart

Install it from the DSH plugin market (listed under **Usage & Billing**), or from a terminal:

```bash
dsh plugin --profile web add dsh-coding-plan-quota                  # from npm
dsh plugin --profile web add github:sxwer001/dsh-coding-plan-quota  # from GitHub
```

**Restart DSH afterwards** — the box at the end of this section explains why the node half never
hot-reloads.

Manually, copy the directory into the active profile's `node_modules` and insert the row into the
profile's `cordis.patch.yml` (see [Configuration](#configuration)).

For live editing against a source checkout, a directory junction works instead of a copy:

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-coding-plan-quota" -Target "D:\Antigravityproject\dsh-coding-plan-quota"
```

A junction is invisible to the profile's `package.json`, so a later `pnpm install` in the profile may
remove it; re-create it if the ring disappears.

> **Node-half edits need a DSH restart.** The two halves reload very differently, and this was
> established experimentally:
>
> - **Config / `cordis.patch.yml` changes apply hot.** Editing the patch re-reads it and re-invokes
>   `apply(ctx, config)` immediately. (Proved by changing `thresholds` in the patch and watching the
>   route return the new array at once.)
> - **`lib/host.js` code changes do not.** The host half is imported once and that module instance is
>   kept for the life of the process. Renaming the module, repointing `main`, adding a second junction
>   to the same directory, using a subpath specifier, and toggling the plugin off/on **all failed** to
>   force a re-import; a module-scope marker injected into `lib/host.js` never fired at all while the
>   route happily kept serving the old code. Only restarting DSH picks up new node-half code.
>   (`Fiber._reload` at `@deepseek-ai/cordis/lib/index.js` re-runs the fiber; it does not re-import.)
> - **`lib/client.js` changes apply on a page refresh** (Ctrl+R), because the browser fetches the
>   bundle from disk.
>
> Because the halves reload at different times, the browser half also accepts the **pre-restart
> payload** (`{ usage: { rolling, weekly, monthly } }`) and reshapes it into a single `opencode-go`
> entry. Without that shim a refreshed page would render an empty ring against a host that had not
> been restarted yet.

## Localization

Every string follows the **live DSH UI language**, with no reload and no own setting:

- `locale.getLocale()` returns a `LocaleSnapshot` — `{ active, locales, revision }`, **not** a string.
  Reading `.active` (`"zh"` / `"en"`, per `LOCALE_IDS` in `@deepseek-ai/dsh-client-locale`) is the only
  correct way to obtain the language id; `String(snapshot)` yields `"[object Object]"` and every test
  silently fails.
- `locale.subscribe` re-renders the ring, so switching language in Settings flips the chip, the card
  and the `aria-label` at once.
- The `5h` / `1w` / `1M` chip label is deliberately language-neutral. Any locale that is not Chinese
  renders English.

## Verify

```bash
node scripts/verify.mjs        # or: pnpm verify
```

75 assertions across the provider registry, every parser, the conservative generic fallback, config
merging, the **live OpenCode Go endpoint using this machine's real credential**, the bad-key `401`
path, the running host's route plus its cross-site / foreign-origin / method hardening, and the client
half's static contract. Network-dependent checks report `NOTE … skipped` instead of failing when the
machine is offline. Exits non-zero on any failure. Point it elsewhere with
`DSH_WEB_URL=http://127.0.0.1:<port>`.

The host still serving the pre-restart payload does not fail the run: the script prints an explicit
note that a restart is needed to publish the provider registry.

## Layout

```
dsh-coding-plan-quota/
├── package.json          dsh.bundle.patch + dsh.client { platform: web }
├── cordis.patch.yml      - insert: [{ id, name }]
├── lib/
│   ├── host.js           node half — provider registry, credentials, http, cache, HTTP route
│   └── client.js         browser half — the ring, the hover card and the source picker
├── scripts/
│   └── verify.mjs        75-assertion end-to-end check
├── README.md
└── README.zh.md
```

`lib/host.js` is the package `main`. It uses `node:http` / `node:https` and reads files, so it cannot
be bundled; `lib/client.js` is hand-written with no build step and is loaded as-is.

## Known limitations

- **The generic fallback is deliberately conservative.** For a source with no dedicated parser, it
  only accepts an entry that carries a reset instant, a window name, or a used/limit pair — a bare
  percentage is not treated as evidence. It also refuses to invent windows: unnamed entries are used
  only when *nothing* in the payload could be classified, and never twice. Showing a wrong percentage
  is worse than showing none, because the ring would then colour itself off a fabricated number.
- **Volcengine Ark cannot work until you supply an endpoint.**
- Codex, Gemini and Copilot have **never been exercised against a live endpoint** here (blocked
  network / TLS interception). Expect to fix field names if a vendor has changed its payload.
- There is no screenshot-based check in the repo; the visual result can only be confirmed in the
  running GUI.
