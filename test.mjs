import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const { admission, apply, Config, usageTokens } = await import(process.env.DSH_QUOTA_TEST_ENTRY ?? './index.js')
import { defaults, parseConfig } from './config.js'

const { Context } = await import(process.env.DSH_TEST_CORDIS ?? '@deepseek-ai/cordis')
const base = { requestsPerMinute: 10, tokensPerMinute: 300_000, tokensPerWeek: 1_000_000_000,
  minIntervalMs: 7_000, maxOutputTokens: 100, tokenSafetyFactor: 1.25, windowMarginMs: 250,
  lockPollMs: 5, throttleCooldownMs: 60_000 }
const start = 1_000_000_000
const empty = () => ({ records: [], cooldownUntil: 0, lastSentAt: 0 })
const stop = { type: 'finish', reason: { kind: 'stop' } }
const limited = { type: 'finish', reason: { kind: 'error', failure: {
  code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 90_000, message: 'slow down',
} } }
const usage = { inputTokens: 20, outputTokens: 10, cacheReadTokens: 3, reasoningTokens: 8 }
const chunks = async function* (...items) { yield* items }
const collect = async source => { const result = []; for await (const item of source) result.push(item); return result }

async function fixture(t, overrides = {}, options = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'dsh-provider-quota-test-'))
  if (!options.directory) t.after(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('tokenMeter', { estimateMessage: () => 20 })
  let now = start
  const waits = []
  const internals = { now: () => now, sleep: options.sleep ?? (async (ms, signal) => {
    signal.throwIfAborted(); waits.push(ms); now += ms
  }) }
  await apply(ctx, { stateDirectory: directory, providers: { sjtu: { ...base, ...overrides } } }, internals)
  const request = (next, extra = {}) => ctx.waterfall('llm/stream', {
    provider: 'sjtu', model: 'one', messages: [], maxTokens: 100, ...extra,
  }, next)
  const ledger = async () => {
    const file = (await readdir(directory)).find(file => file.endsWith('.json'))
    return { file: join(directory, file), state: JSON.parse(await readFile(join(directory, file), 'utf8')) }
  }
  return { ctx, request, directory, ledger, waits, advance: ms => { now += ms }, now: () => now }
}

test('invalid config fails before activation', () => {
  for (const source of [{ stateDirectory: '.', providers: {} },
    { stateDirectory: resolve('tmp'), providers: { sjtu: { requestsPerMinute: 0 } } },
    { stateDirectory: resolve('tmp'), providers: { sjtu: { typo: 1 } } },
    { stateDirectory: resolve('tmp'), providers: { sjtu: { tokensPerMinute: 10, maxOutputTokens: 10 } } }]) {
    assert.ok(Config['~standard'].validate(source).issues)
  }
})

test('single-call budgeting includes output and leaves request headroom', () => {
  const policy = { ...defaults, maxOutputTokens: 8192 }
  assert.equal(admission(empty(), policy, 301182, start).kind, 'oversized')
  assert.equal(admission(empty(), policy, 292990, start).kind, 'ready')
  assert.equal(admission(empty(), policy, 296000, start).kind, 'oversized')
})

test('native configuration schema exposes live provider fields and validates combined budgets', () => {
  assert.equal(Config.dict.providers.meta.volatile, true)
  assert.ok(Config['~standard'].validate({ providers: { sjtu: { compactionThresholdTokens: 290000 } } }).issues)
  assert.ok(!Config['~standard'].validate({ providers: { sjtu: {} } }).issues)
  assert.equal(parseConfig({ providers: { sjtu: {} } }).providers.sjtu.compactionThresholdTokens, -1)
  assert.equal(parseConfig({ providers: { sjtu: {} } }).providers.sjtu.autoCompact, true)
})

test('minus one disables only the selected quota and keeps the remaining limits', () => {
  const policy = { ...defaults, requestsPerMinute: -1, tokensPerMinute: -1, tokensPerWeek: -1, minIntervalMs: -1 }
  assert.ok(!Config['~standard'].validate({ providers: { sjtu: policy } }).issues)
  const state = { records: [{ sentAt: start, chargedAt: start, tokens: 1_000_000 }], cooldownUntil: 0, lastSentAt: start }
  assert.deepEqual(admission(state, policy, 2_000_000, start), { kind: 'ready', delayMs: 0 })
  assert.equal(admission(state, { ...policy, requestsPerMinute: 1 }, 100, start).delayMs, 60250)
  assert.equal(admission(state, { ...policy, tokensPerMinute: 300000 }, 301000, start).kind, 'oversized')
  assert.equal(admission(state, { ...policy, tokensPerWeek: 1000001 }, 100, start).kind, 'weekly')
  assert.equal(admission(empty(), { ...policy, tokensPerWeek: 1000001 }, 2000000, start).kind, 'oversized')
  assert.equal(admission(state, { ...policy, tokensPerMinute: 300000 }, 100, start).delayMs, 60250)
  for (const invalid of [{ maxOutputTokens: -1 }, { lockPollMs: -1 }, { requestsPerMinute: 0 }, { tokensPerWeek: -2 }, { autoCompact: 1 }]) {
    assert.ok(Config['~standard'].validate({ providers: { sjtu: invalid } }).issues)
  }
})

test('disabling automatic compaction leaves native compaction and quota errors to their owners', async t => {
  const f = await fixture(t, { autoCompact: false, compactionThresholdTokens: 180000 })
  const agent = { ctx: { get() { throw new Error('disabled compaction must not resolve services') } }, session: {} }
  assert.deepEqual(await f.ctx.waterfall('agent/pre-step', { agent, modelSelection: { provider: 'sjtu' }, signal: new AbortController().signal }, async () => ({ kind: 'enter' })), { kind: 'enter' })
  const payload = { agent, provider: 'sjtu', turn: 1, step: 1, failure: { code: 'LOCAL_REQUEST_TOO_LARGE' }, signal: new AbortController().signal }
  assert.equal(await f.ctx.waterfall('agent/request-error', payload, async () => undefined), undefined)
})

test('usage counts cached tokens and counts reasoning only once', () => {
  assert.equal(usageTokens(usage), 33)
  assert.equal(usageTokens(undefined), undefined)
})

test('rolling RPM enforces the exact window and margin', () => {
  const state = empty()
  state.records = Array.from({ length: 10 }, (_, n) => ({ sentAt: start - n * 1000, chargedAt: start, tokens: 1 }))
  assert.equal(admission(state, base, 100, start).delayMs, 51_250)
  assert.equal(admission(state, base, 100, start + 51_250).delayMs, 0)
})

test('TPM waits for enough tokens, not merely the first expiry', () => {
  const state = empty()
  state.records = [{ sentAt: start, chargedAt: start, tokens: 200_000 },
    { sentAt: start, chargedAt: start + 1000, tokens: 90_000 }]
  assert.equal(admission(state, base, 250_000, start).delayMs, 61_250)
  assert.equal(admission(state, base, 300_001, start).kind, 'oversized')
})

test('weekly exhaustion rejects and the seven-day boundary releases it', () => {
  const state = empty()
  state.records = [{ sentAt: start, chargedAt: start, tokens: base.tokensPerWeek }]
  assert.equal(admission(state, base, 100, start).kind, 'weekly')
  assert.equal(admission(state, base, 100, start + 604_800_250).kind, 'ready')
})

test('429 remains visible and next is invoked once per real Cordis waterfall', async t => {
  const f = await fixture(t)
  let calls = 0
  assert.deepEqual(await collect(f.request(() => { calls++; return chunks(limited) })), [limited])
  assert.deepEqual(await collect(f.request(() => { calls++; return chunks({ type: 'usage', usage }, stop) })), [{ type: 'usage', usage }, stop])
  assert.equal(calls, 2)
  assert.ok(f.waits.includes(90_000))
  const { state } = await f.ledger()
  assert.equal(state.records.length, 2)
  assert.equal(state.records[1].tokens, 33)
})

test('reservations are durable before dispatch and all models share one ledger', async t => {
  const f = await fixture(t)
  await collect(f.request(() => (async function* () {
    const { state } = await f.ledger()
    assert.equal(state.records[0].pending, true)
    assert.ok(state.records[0].tokens >= 100)
    yield { type: 'usage', usage }; yield stop
  })()))
  await collect(f.request(() => chunks(stop), { model: 'two' }))
  assert.equal((await f.ledger()).state.records.length, 2)
  assert.deepEqual(f.waits, [7000])
})

test('unconfigured providers bypass accounting and output caps', async t => {
  const f = await fixture(t)
  assert.deepEqual(await collect(f.request(() => chunks(stop), { provider: 'other' })), [stop])
  assert.deepEqual(await readdir(f.directory), [])
  const call = { provider: 'other', model: 'one', maxTokens: 1000 }
  assert.equal(await f.ctx.waterfall('agent/request', {}, async () => call), call)
})

test('output cap is applied before loop preparation without mutating the call', async t => {
  const f = await fixture(t)
  const call = Object.freeze({ provider: 'sjtu', model: 'one', maxTokens: 1000 })
  assert.equal((await f.ctx.waterfall('agent/request', {}, async () => call)).maxTokens, 100)
  assert.equal(call.maxTokens, 1000)
})

test('already cancelled calls send nothing and acquire no lock', async t => {
  const f = await fixture(t)
  const signal = AbortSignal.abort()
  let calls = 0
  const result = await collect(f.request(() => { calls++; return chunks(stop) }, { signal }))
  assert.equal(result.at(-1).reason.kind, 'aborted')
  assert.equal(calls, 0)
  assert.deepEqual(await readdir(f.directory), [])
})

test('cancellation interrupts a quota wait and releases its lock', async t => {
  const waiting = Promise.withResolvers()
  const f = await fixture(t, {}, { sleep: (ms, signal) => {
    waiting.resolve()
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  await collect(f.request(() => chunks(stop)))
  const controller = new AbortController()
  let calls = 0
  const pending = collect(f.request(() => { calls++; return chunks(stop) }, { signal: controller.signal }))
  await waiting.promise
  controller.abort(new Error('test cancel'))
  assert.equal((await pending).at(-1).reason.kind, 'aborted')
  assert.equal(calls, 0)
  assert.ok(!(await readdir(f.directory)).some(file => file.endsWith('.lock')))
})

test('a new instance preserves request and token history', async t => {
  const first = await fixture(t)
  await collect(first.request(() => chunks({ type: 'usage', usage }, stop)))
  const second = await fixture(t, {}, { directory: first.directory })
  await collect(second.request(() => chunks(stop)))
  assert.deepEqual(second.waits, [7000])
  assert.equal((await second.ledger()).state.records[0].tokens, 33)
})

test('two instances serialize streams through the maintained file lock', async t => {
  const first = await fixture(t)
  const entered = Promise.withResolvers()
  const unblock = Promise.withResolvers()
  const firstRun = collect(first.request(() => (async function* () {
    entered.resolve(); await unblock.promise; yield stop
  })()))
  await entered.promise
  const lockWait = Promise.withResolvers()
  const leaveWait = Promise.withResolvers()
  const second = await fixture(t, {}, { directory: first.directory, sleep: async () => {
    lockWait.resolve(); await leaveWait.promise
  } })
  let calls = 0
  const secondRun = collect(second.request(() => { calls++; return chunks(stop) }))
  await lockWait.promise
  assert.equal(calls, 0)
  unblock.resolve(); await firstRun
  second.advance(100_000); leaveWait.resolve()
  await secondRun
  assert.equal(calls, 1)
  assert.equal((await second.ledger()).state.records.length, 2)
})

test('malformed ledgers stop dispatch and remain intact', async t => {
  const f = await fixture(t)
  await collect(f.request(() => chunks(stop)))
  const { file } = await f.ledger()
  await writeFile(file, '{broken')
  let calls = 0
  await assert.rejects(collect(f.request(() => { calls++; return chunks(stop) })))
  assert.equal(calls, 0)
  assert.equal(await readFile(file, 'utf8'), '{broken')
})

test('unknown crash usage is retained and recovered only once', async t => {
  const f = await fixture(t)
  await collect(f.request(() => chunks(stop)))
  const { file, state } = await f.ledger()
  state.records[0].pending = true
  await writeFile(file, JSON.stringify(state))
  f.advance(100_000)
  await collect(f.request(() => chunks(stop)))
  const recovered = (await f.ledger()).state.records[0]
  assert.equal(recovered.pending, false)
  assert.equal(recovered.chargedAt, start + 100_000)
  assert.ok(recovered.tokens >= 100)
})

test('actual input usage raises the persisted reservation scale', async t => {
  const f = await fixture(t)
  await collect(f.request(() => chunks({ type: 'usage', usage: { inputTokens: 10_000, outputTokens: 0 } }, stop)))
  assert.ok((await f.ledger()).state.inputScale > 1.25)
  await collect(f.request(() => chunks(stop)))
  assert.ok((await f.ledger()).state.records[1].tokens >= 12_600)
})

test('source errors propagate without a second dispatch and retain reservations', async t => {
  const f = await fixture(t)
  let calls = 0
  await assert.rejects(collect(f.request(() => { calls++; throw new Error('middleware defect') })), /middleware defect/)
  assert.equal(calls, 1)
  assert.ok((await f.ledger()).state.records[0].tokens >= 100)
})

test('unloading cancels queued admission and waits for its cleanup', async t => {
  const waiting = Promise.withResolvers()
  const f = await fixture(t, {}, { sleep: (ms, signal) => {
    waiting.resolve()
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  await collect(f.request(() => chunks(stop)))
  const pending = collect(f.request(() => { throw new Error('must not dispatch after unload') }))
  await waiting.promise
  await f.ctx.fiber.dispose()
  assert.equal((await pending).at(-1).reason.kind, 'aborted')
  assert.ok(!(await readdir(f.directory)).some(file => file.endsWith('.lock')))
})

test('early compaction uses provider pressure instead of the larger model window', async t => {
  const f = await fixture(t, { compactionThresholdTokens: 180000 })
  const calls = []
  f.ctx.set('tokenMeter', { estimateMessage: () => 20, measure: () => ({ totalTokens: 220000 }) })
  const engine = { compactIfNeeded: async (...args) => { calls.push(args[1]); return { summary: [] } } }
  const agent = { ctx: { get: key => key === 'compaction' ? engine : undefined }, session: {} }
  let delegated = 0
  const decision = await f.ctx.waterfall('agent/pre-step', { agent, modelSelection: { provider: 'sjtu' }, signal: new AbortController().signal },
    async () => { delegated++; return { kind: 'enter' } })
  assert.deepEqual(calls, ['context-overflow'])
  assert.equal(delegated, 1)
  assert.equal(decision.kind, 'enter')
})

test('an oversized request gets at most one compaction recovery per step', async t => {
  const f = await fixture(t)
  let compactions = 0, delegated = 0
  const agent = { ctx: { get: key => key === 'compaction' ? { compactIfNeeded: async () => { compactions++; return {} } } : undefined } }
  const payload = { agent, provider: 'sjtu', turn: 1, step: 2, failure: { code: 'LOCAL_REQUEST_TOO_LARGE' }, signal: new AbortController().signal }
  const next = async () => { delegated++; return undefined }
  assert.deepEqual(await f.ctx.waterfall('agent/request-error', payload, next), { kind: 'retry' })
  assert.equal(await f.ctx.waterfall('agent/request-error', payload, next), undefined)
  assert.equal(compactions, 1)
  assert.equal(delegated, 1)
})

test('unchanged or unavailable compaction does not authorize a retry', async t => {
  const f = await fixture(t)
  const agent = { ctx: { get: key => key === 'compaction' ? { compactIfNeeded: async () => null } : undefined } }
  const payload = { agent, provider: 'sjtu', turn: 1, step: 2, failure: { code: 'LOCAL_REQUEST_TOO_LARGE' }, signal: new AbortController().signal }
  assert.equal(await f.ctx.waterfall('agent/request-error', payload, async () => undefined), undefined)
})

test('isolated preset compaction is resolved through the public preset service', async t => {
  const f = await fixture(t)
  let compactions = 0
  const engine = { compactIfNeeded: async () => { compactions++; return {} } }
  const agent = { ctx: { get: key => key === 'agentPresets' ? { serviceFor(subject, service) {
    assert.equal(subject, agent); assert.equal(service, 'compaction'); return engine
  } } : undefined } }
  const payload = { agent, provider: 'sjtu', turn: 1, step: 2, failure: { code: 'LOCAL_REQUEST_TOO_LARGE' }, signal: new AbortController().signal }
  assert.deepEqual(await f.ctx.waterfall('agent/request-error', payload, async () => undefined), { kind: 'retry' })
  assert.equal(compactions, 1)
})

test('requests below the early threshold do not require a compaction backend', async t => {
  const f = await fixture(t, { compactionThresholdTokens: 240000 })
  f.ctx.set('tokenMeter', { measure: () => ({ totalTokens: 228000 }) })
  const agent = { ctx: { get: () => undefined }, session: {} }
  const decision = await f.ctx.waterfall('agent/pre-step', { agent, modelSelection: { provider: 'sjtu' }, signal: new AbortController().signal }, async () => ({ kind: 'enter' }))
  assert.deepEqual(decision, { kind: 'enter' })
})

test('live settings replace the policy read by the next request without remounting', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-live-quota-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('tokenMeter', { estimateMessage: () => 1 })
  let policy = { sjtu: { maxOutputTokens: 8000 } }
  await apply(ctx, { stateDirectory: dir, providers: { get: () => policy } })
  const call = () => ctx.waterfall('agent/request', {}, async () => ({ provider: 'sjtu', model: 'test' }))
  assert.equal((await call()).maxTokens, 8000)
  policy = { sjtu: { maxOutputTokens: 4000 } }
  assert.equal((await call()).maxTokens, 4000)
})

test('authenticated status route validates envelopes and reads without rewriting pending usage', async t => {
  const f = await fixture(t)
  await collect(f.request(() => chunks(stop)))
  const { file, state } = await f.ledger()
  state.records[0].pending = true
  await writeFile(file, JSON.stringify(state))
  const before = await readFile(file, 'utf8')
  const registered = Promise.withResolvers()
  f.ctx.provide('connection', { fetch: { register: route => { registered.resolve(route); return async () => {} } } })
  const route = await registered.promise
  assert.equal(route.path, '/api/provider-quota/status')
  const invoke = body => route.fetch(new Request('http://local/api/provider-quota/status', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  assert.equal((await invoke({})).status, 400)
  const response = await invoke({ type: 'client-request', rpcId: 'test-status', method: 'provider-quota/status', payload: null })
  const result = await response.json()
  assert.equal(result.rpcId, 'test-status')
  assert.equal(result.result.value.providers[0].inFlight, true)
  assert.equal(result.result.value.defaults.tokensPerMinute, 300000)
  assert.equal(await readFile(file, 'utf8'), before)
})
