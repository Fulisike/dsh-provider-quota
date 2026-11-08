# DSH provider quota

English · [中文](README.md)

Provider-wide rolling quotas, early context compaction, and a native settings page for DeepSeek Harness 0.2.2. Requires Node.js 24.9 or later. All models and sessions of a configured provider share RPM, input-plus-output TPM, and rolling seven-day token accounting. Requests serialize through a maintained cross-process file lock. DSH's official retry plugin owns transient recovery; each streaming waterfall calls `next()` once.

## Install

Upload this repository to GitHub, then install its URL from DSH's plugin manager or run:

```sh
dsh plugin --profile web add github:Fulisike/dsh-provider-quota
```

The committed JavaScript needs no build step. Restart DSH and refresh the browser after installation. Open Settings → Provider quotas, select a provider already configured in Models, then save the desired limits. No providers are limited until configured. Use the Desktop application's own plugin manager for its reserved profile. From a DSH checkout, substitute `pnpm dsh` for `dsh`.

For a local clone, run `npm install --omit=dev --ignore-scripts`, then `dsh plugin --profile web add .` from its directory. The repository contains no credentials, sessions, or personal accounting data.

## Request budgets

The default rolling limits are 10 requests per minute, 300000 input-plus-output tokens per minute, and 1000000000 tokens per seven days. Requests start at least 7000 ms apart, with one request in flight per provider. Input estimates start with a 1.25 safety factor and calibrate upward from actual provider usage. Cached input is counted; reasoning is not added twice. Missing usage retains the reservation.

The default early-compaction threshold is 180000 tokens, independent of a model's larger context window. The bundle configures the official compaction backend to reserve at most 8192 output tokens for summaries. Main requests default to a 16384-token output cap and leave 4096 tokens of extra request headroom. An oversized local request receives at most one additional compaction recovery per step. Single oversized inputs still need splitting; the plugin does not silently truncate history. Waiting another minute cannot reduce the size of one oversized request.

The GUI edits every quota field, the compaction threshold, output cap, safety factor, timing margins, and the selected pi-ai provider's idle timeout, SDK timeout, retry count, backoff, and jitter. Suggested connection values are 15-minute idle timeout, 30-minute SDK timeout, and 12 bounded retries. Saving uses normal recovery and preserves configured retry codes. Quotas and connection settings are separate revision-fenced writes; partial acceptance is reported explicitly. Active requests retain captured settings.

## State and limitations

Accounting lives under `$DSH_HOME/storages/provider-quota`, defaulting to `~/.dsh/storages/provider-quota`. `stateDirectory` can select another absolute directory. Processes using the same directory share locks; cross-process FIFO is not guaranteed. The ledger is atomically saved before dispatch and after settlement. Corrupt state blocks requests. Unknown usage after a crash remains reserved. Disabling the plugin does not delete accounting.

Token windows conservatively start at settlement; request windows start at dispatch. Other machines, other applications, and unrecorded pre-installation usage cannot be counted. Local estimates cannot exactly reproduce the provider's tokenizer or quota rules, so upstream 429s remain possible. Weekly exhaustion stops with the earliest partial release time. Admission waits cancel immediately; in-flight transport follows the caller's cancellation signal and adapter timeout, and disposal waits for settlement.

## Verify

```sh
npm install --ignore-scripts
npm test
npm pack --dry-run
```

For the optional local-HTTP integration test, set `DSH_SOURCE_ROOT` to a built DSH checkout and run `npm run test:integration`. It exercises the supported headless launcher, a simulated 429 followed by success, durable attempts/retries, accounting, and the wire output cap. It does not contact a real model provider. MIT licensed.
