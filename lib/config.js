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
import z from '@deepseek-ai/schemastery';
/** Reasoning levels this route can spell, in escalation order. */
export const KNOWN_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
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
const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const modelSchema = z.object({
    id: z.string().required(),
    name: z.string(),
    contextWindow: z.number().step(1).min(1),
});
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
});
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
export function assertServiceable(config) {
    const efforts = config.reasoningEfforts ?? DEFAULT_EFFORTS;
    if (efforts.length === 0)
        throw new Error('chatgpt: reasoningEfforts must name at least one level');
    if (new Set(efforts).size !== efforts.length) {
        throw new Error('chatgpt: reasoningEfforts must not repeat a level');
    }
    if (config.reasoningEffort !== undefined && !efforts.includes(config.reasoningEffort)) {
        throw new Error('chatgpt: reasoningEffort must be one of reasoningEfforts');
    }
    const perImage = config.maxImageBytes ?? 8 * 1024 * 1024;
    const perRequest = config.maxInlineImageBytes ?? 24 * 1024 * 1024;
    if (perImage > perRequest) {
        throw new Error('chatgpt: maxImageBytes must not exceed maxInlineImageBytes');
    }
    const ids = (config.models ?? []).map(model => model.id);
    if (ids.some(id => id === ''))
        throw new Error('chatgpt: catalog model ids must be non-empty');
    if (new Set(ids).size !== ids.length)
        throw new Error('chatgpt: duplicate catalog model id');
    return config;
}
//# sourceMappingURL=config.js.map