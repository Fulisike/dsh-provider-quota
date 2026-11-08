/** Provider-wide admission and durable quota accounting. Request recovery belongs to dsh-llm-retry. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import lockfile from 'proper-lockfile'

const MINUTE = 60_000
const WEEK = 7 * 24 * 60 * MINUTE
import { Config, parseConfig, defaults } from './config.js'
export { Config }

export const name = 'provider-quota'
export const inject = ['llm', 'tokenMeter']

/** Sum disjoint usage counters. Reasoning is already included in outputTokens. */
export function usageTokens(usage) {
  if (usage === undefined) return undefined
  return Math.ceil(usage.inputTokens + usage.outputTokens
    + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
}

/** Compute the earliest safe send time. Token windows start at settlement, conservatively covering long streams. */
export function admission(state, policy, cost, now) {
  if (policy.tokensPerMinute !== -1 && cost > policy.tokensPerMinute - (policy.requestHeadroomTokens ?? 0)) return { kind: 'oversized', period: 'minute', limit: policy.tokensPerMinute }
  if (policy.tokensPerWeek !== -1 && cost > policy.tokensPerWeek) return { kind: 'oversized', period: 'week', limit: policy.tokensPerWeek }
  const week = state.records.filter(row => row.chargedAt + WEEK + policy.windowMarginMs > now)
  if (policy.tokensPerWeek !== -1 && week.reduce((sum, row) => sum + row.tokens, 0) + cost > policy.tokensPerWeek) {
    return { kind: 'weekly', retryAt: Math.min(...week.map(row => row.chargedAt + WEEK + policy.windowMarginMs)) }
  }
  let at = Math.max(now, state.cooldownUntil, state.lastSentAt + (policy.minIntervalMs === -1 ? 0 : policy.minIntervalMs))
  const requests = state.records.filter(row => row.sentAt + MINUTE + policy.windowMarginMs > now)
  while (policy.requestsPerMinute !== -1 && requests.filter(row => row.sentAt + MINUTE + policy.windowMarginMs > at).length >= policy.requestsPerMinute) {
    at = Math.min(...requests.filter(row => row.sentAt + MINUTE + policy.windowMarginMs > at)
      .map(row => row.sentAt + MINUTE + policy.windowMarginMs))
  }
  const tokens = state.records.filter(row => row.chargedAt + MINUTE + policy.windowMarginMs > now)
  while (policy.tokensPerMinute !== -1 && tokens.filter(row => row.chargedAt + MINUTE + policy.windowMarginMs > at)
    .reduce((sum, row) => sum + row.tokens, 0) + cost > policy.tokensPerMinute) {
    at = Math.min(...tokens.filter(row => row.chargedAt + MINUTE + policy.windowMarginMs > at)
      .map(row => row.chargedAt + MINUTE + policy.windowMarginMs))
  }
  return { kind: 'ready', delayMs: at - now }
}

/** Atomically publish accounting before dispatch and after settlement. A write failure stops dispatch. */
async function save(file, state) {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(state))
      await handle.sync()
    } finally { await handle.close() }
    await rename(temp, file)
  } finally { await rm(temp, { force: true }) }
}

/** Read only this plugin's versioned ledger; malformed or future data blocks requests. */
async function load(file, provider, now, recover = true) {
  let state
  try { state = JSON.parse(await readFile(file, 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { version: 1, provider, lastSentAt: 0, cooldownUntil: 0, inputScale: 1, records: [] }
  }
  if (state.version !== 1 || state.provider !== provider || !Array.isArray(state.records)
    || !Number.isFinite(state.lastSentAt) || !Number.isFinite(state.cooldownUntil)
    || !Number.isFinite(state.inputScale) || state.inputScale < 1
    || state.records.some(row => !Number.isFinite(row.sentAt) || !Number.isFinite(row.chargedAt)
      || !Number.isSafeInteger(row.tokens) || row.tokens < 0 || typeof row.pending !== 'boolean')) {
    throw new Error(`provider-quota: invalid ledger ${file}; restore its backup before retrying`)
  }
  // A crashed request's unknown usage remains charged for a full window after recovery.
  for (const row of state.records) {
    if (recover && row.pending) { row.pending = false; row.chargedAt = now }
  }
  return state
}

function finish(code, message) {
  return { type: 'finish', reason: { kind: code === 'ABORTED' ? 'aborted' : 'error', failure: { code, message } } }
}

/**
 * Mount one attempt per waterfall invocation. File locks coordinate all profiles/processes sharing stateDirectory.
 * Disposal cancels admission waits and awaits active streams; the caller's signal cancels provider transport.
 * @param {object} ctx Cordis context.
 * @param {object} raw Provider policies and absolute ledger directory.
 * @param {object} internals Optional test clock and cancellable delay.
 * @returns {Promise<void>} Resolves after the listeners mount.
 */
export async function apply(ctx, raw, internals = {}) {
  const readConfig = () => parseConfig(raw)
  const config = readConfig()
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 })
  const lifetime = new AbortController()
  const active = new Set()
  const recovered = new WeakMap()
  const track = operation => {
    const pending = operation.finally(() => active.delete(pending))
    active.add(pending)
    return pending
  }
  const clock = internals.now ?? Date.now
  const sleep = internals.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }))

  async function* stream(options, next, policy) {
    const settled = Promise.withResolvers()
    active.add(settled.promise)
    const signal = AbortSignal.any([lifetime.signal, ...options.signal ? [options.signal] : []])
    const file = join(config.stateDirectory, `${createHash('sha256').update(options.provider).digest('hex')}.json`)
    let release
    let state
    let record
    let usage
    let failure
    let compromised
    let promptEstimate
    let sent = false
    try {
      signal.throwIfAborted()
      let announcedLock = false
      while (!release) {
        signal.throwIfAborted()
        try {
          release = await lockfile.lock(file, {
            realpath: false,
            retries: 0,
            // A maintained heartbeat lock recovers from crashed processes.
            onCompromised(error) { compromised = error; lifetime.abort(error) },
          })
        } catch (error) {
          if (error.code !== 'ELOCKED') throw error
          if (!announcedLock) {
            ctx.logger.info('provider-quota: %s waiting for another request to settle', options.provider)
            announcedLock = true
          }
          await sleep(policy.lockPollMs, signal)
        }
      }
      signal.throwIfAborted()
      state = await load(file, options.provider, clock())
      await save(file, state)
      const messages = options.messages.reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0)
      const framing = Math.ceil(Buffer.byteLength(JSON.stringify({ system: options.system, tools: options.tools, stop: options.stop })) / 3)
      promptEstimate = messages + framing
      const cost = Math.ceil(promptEstimate * Math.max(policy.tokenSafetyFactor, state.inputScale))
        + (options.maxTokens ?? policy.maxOutputTokens)
      while (true) {
        signal.throwIfAborted()
        const now = clock()
        const decision = admission(state, policy, cost, now)
        if (decision.kind === 'oversized') {
          const budget = decision.period === 'minute' ? `每分钟 ${decision.limit}（含 ${policy.requestHeadroomTokens} token 额外余量）` : `滚动 7 天 ${decision.limit}`
          yield finish('LOCAL_REQUEST_TOO_LARGE', `提供方 ${options.provider}：预计输入与输出预留共 ${cost} token，超过${budget}预算；请压缩上下文或降低最大输出。`)
          return
        }
        if (decision.kind === 'weekly') {
          yield finish('LOCAL_WEEKLY_QUOTA', `提供方 ${options.provider}：滚动 7 天额度不足，最早有额度释放的时间为 ${new Date(decision.retryAt).toISOString()}；请等待或核对提供方用量。`)
          return
        }
        if (decision.delayMs <= 0) break
        ctx.logger.info('provider-quota: %s waiting %d ms for rolling quota/cooldown', options.provider, decision.delayMs)
        await sleep(decision.delayMs, signal)
      }
      const now = clock()
      state.records = state.records.filter(row => row.chargedAt + WEEK + policy.windowMarginMs > now)
      record = { sentAt: now, chargedAt: now, tokens: cost, pending: true }
      state.records.push(record)
      state.lastSentAt = now
      await save(file, state)
      signal.throwIfAborted()
      sent = true
      // next() is called exactly once, including failed or partially emitted attempts.
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason.kind)) failure = chunk.reason.failure
        yield chunk
      }
    } catch (error) {
      if (compromised) throw compromised
      if (!signal.aborted) throw error
      yield finish('ABORTED', '请求排队或限流等待已取消。')
    } finally {
      try {
        if (compromised) throw compromised
        if (record) {
          record.pending = false
          record.chargedAt = clock()
          record.tokens = sent ? usageTokens(usage) ?? record.tokens : 0
          if (usage && promptEstimate > 0) {
            const actualInput = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
            state.inputScale = Math.max(state.inputScale, actualInput / promptEstimate * policy.tokenSafetyFactor)
          }
          if (!sent) state.records.splice(state.records.indexOf(record), 1)
          if (failure?.code === 'RATE_LIMIT' || failure?.status === 429) {
            state.cooldownUntil = Math.max(state.cooldownUntil,
              clock() + Math.max(policy.throttleCooldownMs, failure.providerRetryAfterMs ?? 0))
          }
          await save(file, state)
        }
      } finally {
        try { if (release) await release() }
        finally { active.delete(settled.promise); settled.resolve() }
      }
    }
  }

  // Web presets isolate compaction below the Agent's scope; the registry resolves its retained revision.
  const compactionFor = agent => agent.ctx.get('agentPresets')?.serviceFor(agent, 'compaction') ?? agent.ctx.get('compaction')
  const offPreStep = ctx.on('agent/pre-step', ({ agent, modelSelection, signal }, next) => track((async () => {
    lifetime.signal.throwIfAborted()
    const policy = readConfig().providers[modelSelection.provider]
    if (policy?.autoCompact && policy.compactionThresholdTokens !== -1) {
      const pressure = ctx.tokenMeter.measure(agent.session).totalTokens
      if (pressure >= policy.compactionThresholdTokens) {
        const engine = compactionFor(agent)
        if (!engine) throw new Error('provider-quota: automatic compaction is unavailable; enable the preset compaction backend or disable automatic compaction')
        signal.throwIfAborted()
        const result = await engine.compactIfNeeded(agent, 'context-overflow', AbortSignal.any([signal, lifetime.signal]))
        if (result === null) ctx.logger.warn('provider-quota: no balanced history range can be compacted for %s', modelSelection.provider)
      }
    }
    return next()
  })()), { global: true })
  const offRecovery = ctx.on('agent/request-error', (payload, next) => track((async () => {
    const { agent, failure, provider, turn, step, signal } = payload
    if (failure.code !== 'LOCAL_REQUEST_TOO_LARGE' || !readConfig().providers[provider]?.autoCompact) return next()
    const key = `${turn}/${step}`
    if (recovered.get(agent) === key) return next()
    recovered.set(agent, key)
    const engine = compactionFor(agent)
    if (!engine) {
      ctx.logger.warn('provider-quota: automatic compaction is unavailable in this agent preset; the oversized request remains blocked')
      return next()
    }
    const fused = AbortSignal.any([signal, lifetime.signal])
    fused.throwIfAborted()
    const result = await engine.compactIfNeeded(agent, 'context-overflow', fused)
    fused.throwIfAborted()
    return result === null ? next() : { kind: 'retry' }
  })()), { global: true })
  const offRequest = ctx.on('agent/request', async (_payload, next) => {
    lifetime.signal.throwIfAborted()
    const call = await next()
    const policy = readConfig().providers[call.provider]
    if (!policy) return call
    return { ...call, maxTokens: Math.min(call.maxTokens ?? policy.maxOutputTokens, policy.maxOutputTokens) }
  }, { global: true })
  const offStream = ctx.on('llm/stream', (options, next) => {
    const policy = readConfig().providers[options.provider]
    return policy ? stream(options, next, policy) : next()
  })
  ctx.inject(['connection'], scope => {
    scope.effect(() => scope.connection.fetch.register({ path: '/api/provider-quota/status', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
      const envelope = await request.json()
      if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string' || envelope.method !== 'provider-quota/status' || envelope.payload !== null) return new Response('Invalid status request', { status: 400 })
      const signal = request.signal
      const result = []
      for (const [provider, policy] of Object.entries(readConfig().providers)) {
        signal.throwIfAborted()
        const file = join(config.stateDirectory, createHash('sha256').update(provider).digest('hex') + '.json')
        const state = await load(file, provider, clock(), false)
        const now = clock()
        result.push({ provider, requests: state.records.filter(row => row.sentAt + MINUTE > now).length,
          minuteTokens: state.records.filter(row => row.pending || row.chargedAt + MINUTE > now).reduce((sum, row) => sum + row.tokens, 0),
          weekTokens: state.records.filter(row => row.pending || row.chargedAt + WEEK > now).reduce((sum, row) => sum + row.tokens, 0),
          cooldownMs: Math.max(0, state.cooldownUntil - now), inputScale: state.inputScale,
          inFlight: state.records.some(row => row.pending) })
      }
      return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { defaults, providers: result } } })
    } }))
  })
  ctx.effect(() => async () => {
    offStream()
    offRequest()
    offPreStep()
    offRecovery()
    lifetime.abort(new Error('provider-quota unloaded'))
    await Promise.allSettled([...active])
  })
}
