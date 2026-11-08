/** Disposable Web fixture for manual GUI verification; it never calls a real provider. */
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
const root = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
const home = await mkdtemp(join(tmpdir(), 'dsh-quota-ui-'))
const patch = join(home, 'ui.patch.json')
const environment = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_QUOTA_GUI_TEST: 'fake-key-for-local-ui' }
const init = spawnSync(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', '--dump-config'], {
  cwd: root, env: environment, windowsHide: true, stdio: 'ignore', timeout: 30000,
})
if (init.status !== 0) throw new Error('Could not initialize the disposable Web profile')
await writeFile(join(home, 'profiles/web/cordis.patch.yml'), JSON.stringify([
  { id: 'llm-pi-ai', config: { providers: { sjtu: {
    api: 'openai-completions', apiKeyEnv: 'DSH_QUOTA_GUI_TEST', baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'quota-test', name: 'quota-test', contextWindow: 1000000 }],
    timeoutMs: 1800000, streamIdleTimeoutMs: 900000,
    retryPolicy: { mode: 'normal', maxRetries: 12, backoff: { initialDelayMs: 10000, maxDelayMs: 300000, jitterRatio: 0.2 } },
  } } } },
  { id: 'ui-settings-general', config: { welcomeNoticeVersion: '2026-09-28.1' } },
  { id: 'agent-default-model', config: { provider: 'sjtu', model: 'quota-test' } },
  { insert: [{ id: 'provider-quota', name: new URL('./dist/index.js', import.meta.url).href, config: { providers: { sjtu: { maxOutputTokens: 8192 } } } }] },
]))
await writeFile(patch, '[]')
const child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: environment,
})
child.stdout.on('data', chunk => {
  const match = String(chunk).match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/)
  if (match) console.log('UI_TEST_URL ' + match[1])
})
child.stderr.on('data', chunk => {
  if (/provider-quota|failed to import|startup failed/i.test(String(chunk))) process.stderr.write(chunk)
})
process.on('SIGTERM', () => child.kill())
try { const [code] = await once(child, 'exit'); process.exitCode = code ?? 1 }
finally { await rm(home, { recursive: true, force: true }) }
