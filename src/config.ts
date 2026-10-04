/**
 * Plugin configuration, doubling as the `chatgpt` user-settings section.
 *
 * Every field is optional, because the plugin's normal posture is
 * configuration-free: signing in is what makes the provider usable, and the
 * model list comes from the account rather than from this file. The fields that
 * do exist are the ones a deployment genuinely varies — which saved account to
 * bill, what the provider is called, how much image payload may be inlined, and
 * which reasoning levels the picker offers.
 *
 * @module dsh-chatgpt-provider/config
 */

import z from '@deepseek-ai/schemastery'

/** One advisory catalog entry, used when the account listing is unavailable. */
export interface ConfigModel {
  id: string
  name?: string
  contextWindow?: number
}

/** Reasoning levels this route can spell, in escalation order. */
export const KNOWN_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One level this route can spell. */
export type KnownEffort = (typeof KNOWN_EFFORTS)[number]

/**
 * The levels offered by default, in escalation order.
 *
 * `off` is deliberately absent: disabling reasoning is not a level this route's
 * models accept — the wire value that would express it is refused — so offering
 * it would propose a request the route rejects. `minimal` is left out for the
 * same reason on this model family. Support for `xhigh` and `max` is
 * model-dependent, but they are the documented top of the range, and a model
 * that lacks one says so with a clear error rather than silently ignoring it.
 */
const DEFAULT_EFFORTS: readonly KnownEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Plugin config / `chatgpt` settings-section shape. */
export interface Config {
  /** Provider name shown in selectors; defaults to `ChatGPT`. */
  displayName?: string
  /** Record id of the saved account to use; omission uses the most recent. */
  account?: string
  /** App name shown on the ChatGPT consent screen, first registration only. */
  agentName?: string
  /** Reasoning levels offered by the picker, in display order. */
  reasoningEfforts?: string[]
  /** Default level applied when a request names none; omission uses the provider default. */
  reasoningEffort?: string
  /** Loopback port the OAuth callback tries first (default 1455). */
  callbackPort?: number
  /** Raw-byte ceiling for one inlined image (default 8 MiB). */
  maxImageBytes?: number
  /** Raw-byte ceiling for all inlined images in one request (default 24 MiB). */
  maxInlineImageBytes?: number
  /**
   * Extra models to offer besides the account's own listing.
   *
   * The listing is what the account reports, and it is narrower than what the
   * models can actually be asked for — a companion client's bundled catalog
   * names models this endpoint does not return, and those ids work when
   * requested. Nothing is added unless it is named here, because showing a
   * model that turns out to be unavailable is worse than omitting it.
   */
  models?: ConfigModel[]
  /**
   * Model the connectivity probe asks. Omission prefers a `luna` model and
   * otherwise takes the account's first listed model.
   */
  testModel?: string
}

const modelSchema = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
}) as unknown as z<ConfigModel>

export const Config = z.object({
  displayName: z.string().default('ChatGPT'),
  account: z.string(),
  agentName: z.string().default('DeepSeek Harness'),
  // Spread into a mutable array: the union helper takes the tuple by value.
  reasoningEfforts: z.array(z.union([...KNOWN_EFFORTS])).default([...DEFAULT_EFFORTS]),
  reasoningEffort: z.union([...KNOWN_EFFORTS]),
  callbackPort: z.number().step(1).min(1024).max(65535).default(1455),
  maxImageBytes: z.number().step(1).min(1).default(8 * 1024 * 1024),
  maxInlineImageBytes: z.number().step(1).min(1).default(24 * 1024 * 1024),
  models: z.array(modelSchema).default([]),
  testModel: z.string(),
}) as unknown as z<Config>

/**
 * Re-judge a raw config the schema did not normalize.
 *
 * Programmatic construction can bypass Schemastery, so cross-field facts are
 * checked here: the default effort must be one the picker actually offers, the
 * per-image ceiling cannot exceed the per-request budget that contains it, and
 * the catalog must not name the same model twice.
 * @param config - raw plugin config or a resolved settings snapshot.
 * @returns the validated config, unchanged.
 * @throws {Error} naming the field that cannot hold.
 */
export function assertServiceable(config: Config): Config {
  const efforts = config.reasoningEfforts ?? DEFAULT_EFFORTS
  if (efforts.length === 0) throw new Error('chatgpt: reasoningEfforts must name at least one level')
  if (new Set(efforts).size !== efforts.length) {
    throw new Error('chatgpt: reasoningEfforts must not repeat a level')
  }
  if (config.reasoningEffort !== undefined && !(efforts as readonly string[]).includes(config.reasoningEffort)) {
    throw new Error('chatgpt: reasoningEffort must be one of reasoningEfforts')
  }
  const perImage = config.maxImageBytes ?? 8 * 1024 * 1024
  const perRequest = config.maxInlineImageBytes ?? 24 * 1024 * 1024
  if (perImage > perRequest) {
    throw new Error('chatgpt: maxImageBytes must not exceed maxInlineImageBytes')
  }
  const ids = (config.models ?? []).map(model => model.id)
  if (ids.some(id => id === '')) throw new Error('chatgpt: catalog model ids must be non-empty')
  if (new Set(ids).size !== ids.length) throw new Error('chatgpt: duplicate catalog model id')
  return config
}
