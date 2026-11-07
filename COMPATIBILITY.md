# DSH 0.2.2-rc.1 compatibility investigation

This investigation starts from v0.2.3 (`74a969b42538e3a143e9b3a7fb1ccf18cdb4a98a`). The package's `engines.dsh` remains `0.2.0-rc.2 || 0.2.1-rc.5`; installing on 0.2.2-rc.1 may therefore be refused even when an isolated API test passes. No new host version or release is declared here.

## Interface scope

The quota plugin does not register model tools, construct prompts, use PTC/tools.mode, select an Agent model, or access Session/Projection APIs. Those changes in the [official release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1) do not require a migration in this plugin.

The host uses Cordis effects/service lookup, `webServer.register({ kind: 'exact', path, handler })` and its returned disposer, and the `credentials.resolve(ref)` contract. The tests exercise the official Cordis/WebServer packages and a subclass of the official `CredentialProvider` whose resolver returns synthetic credentials. They never start the local credential-store implementation or read the user's profiles.

The browser uses `__ModuleLoader__.load`, the host React instance, `slots.inject/register`, and `locale.getLocale/subscribe`. The official `dsh-client-ui-slots` 0.2.1-rc.5 and 0.2.2-rc.1 npm archives contain identical `lib/types/index.d.ts` declarations (SHA-256 `84a1395f6648420df05eee6f9e63c098fffb3fa4800ded8916971cf62b99c2c9`). Offline checks retain the slot, locale, route and error-boundary contracts. The browser UI has not been rendered in a new Desktop build.

## Results — 2026-11-07

| Test runtime | Automated results |
| --- | --- |
| Official cached 0.2.1-rc.5 host packages | `npm test`: 11/11 passed, no skips |
| Isolated official 0.2.2-rc.1 WebServer/Credentials API subset, Cordis 4.1.0 | `npm test`: 11/11 passed, no skips |
| Host-independent offline verifier | 53/53 assertions passed; live credential/vendor/host checks explicitly skipped |

The 0.2.2 test uses a successfully installed, immutable-for-the-test API subset rather than a partially installed full CLI. Both selected native host packages' manifest versions and resolver paths are asserted. No production API migration was required by these tests, and production files and the installation version gate remain unchanged.

## Reproduction

Use Node 24.15.0 and separate, task-owned runtime projects containing exact official `@deepseek-ai/dsh-host-webserver` and `@deepseek-ai/dsh-credentials` packages for each version, with their matching Cordis dependency. `DSH_TEST_RUNTIME` points at the runtime project's directory containing `node_modules`.

```powershell
$env:DSH_TEST_RUNTIME = 'C:\task\runtime-0.2.1-rc.5'
$env:DSH_TEST_VERSION = '0.2.1-rc.5'
npm test
$env:DSH_TEST_RUNTIME = 'C:\task\runtime-0.2.2-rc.1'
$env:DSH_TEST_VERSION = '0.2.2-rc.1'
npm test
npm run verify -- --offline
```

The tests require the declared SDK package versions to match `DSH_TEST_VERSION` and reject module resolution outside the selected runtime. Without `DSH_TEST_RUNTIME`, the native-host tests are explicitly skipped. `verify --offline` runs the existing 53 parser/config/client-contract assertions without reading live credentials, calling provider APIs, or probing a running DSH host.

## Validation boundaries

The added tests cover synthetic credential rotation, loopback quota responses, HTTP 401/403, malformed JSON, timeout, cache/last-good fallback, same-origin and method restrictions, native plugin restart/disposal/re-enable, draining an in-flight quota response after unload, and unloading before a late WebServer appears. Route removal is checked through HTTP 404, followed by successful re-registration without a duplicate-route error.

This is a Cordis lifecycle and native route test, not a full Desktop installation/update-manager rollback test. No genuine provider account, real session/history, user workspace, or authenticated vendor endpoint is used. No new production-code incompatibility has been established so far; runtime test results and remaining UI/update-manager limits must be considered separately from the installation version gate.
