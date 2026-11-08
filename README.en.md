# DSH provider quota

English · [中文](README.md)

Provider-wide rolling quotas, early context compaction, and a native settings page for DeepSeek Harness 0.2.2. Requires Node.js 24.9 or later. All models and sessions of a configured provider share RPM, input-plus-output TPM, and rolling seven-day token accounting. Requests serialize through a maintained cross-process file lock. DSH's official retry plugin owns transient recovery; each streaming waterfall calls `next()` once.

## Install

Install the repository URL from DSH's plugin manager or run:

```sh
dsh plugin --profile web add github:Fulisike/dsh-provider-quota#main
```

The committed ESM bundle includes runtime dependencies and needs no installation build step or nested dependency links. Restart DSH and refresh the browser after installation. Open Settings → Provider quotas, select a provider already configured in Models, then save the desired limits. No providers are limited until configured. Use the Desktop application's own plugin manager for its reserved profile. From a DSH checkout, substitute `pnpm dsh` for `dsh`.

For a local clone, run `npm install --omit=dev --ignore-scripts`, then `dsh plugin --profile web add .` from its directory. The repository contains no credentials, sessions, or personal accounting data.

## Request budgets

The default rolling limits are 10 requests per minute, 300000 input-plus-output tokens per minute, and 1000000000 tokens per seven days. Requests start at least 7000 ms apart, with one request in flight per provider. Input estimates start with a 1.25 safety factor and calibrate upward from actual provider usage. Cached input is counted; reasoning is not added twice. Missing usage retains the reservation.

The plugin budgets the full estimated input, maximum output, and 4096 tokens of headroom. It preserves history when one request fits, waits when only the rolling window is full, and invokes native compaction when one request cannot fit. Web resolves the backend from the Agent's bound preset; headless uses its own context service. Local oversize recovery runs at most once per step. Main requests default to a 16384-token output cap; settlement uses actual provider usage.

The optional fixed early-compaction threshold lives in Advanced settings and defaults to `-1`, meaning budget-driven compaction only. Disabling plugin compaction leaves DSH's native pressure policy and `/compact` available. A single oversized retained input or fixed prompt can remain uncompactable and needs splitting. Summary requests pass the same shared quota checks. Summary output follows the native backend configuration; a profile-level `compaction-basic` override does not modify an independent backend inside a Web preset.

## Common and advanced settings

The default page shows the three shared quotas, maximum output, automatic compaction, idle wait, and retry count. Each quota accepts `-1` for no limit; `0` is invalid. Maximum output stays positive for pre-dispatch reservation. Disabling one quota leaves other limits, cross-process serialization, and provider 429 cooldown intact.

Advanced settings retain send spacing (7000 ms), fixed compaction threshold (`-1`), request headroom (4096 tokens), input safety factor (1.25), window margin (250 ms), queue polling (500 ms), and minimum 429 cooldown (60000 ms). Send spacing also accepts `-1` for no extra interval. Threshold `-1` disables the fixed threshold while budget compaction remains available. Headroom, safety factor, polling, cooldown, timeouts, and retries do not accept `-1`; retry count `0` disables failure recovery.

Suggested connection values are 900 seconds idle wait, 1800 seconds request wait, and 12 bounded retries. Seconds support 3 decimal places and remain stored as integer milliseconds. Initial/max backoff and jitter remain in Advanced settings. Saving uses normal recovery and preserves retry codes. Quotas and connection settings are separate revision-fenced writes; partial acceptance is reported explicitly. Active requests retain captured settings.

## State and limitations

Accounting lives under `$DSH_HOME/storages/provider-quota`, defaulting to `~/.dsh/storages/provider-quota`. `stateDirectory` can select another absolute directory. Processes using the same directory share locks; cross-process FIFO is not guaranteed. The ledger is atomically saved before dispatch and after settlement. Corrupt state blocks requests. Unknown usage after a crash remains reserved. Disabling the plugin does not delete accounting.

Token windows conservatively start at settlement; request windows start at dispatch. Other machines, other applications, and unrecorded pre-installation usage cannot be counted. Local estimates cannot exactly reproduce the provider's tokenizer or quota rules, so upstream 429s remain possible. Weekly exhaustion stops with the earliest partial release time. Admission waits cancel immediately; in-flight transport follows the caller's cancellation signal and adapter timeout, and disposal waits for settlement.

## Verify

```sh
npm install --ignore-scripts
npm run build
npm test
npm pack --dry-run
```

After changing `index.js` or `config.js`, run `npm run build` and commit `dist/index.js` and `THIRD_PARTY_NOTICES.txt`. Package tests copy the release files into a temporary directory without dependencies, then run the same behavior tests against the exported entry.

For local-HTTP integration, set `DSH_SOURCE_ROOT` to a built DSH checkout and run `npm run test:integration`. It exercises headless 429 recovery, durable attempts/retries, accounting, and the wire output cap. `npm run test:web` tests a real Web standard-mode reply and an oversized request that compacts through an isolated native backend before replying. `npm run test:git-install` installs a disposable Git repository through DSH's pnpm, verifies native settings writes, then runs both integrations against the installed entry. These tests contact only local fake services.

## Upgrade from 2.0.x

Run the install command again and restart DSH. Existing quotas, ledgers, and explicit early-compaction thresholds remain. New configurations default to budget-driven compaction; set the advanced fixed threshold to `-1` for that behavior on existing configurations. Web compaction uses the preset service API and no longer requires the Agent's root context to provide the backend. MIT licensed.
