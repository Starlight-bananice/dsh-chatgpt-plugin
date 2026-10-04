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
/** One advisory catalog entry, used when the account listing is unavailable. */
export interface ConfigModel {
    id: string;
    name?: string;
    contextWindow?: number;
}
/** Reasoning levels this route can spell, in escalation order. */
export declare const KNOWN_EFFORTS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** One level this route can spell. */
export type KnownEffort = (typeof KNOWN_EFFORTS)[number];
/** Plugin config / `chatgpt` settings-section shape. */
export interface Config {
    /** Provider name shown in selectors; defaults to `ChatGPT`. */
    displayName?: string;
    /** Record id of the saved account to use; omission uses the most recent. */
    account?: string;
    /** App name shown on the ChatGPT consent screen, first registration only. */
    agentName?: string;
    /** Reasoning levels offered by the picker, in display order. */
    reasoningEfforts?: string[];
    /** Default level applied when a request names none; omission uses the provider default. */
    reasoningEffort?: string;
    /** Loopback port the OAuth callback tries first (default 1455). */
    callbackPort?: number;
    /** Raw-byte ceiling for one inlined image (default 8 MiB). */
    maxImageBytes?: number;
    /** Raw-byte ceiling for all inlined images in one request (default 24 MiB). */
    maxInlineImageBytes?: number;
    /**
     * Extra models to offer besides the account's own listing.
     *
     * The listing is what the account reports, and it is narrower than what the
     * models can actually be asked for — a companion client's bundled catalog
     * names models this endpoint does not return, and those ids work when
     * requested. Nothing is added unless it is named here, because showing a
     * model that turns out to be unavailable is worse than omitting it.
     */
    models?: ConfigModel[];
    /**
     * Model the connectivity probe asks. Omission prefers a `luna` model and
     * otherwise takes the account's first listed model.
     */
    testModel?: string;
}
export declare const Config: z<Config>;
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
export declare function assertServiceable(config: Config): Config;
