/** Exercise real Web agents, isolated presets, and automatic budget compaction with a local fake API. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
const root = dirname(fileURLToPath(import.meta.url))
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
const home = await mkdtemp(join(tmpdir(), 'dsh-quota-web-'))
const environment = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_QUOTA_TEST_KEY: 'fake-local-key' }
let requests = 0, summaries = 0, child
const caps = []
const server = createServer(async (req, res) => {
  let body = ''
  for await (const part of req) body += part
  const request = JSON.parse(body)
  const cap = request.max_tokens ?? request.max_completion_tokens
  caps.push(cap); requests++
  if (cap === 128 || cap === 65536) summaries++
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const chunk = (delta, finish_reason = null, usage = undefined) => ({ id: 'web-test', object: 'chat.completion.chunk', created: 1,
    model: 'test-model', choices: [{ index: 0, delta, finish_reason }], ...usage ? { usage } : {} })
  res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: cap === 128 || cap === 65536 ? 'Summary of previous context.' : 'hello' }))}\n\n`)
  res.write(`data: ${JSON.stringify(chunk({}, 'stop', { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }))}\n\n`)
  res.end('data: [DONE]\n\n')
})
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const probe = join(home, 'probe.mjs')
  await writeFile(probe, `import assert from 'node:assert/strict'
import { createUserMessage } from ${JSON.stringify(pathToFileURL(resolve(dshRoot, 'packages/llm/llm/src/message.ts')).href)}
export const inject = ['appReady', 'appExit', 'sessionController', 'agentPresets', 'agents', 'settings']
export async function apply(ctx) {
  const release = await ctx.agentPresets.register({ id: 'quota-compact-test', plugins: [{ id: 'compaction', name: 'cordis:group', group: true,
    isolate: { compaction: true }, config: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic',
      config: { auto: false, maxTokens: 128, retainTokens: 10 } }] }] })
  ctx.effect(() => release)
  const releaseLarge = await ctx.agentPresets.register({ id: 'quota-default-summary-test', plugins: [{ id: 'compaction', name: 'cordis:group', group: true,
    isolate: { compaction: true }, config: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic',
      config: { auto: false, retainTokens: 10 } }] }] })
  ctx.effect(() => releaseLarge)
  const events = []
  ctx.on('session/event', (session, event) => events.push({ session: session.id, type: event.type,
    failed: event.type === 'compaction/end' && Boolean(event.data.error),
    ...(event.type === 'compaction/end' && event.data.error ? { error: event.data.error } : {}),
    ...(event.type === 'turn/end' ? { reason: event.data.reason } : {}) }))
  ctx.effect(() => {
    let task = Promise.resolve()
    const off = ctx.appReady.onReady(() => { task = Promise.resolve().then(async () => {
      const prompt = async (agent, text) => {
        const before = events.filter(row => row.session === agent.id && row.type === 'assistant/message').length
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await agent.whenIdle()
        assert.equal(events.filter(row => row.session === agent.id && row.type === 'assistant/message').length, before + 1,
          JSON.stringify(events.filter(row => row.session === agent.id && row.failed).slice(-2)))
      }
      const standard = await ctx.sessionController.create({ cwd: ${JSON.stringify(join(home, 'workspace'))}, agentPreset: 'standard' })
      const normal = ctx.agents.get(standard.sessionId)
      assert.equal(normal.ctx.get('compaction'), undefined)
      assert.ok(ctx.agentPresets.serviceFor(normal, 'compaction'))
      await prompt(normal, 'Reply hello without tools.')
      const descriptor = ctx.settings.describe().find(row => row.ns === 'provider-quota')
      await ctx.settings.mutate('provider-quota', [{ op: 'set', path: ['providers', 'quota-test', 'tokensPerMinute'], value: 5000 }], descriptor.revision)
      const created = await ctx.sessionController.create({ cwd: ${JSON.stringify(join(home, 'workspace'))}, agentPreset: 'quota-compact-test' })
      const agent = ctx.agents.get(created.sessionId)
      assert.equal(agent.ctx.get('compaction'), undefined)
      assert.ok(ctx.agentPresets.serviceFor(agent, 'compaction'))
      await prompt(agent, 'A'.repeat(8000))
      await prompt(agent, 'B'.repeat(8000))
      const own = events.filter(row => row.session === agent.id)
      assert.equal(own.filter(row => row.type === 'compaction/start').length, 1)
      assert.equal(own.filter(row => row.type === 'compaction/end').length, 1)
      assert.equal(own.filter(row => row.type === 'assistant/attempt').length, 1)
      console.log('WEB_COMPACTION_OK ' + JSON.stringify({ standardReply: true, budgetReplies: 2, compactions: 1, oversizedAttempts: 1 }))
      const updated = ctx.settings.describe().find(row => row.ns === 'provider-quota')
      await ctx.settings.mutate('provider-quota', [{ op: 'set', path: ['providers', 'quota-test', 'tokensPerMinute'], value: 100000 }], updated.revision)
      const large = await ctx.sessionController.create({ cwd: ${JSON.stringify(join(home, 'workspace'))}, agentPreset: 'quota-default-summary-test' })
      const largeAgent = ctx.agents.get(large.sessionId)
      let largeReplies = 0
      const completed = () => events.filter(row => row.session === largeAgent.id && row.type === 'compaction/end' && !row.failed).length
      while (largeReplies < 12 && completed() === 0) {
        await prompt(largeAgent, String.fromCharCode(65 + largeReplies).repeat(60000))
        largeReplies++
      }
      assert.ok(completed() > 0)
      const rejectedSummaries = events.filter(row => row.session === largeAgent.id && row.type === 'compaction/end' && row.failed).length
      assert.ok(rejectedSummaries > 0)
      console.log('WEB_BOUNDED_SUMMARY_OK ' + JSON.stringify({ replies: largeReplies, compactions: completed(), rejectedSummaries }))
      const lastConfig = ctx.settings.describe().find(row => row.ns === 'provider-quota')
      await ctx.settings.mutate('provider-quota', [{ op: 'set', path: ['providers', 'quota-test', 'tokensPerMinute'], value: 5000 }], lastConfig.revision)
      const impossible = await ctx.sessionController.create({ cwd: ${JSON.stringify(join(home, 'workspace'))}, agentPreset: 'quota-default-summary-test' })
      const impossibleAgent = ctx.agents.get(impossible.sessionId)
      await prompt(impossibleAgent, 'X'.repeat(8000))
      impossibleAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'Y'.repeat(8000) }], source: { kind: 'user' } }))
      await impossibleAgent.whenIdle()
      const ending = events.filter(row => row.session === impossibleAgent.id && row.type === 'turn/end').at(-1)
      assert.equal(ending.reason.kind, 'error')
      assert.equal(ending.reason.error.code, 'LOCAL_COMPACTION_UNSPLITTABLE')
      console.log('WEB_UNSPLITTABLE_OK ' + ending.reason.error.code)
      ctx.appExit(0)
    }).catch(error => { console.error(error); ctx.appExit(1) }) })
    return async () => { off(); await task }
  })
}
`)
  const initialized = spawnSync(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', '--dump-config'], {
    cwd: dshRoot, windowsHide: true, env: environment, encoding: 'utf8', timeout: 45000,
  })
  assert.ifError(initialized.error)
  assert.equal(initialized.status, 0, initialized.stderr)
  const patch = join(home, 'profiles/web/cordis.patch.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'session-title-llm', disabled: true },
    { id: 'llm-pi-ai', config: { providers: { 'quota-test': { apiKeyEnv: 'DSH_QUOTA_TEST_KEY', api: 'openai-completions',
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'test-model', name: 'test-model', contextWindow: 1_000_000, maxTokens: 1024 }],
      streamIdleTimeoutMs: 3000, timeoutMs: 10_000, retryPolicy: { mode: 'normal', maxRetries: 0 } } } } },
    { id: 'agent-default-model', config: { provider: 'quota-test', model: 'test-model' } },
    { insert: [
      { id: 'provider-quota', name: process.env.DSH_QUOTA_PLUGIN_ENTRY ?? new URL('./dist/index.js', import.meta.url).href,
        config: { stateDirectory: join(home, 'quota'), providers: { 'quota-test': { requestsPerMinute: -1, tokensPerMinute: 100000,
          tokensPerWeek: -1, minIntervalMs: -1, maxOutputTokens: 256, requestHeadroomTokens: 100, compactionThresholdTokens: -1 } } } },
      { id: 'quota-web-probe', name: pathToFileURL(probe).href },
    ] },
  ]))
  child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open', '--port', '0'], {
    cwd: dshRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  })
  let stdout = '', stderr = '', timedOut = false
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const deadline = setTimeout(() => { timedOut = true; child.kill() }, 90_000)
  let code
  try { [code] = await once(child, 'close') } finally { clearTimeout(deadline) }
  assert.equal(timedOut, false, 'Web integration exceeded its deadline')
  assert.equal(code, 0, (stdout + stderr).split('\n').filter(line => !line.includes('?token=')).join('\n'))
  assert.match(stdout, /WEB_COMPACTION_OK/)
  assert.match(stdout, /WEB_BOUNDED_SUMMARY_OK/)
  assert.match(stdout, /WEB_UNSPLITTABLE_OK LOCAL_COMPACTION_UNSPLITTABLE/)
  assert.ok(summaries >= 2)
  assert.ok(caps.includes(65536))
  assert.deepEqual(caps.slice(0, 4), [256, 256, 128, 256])
  console.log(stdout.split('\n').find(line => line.startsWith('WEB_COMPACTION_OK ')))
  console.log(stdout.split('\n').find(line => line.startsWith('WEB_BOUNDED_SUMMARY_OK ')))
  console.log(stdout.split('\n').find(line => line.startsWith('WEB_UNSPLITTABLE_OK ')))
  console.log(JSON.stringify({ requests, summaries, outputCaps: caps }))
} finally {
  if (child && child.exitCode === null) { child.kill(); await once(child, 'close') }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  const rel = relative(resolve(tmpdir()), home)
  assert.ok(rel && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel))
  await rm(home, { recursive: true, force: true })
}
