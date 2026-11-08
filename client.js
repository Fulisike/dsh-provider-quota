/** Browser settings page. Writes use DSH revision-fenced configuration forms; status uses the authenticated carrier. */
window.__ModuleLoader__.load({ id: 'dsh-provider-quota', factory(require) {
  const React = require('react')
  const { Button, Input } = require('@deepseek-ai/dsh-client-ui-primitives')
  const h = React.createElement
  const NS = 'provider.quota'
  const zh = {
    title: '提供方限流', intro: '同一提供方的所有模型共享滚动额度。输入与输出合计计入 token 限额。',
    provider: '提供方', limits: '共享额度与上下文', recovery: '连接与临时故障恢复',
    requestsPerMinute: '每分钟请求上限', tokensPerMinute: '每分钟 token 上限（输入＋输出）', tokensPerWeek: '滚动 7 天 token 上限',
    minIntervalMs: '最短发送间隔（毫秒）', maxOutputTokens: '单次最大输出 token', tokenSafetyFactor: '输入估计安全系数',
    compactionThresholdTokens: '提前压缩阈值（token）', requestHeadroomTokens: '单次请求额外余量（token）',
    windowMarginMs: '窗口边缘余量（毫秒）', lockPollMs: '队列检查间隔（毫秒）', throttleCooldownMs: '429 最短冷却（毫秒）',
    streamIdleTimeoutMs: '流无活动超时（毫秒）', timeoutMs: 'SDK 请求超时（毫秒）', maxRetries: '最多重试次数',
    initialDelayMs: '首次退避（毫秒）', maxDelayMs: '最长退避（毫秒）', jitterRatio: '退避抖动比例（0–1）',
    save: '保存并应用', saving: '保存中…', discard: '放弃修改', refresh: '刷新用量', loading: '正在读取设置…',
    saved: '已保存；新请求使用新设置，在途请求保留启动时的设置。', refused: '设置未保存，可能存在并发修改；请刷新后重试。',
    partial: '限流已保存，连接设置未保存。请刷新后检查并重试。', failed: '读取或保存失败，请检查连接后重试。',
    invalid: '请填写有效数字；压缩阈值＋最大输出＋额外余量必须小于 TPM，TPM 不得大于周额度。',
    unavailable: '当前 profile 未提供可编辑的限流和模型设置。', noProvider: '请先在模型设置中添加提供方。',
    status: '本地用量（包含在途预留）', requests: '分钟请求', minute: '分钟 token', week: '7 天 token', cooldown: '冷却剩余秒数',
    note: '输入 token 是估计值，会根据实际用量校准。其他程序的消耗无法统计。接近阈值时自动压缩历史，超大单条输入仍需拆分。',
    recoveryNote: '仅重试限流、服务端、超时、网络和空响应错误。摘要输出默认上限为 8192 token。',
    readOnly: '当前设置只读。', enable: '启用该提供方的共享额度', disable: '停用该提供方的共享额度',
  }
  const en = {
    title: 'Provider quotas', intro: 'All models of a provider share rolling quotas. Token limits include input and output.',
    provider: 'Provider', limits: 'Shared quotas and context', recovery: 'Connection and transient recovery',
    requestsPerMinute: 'Requests per minute', tokensPerMinute: 'Tokens per minute (input + output)', tokensPerWeek: 'Tokens per rolling 7 days',
    minIntervalMs: 'Minimum send interval (ms)', maxOutputTokens: 'Maximum output tokens', tokenSafetyFactor: 'Input estimate safety factor',
    compactionThresholdTokens: 'Early compaction threshold (tokens)', requestHeadroomTokens: 'Extra request headroom (tokens)',
    windowMarginMs: 'Window margin (ms)', lockPollMs: 'Queue check interval (ms)', throttleCooldownMs: 'Minimum 429 cooldown (ms)',
    streamIdleTimeoutMs: 'Stream idle timeout (ms)', timeoutMs: 'SDK request timeout (ms)', maxRetries: 'Maximum retries',
    initialDelayMs: 'Initial backoff (ms)', maxDelayMs: 'Maximum backoff (ms)', jitterRatio: 'Backoff jitter ratio (0–1)',
    save: 'Save and apply', saving: 'Saving…', discard: 'Discard changes', refresh: 'Refresh usage', loading: 'Loading settings…',
    saved: 'Saved. New requests use these settings; active requests retain their captured settings.', refused: 'Changes were refused, possibly due to a concurrent edit. Refresh and retry.',
    partial: 'Quotas saved; connection settings were not saved. Refresh, check the values, and retry.', failed: 'Could not read or save settings. Check the connection and retry.',
    invalid: 'Enter valid numbers. Compaction threshold + output + headroom must be below TPM, and TPM cannot exceed the weekly quota.',
    unavailable: 'This profile does not provide editable quota and model settings.', noProvider: 'Add a provider in model settings first.',
    status: 'Local usage (includes active reservations)', requests: 'Minute requests', minute: 'Minute tokens', week: '7-day tokens', cooldown: 'Cooldown seconds',
    note: 'Input tokens are estimated and calibrated from actual usage. Other applications are not counted. Large histories compact early; split a single oversized input.',
    recoveryNote: 'Retries cover rate limits, server errors, timeouts, transport errors, and empty responses. Summary output defaults to 8192 tokens.',
    readOnly: 'These settings are read-only.', enable: 'Enable shared quotas for this provider', disable: 'Disable shared quotas for this provider',
  }
  const CSS = `
.dsh-pq{display:flex;flex-direction:column;gap:24px;max-width:760px;width:100%;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5}
.dsh-pq h2,.dsh-pq h3,.dsh-pq p{margin:0}.dsh-pq h2{font-size:20px;line-height:28px}.dsh-pq h3{font-size:16px;line-height:24px}
.dsh-pq .pq-intro,.dsh-pq .pq-note{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dsh-pq .pq-group{display:flex;flex-direction:column;gap:16px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:20px}
.dsh-pq .pq-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 24px}.dsh-pq label{display:flex;flex-direction:column;gap:7px;min-width:0}
.dsh-pq input,.dsh-pq select{width:100%;box-sizing:border-box}.dsh-pq select{padding:8px 12px;border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit}
.dsh-pq .pq-actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.dsh-pq .pq-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;font-variant-numeric:tabular-nums}.dsh-pq .pq-stats div{padding:10px 12px;background:var(--dsw-alias-bg-layer-3);border-radius:var(--dsw-radius-md)}
.dsh-pq .pq-stats span{display:block;font-size:12px;color:var(--dsw-alias-label-tertiary)}.dsh-pq [role=alert]{font-weight:500}.dsh-pq button{white-space:normal}
@media(max-width:720px){.dsh-pq .pq-grid{grid-template-columns:1fr}.dsh-pq{gap:20px}}`
  const quotaFields = ['requestsPerMinute', 'tokensPerMinute', 'tokensPerWeek', 'minIntervalMs', 'maxOutputTokens',
    'compactionThresholdTokens', 'requestHeadroomTokens', 'tokenSafetyFactor', 'windowMarginMs', 'lockPollMs', 'throttleCooldownMs']
  const retryFields = ['streamIdleTimeoutMs', 'timeoutMs', 'maxRetries', 'initialDelayMs', 'maxDelayMs', 'jitterRatio']
  const retryDefaults = { streamIdleTimeoutMs: 900000, timeoutMs: 1800000, maxRetries: 12, initialDelayMs: 10000, maxDelayMs: 300000, jitterRatio: 0.2 }
  function useForm(form) {
    const subscribe = React.useCallback(listener => form.subscribe(listener), [form])
    const snapshot = React.useCallback(() => form.getSnapshot(), [form])
    return React.useSyncExternalStore(subscribe, snapshot, snapshot)
  }

  function Page({ ctx, t }) {
    const quotaForm = React.useMemo(() => ctx.configForms.get('provider-quota'), [ctx])
    const adapterForm = React.useMemo(() => ctx.configForms.get('llm-pi-ai'), [ctx])
    const quota = useForm(quotaForm), adapter = useForm(adapterForm)
    const [provider, setProvider] = React.useState('')
    const [draft, setDraft] = React.useState(null)
    const [message, setMessage] = React.useState('')
    const [saving, setSaving] = React.useState(false)
    const [status, setStatus] = React.useState(null)
    const [statusError, setStatusError] = React.useState(false)
    const [revision, setRevision] = React.useState(null)
    const [dirty, setDirty] = React.useState(false)
    const lifetime = React.useMemo(() => new AbortController(), [ctx])
    React.useEffect(() => () => lifetime.abort(), [lifetime])
    const providers = Object.keys(adapter.value?.providers ?? {})
    const refresh = React.useCallback(async signal => {
      signal = AbortSignal.any([lifetime.signal, ...signal ? [signal] : []])
      try {
        const result = await ctx.connection.rpc.call('/api', 'provider-quota/status', null, signal)
        if (!result.ok) throw new Error('status refused')
        if (!signal?.aborted) { setStatus(result.value); setStatusError(false) }
      } catch (error) { if (!signal?.aborted) setStatusError(true) }
    }, [ctx, lifetime])
    React.useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort() }, [refresh])
    React.useEffect(() => { if (!provider && providers.length) setProvider(providers.includes('sjtu') ? 'sjtu' : providers[0]) }, [provider, providers.join('|')])
    const loadDraft = React.useCallback(() => {
      if (!provider || !status || quota.status !== 'ready' || adapter.status !== 'ready') return
      const q = { ...status.defaults, ...quota.value.providers?.[provider] }
      const p = adapter.value.providers[provider]
      const policy = p.retryPolicy ?? {}
      const r = { ...retryDefaults, ...p, ...policy, ...policy.backoff }
      setDraft(Object.fromEntries([...quotaFields.map(key => [key, String(q[key])]), ...retryFields.map(key => [key, String(r[key])])]))
      setRevision({ quota: quota.revision, adapter: adapter.revision })
      setDirty(false)
    }, [provider, status, quota, adapter])
    React.useEffect(() => { setDraft(null); setRevision(null); setMessage(''); setDirty(false) }, [provider])
    React.useEffect(() => { if (draft === null) loadDraft() }, [draft, loadDraft])
    const enabled = Boolean(quota.value?.providers?.[provider])
    const writable = quota.writable && adapter.writable
    async function save() {
      const numbers = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim() === '' ? NaN : Number(value)]))
      const valid = Object.entries(numbers).every(([key, value]) => ['tokenSafetyFactor', 'jitterRatio'].includes(key)
        ? Number.isFinite(value) && (key === 'tokenSafetyFactor' ? value >= 1 : value >= 0 && value <= 1)
        : Number.isSafeInteger(value) && (key === 'maxRetries' ? value >= 0 : value > 0))
      if (!valid || numbers.compactionThresholdTokens + numbers.maxOutputTokens + numbers.requestHeadroomTokens >= numbers.tokensPerMinute
        || numbers.tokensPerMinute > numbers.tokensPerWeek || numbers.initialDelayMs > numbers.maxDelayMs) { setMessage('invalid'); return }
      setSaving(true); setMessage('')
      let quotasSaved = false
      try {
        const q = Object.fromEntries(quotaFields.map(key => [key, numbers[key]]))
        if (!await quotaForm.mutate([{ op: 'set', path: ['providers', provider], value: q }], revision.quota)) { setMessage('refused'); return }
        quotasSaved = true
        const oldPolicy = adapter.value.providers[provider].retryPolicy
        const policy = { mode: 'normal', maxRetries: numbers.maxRetries,
          retryableCodes: oldPolicy?.retryableCodes ?? ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
          backoff: { initialDelayMs: numbers.initialDelayMs, maxDelayMs: numbers.maxDelayMs, jitterRatio: numbers.jitterRatio } }
        const ops = ['streamIdleTimeoutMs', 'timeoutMs'].map(key => ({ op: 'set', path: ['providers', provider, key], value: numbers[key] }))
        ops.push({ op: 'set', path: ['providers', provider, 'retryPolicy'], value: policy })
        if (!await adapterForm.mutate(ops, revision.adapter)) { setMessage('partial'); return }
        setDraft(null); setMessage('saved'); await refresh()
      } catch (error) { setMessage(quotasSaved ? 'partial' : 'failed') }
      finally { setSaving(false) }
    }
    async function disable() {
      setSaving(true)
      try {
        const ok = await quotaForm.mutate([{ op: 'unset', path: ['providers', provider] }], quota.revision)
        setMessage(ok ? 'saved' : 'refused'); if (ok) { setDraft(null); await refresh() }
      } catch (error) { setMessage('failed') }
      finally { setSaving(false) }
    }
    if (quota.status === 'unavailable' || adapter.status === 'unavailable') return h('p', null, t('unavailable'))
    if (quota.status !== 'ready' || adapter.status !== 'ready') return h('p', { role: 'status' }, t('loading'))
    const usage = status?.providers.find(row => row.provider === provider)
    const field = key => h('label', { key }, h('span', null, t(key)), h(Input, {
      type: 'number', value: draft?.[key] ?? '', step: ['tokenSafetyFactor', 'jitterRatio'].includes(key) ? '0.05' : '1',
      disabled: !writable || saving || !draft, onChange: event => { setDraft({ ...draft, [key]: event.target.value }); setDirty(true) },
    }))
    return h('div', { className: 'dsh-pq' },
      h('div', null, h('h2', null, t('title')), h('p', { className: 'pq-intro' }, t('intro'))),
      h('label', null, t('provider'), h('select', { value: provider, disabled: saving || dirty, onChange: event => setProvider(event.target.value) },
        providers.map(id => h('option', { key: id, value: id }, id)))),
      !providers.length ? h('p', null, t('noProvider')) : null,
      h('section', { className: 'pq-group' }, h('div', { className: 'pq-actions' }, h('h3', null, t('status')),
        h(Button, { variant: 'outline', size: 'sm', onClick: () => refresh(), disabled: saving }, t('refresh'))),
        statusError ? h('p', { role: 'alert' }, t('failed')) : null,
        h('div', { className: 'pq-stats' }, [['requests', usage?.requests], ['minute', usage?.minuteTokens], ['week', usage?.weekTokens],
          ['cooldown', usage ? Math.ceil(usage.cooldownMs / 1000) : 0]].map(([key, value]) => h('div', { key }, h('span', null, t(key)), value?.toLocaleString() ?? '—')))),
      h('section', { className: 'pq-group' }, h('h3', null, t('limits')), h('div', { className: 'pq-grid' }, quotaFields.map(field)), h('p', { className: 'pq-note' }, t('note'))),
      h('section', { className: 'pq-group' }, h('h3', null, t('recovery')), h('div', { className: 'pq-grid' }, retryFields.map(field)), h('p', { className: 'pq-note' }, t('recoveryNote'))),
      h('div', { className: 'pq-actions' },
        h(Button, { variant: 'primary', disabled: !writable || saving || !draft, onClick: save }, t(saving ? 'saving' : 'save')),
        h(Button, { variant: 'outline', disabled: saving, onClick: () => { loadDraft(); setMessage('') } }, t('discard')),
        enabled ? h(Button, { variant: 'ghost', disabled: !writable || saving, onClick: disable }, t('disable')) : h('span', null, t('enable'))),
      !writable ? h('p', null, t('readOnly')) : null,
      message ? h('p', { role: message === 'saved' ? 'status' : 'alert' }, t(message)) : null,
    )
  }
  return { inject: ['slots', 'locale', 'configForms', 'connection'], apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { en, zh }))
    ctx.effect(() => {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-provider-quota'
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    })
    const t = ctx.locale.bind(NS)
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'provider-quota', order: 18,
      label: () => t('title'), locale: NS,
    }, props => h(Page, { ctx, t: props.t ?? t })))
  } }
} })
