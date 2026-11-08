/** Validated live provider policies; state files are separate from editable settings. */
import z from '@deepseek-ai/schemastery'
import { isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const defaults = Object.freeze({
  requestsPerMinute: 10, tokensPerMinute: 300000, tokensPerWeek: 1000000000,
  minIntervalMs: 7000, maxOutputTokens: 16384, tokenSafetyFactor: 1.25,
  windowMarginMs: 250, lockPollMs: 500, throttleCooldownMs: 60000,
  compactionThresholdTokens: 180000, requestHeadroomTokens: 4096,
})
const positive = value => Number.isSafeInteger(value) && value > 0
export function parseConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('provider-quota: expected config object')
  for (const key of Object.keys(raw)) if (!['stateDirectory', 'providers'].includes(key)) throw new Error(`provider-quota: unknown config field ${key}`)
  const stateDirectory = raw.stateDirectory ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'provider-quota')
  if (typeof stateDirectory !== 'string' || !isAbsolute(stateDirectory)) throw new Error('provider-quota: stateDirectory must be absolute')
  const sourceProviders = raw.providers?.get instanceof Function ? raw.providers.get() : raw.providers
  if (!sourceProviders || typeof sourceProviders !== 'object' || Array.isArray(sourceProviders)) throw new Error('provider-quota: providers must be an object')
  const providers = Object.create(null)
  for (const [provider, source] of Object.entries(sourceProviders)) {
    if (!provider || ['__proto__', 'constructor', 'prototype'].includes(provider) || !source || typeof source !== 'object' || Array.isArray(source)) throw new Error('provider-quota: invalid provider configuration')
    for (const key of Object.keys(source)) if (!Object.hasOwn(defaults, key)) throw new Error(`provider-quota: unknown field ${provider}.${key}`)
    const policy = { ...defaults, ...source }
    for (const [key, value] of Object.entries(policy)) {
      if (!(key === 'tokenSafetyFactor' ? Number.isFinite(value) && value >= 1 : positive(value))) throw new Error(`provider-quota: invalid ${provider}.${key}`)
    }
    if (policy.maxOutputTokens + policy.requestHeadroomTokens >= policy.tokensPerMinute || policy.tokensPerMinute > policy.tokensPerWeek
      || policy.compactionThresholdTokens + policy.maxOutputTokens + policy.requestHeadroomTokens >= policy.tokensPerMinute) {
      throw new Error(`provider-quota: ${provider} requires compaction threshold + output + headroom < TPM <= weekly tokens`)
    }
    providers[provider] = policy
  }
  return { stateDirectory, providers }
}
const policySchema = z.object(Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key,
  (key === 'tokenSafetyFactor' ? z.number().min(1) : z.number().step(1).min(1)).default(value),
])))
export const Config = z.object({
  stateDirectory: z.string(),
  providers: z.dict(policySchema).default({}).volatile(),
})
// Keep the object metadata for DSH forms and volatile updates, and validate related budgets together.
const standard = Config['~standard']
Object.defineProperty(Config, '~standard', { get: () => ({ ...standard, validate(raw) {
  const result = standard.validate(raw)
  if (result.issues) return result
  try { parseConfig(result.value); return result }
  catch (error) { return { issues: [{ message: error.message }] } }
} }) })
