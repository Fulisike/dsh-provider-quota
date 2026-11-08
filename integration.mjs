/** Exercise the supported CLI, real HTTP adapter, logged retry, and local quota together without an API key. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { zstdDecompressSync } from 'node:zlib'
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
const { scanZstdFrames } = await import(pathToFileURL(resolve(dshRoot, 'packages/session/session-persistence-jsonl/src/zstd.ts')).href)

const home = await mkdtemp(join(tmpdir(), 'dsh-quota-cli-'))
let requests = 0
const caps = []
const server = createServer(async (req, res) => {
  let body = ''
  for await (const part of req) body += part
  const request = JSON.parse(body)
  caps.push(request.max_tokens ?? request.max_completion_tokens)
  requests++
  if (requests === 1) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0.01' })
    res.end(JSON.stringify({ error: { message: 'rate limit', type: 'rate_limit_error', code: 'rate_limit' } }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const chunk = (delta, finish_reason = null, usage = undefined) => ({ id: 'test', object: 'chat.completion.chunk',
    created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason }], ...usage ? { usage } : {} })
  res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'hello' }))}\n\n`)
  res.write(`data: ${JSON.stringify(chunk({}, 'stop', { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }))}\n\n`)
  res.end('data: [DONE]\n\n')
})
let child
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const patch = join(home, 'quota.patch.yml')
  const config = [
    { id: 'session-title-llm', disabled: true },
    { id: 'llm-pi-ai', config: { providers: { 'quota-test': { apiKeyEnv: 'DSH_QUOTA_TEST_KEY',
      api: 'openai-completions', baseURL: `http://127.0.0.1:${port}/v1`,
      models: [{ id: 'test-model', name: 'test-model', contextWindow: 1_000_000, maxTokens: 1024 }],
      streamIdleTimeoutMs: 3000, timeoutMs: 10_000,
      retryPolicy: { mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 } },
    } } } },
    { id: 'agent-default-model', config: { provider: 'quota-test', model: 'test-model' } },
    { insert: [{ id: 'provider-quota', name: process.env.DSH_QUOTA_PLUGIN_ENTRY ?? new URL('./dist/index.js', import.meta.url).href,
      config: { stateDirectory: join(home, 'quota'), providers: { 'quota-test': {
        requestsPerMinute: 10, tokensPerMinute: 100_000, tokensPerWeek: 1_000_000,
        minIntervalMs: 10, maxOutputTokens: 256, windowMarginMs: 1, throttleCooldownMs: 20, compactionThresholdTokens: 60000, requestHeadroomTokens: 100,
      } } } }] },
  ]
  await writeFile(patch, JSON.stringify(config))
  child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'headless',
    '--patch', patch, 'Reply hello without tools.'], {
    cwd: dshRoot, windowsHide: true,
    env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_QUOTA_TEST_KEY: 'fake-local-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const deadline = setTimeout(() => child.kill(), 45_000)
  const [code] = await once(child, 'exit')
  clearTimeout(deadline)
  assert.equal(code, 0, stderr.slice(-7000))
  assert.equal(stdout.trim(), 'hello')
  assert.equal(requests, 2)
  assert.deepEqual(caps, [256, 256])
  const quotaFile = (await readdir(join(home, 'quota'))).find(file => file.endsWith('.json'))
  const state = JSON.parse(await readFile(join(home, 'quota', quotaFile), 'utf8'))
  assert.equal(state.records.length, 2)
  assert.equal(state.records[1].tokens, 11)
  assert.ok(state.records.every(row => !row.pending))
  let retries = 0, attempts = 0, answers = 0
  for (const file of await readdir(join(home, 'sessions'), { recursive: true })) {
    if (!file.endsWith('.jsonl.zstd')) continue
    const bytes = await readFile(join(home, 'sessions', file))
    for (const frame of scanZstdFrames(bytes).frames) {
      for (const line of zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString().trim().split('\n')) {
        const event = JSON.parse(line)
        if (event.type === 'llm/retry') retries++
        if (event.type === 'assistant/attempt') attempts++
        if (event.type === 'assistant/message') answers++
      }
    }
  }
  assert.deepEqual({ retries, attempts, answers }, { retries: 1, attempts: 1, answers: 1 })
  console.log(JSON.stringify({ requests, outputCaps: caps, quotaRecords: state.records.length,
    retries, failedAttempts: attempts, answers, final: stdout.trim() }))
} finally {
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') }
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(home, { recursive: true, force: true })
}
