/** Recover a locally oversized summary through native, tool-balanced compaction transactions. */
const oversized = error => error?.code === 'LOCAL_REQUEST_TOO_LARGE'

/**
 * Try the backend's normal selection, then halve balanced prefixes only after a local pre-dispatch rejection.
 * Provider, transport, cancellation, persistence, and commit failures propagate without another attempt.
 * @param {object} engine Native compaction backend.
 * @param {object} agent Agent owning the current surface.
 * @param {AbortSignal} signal Caller and plugin lifetime.
 * @param {object} meter Current positional token prices.
 * @param {Function} loadPairing Load DSH's public tool-pairing predicates.
 * @param {Function} canResume Whether a durable prune already made the original request fit.
 * @returns {Promise<boolean>} Whether a durable reduction permits another budget check.
 */
export async function compactOnce(engine, agent, signal, meter, loadPairing, canResume = async () => false) {
  try { return await engine.compactIfNeeded(agent, 'context-overflow', signal) !== null }
  catch (error) {
    signal.throwIfAborted()
    if (!oversized(error)) throw error
    if (await canResume()) return true
  }
  const { toolPairingBalancedBefore: before, toolPairingBalancedAfter: after } = await loadPairing()
  signal.throwIfAborted()
  const session = agent.session
  const nodes = meter.measure(session).nodes
  if (nodes.length !== session.surface.nodes.length || nodes.some((node, index) => node.seq !== session.surface.nodes[index])) {
    throw new Error('provider-quota: token prices do not match the current session surface')
  }
  // Keep the canonical system head (including an empty projected head) and the latest surface unit.
  let start = session.deriveMessages()[0]?.role === 'system' || nodes[0]?.tokens === 0 ? 1 : 0
  while (start < nodes.length - 1 && !before(session, nodes[start].seq)) start++
  const ends = []
  for (let index = start; index < nodes.length - 1; index++) if (after(session, nodes[index].seq)) ends.push(index)
  // The largest prefix just failed; every fallback must be strictly shorter, even with a single giant tool group.
  for (let cut = Math.floor(ends.length / 2) - 1; cut >= 0; cut = Math.floor((cut + 1) / 2) - 1) {
    signal.throwIfAborted()
    try {
      await engine.compactRegion(nodes[start].seq, nodes[ends[cut]].seq, agent, signal)
      return true
    } catch (error) {
      signal.throwIfAborted()
      if (!oversized(error)) throw error
    }
  }
  throw Object.assign(new Error('无法在共享额度内生成摘要：最小的完整历史段或固定提示仍然过大。请降低当前预设压缩后端的摘要输出上限，或拆分大段输入。'), { code: 'LOCAL_COMPACTION_UNSPLITTABLE' })
}
