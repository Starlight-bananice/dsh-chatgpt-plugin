/**
 * The ChatGPT-plan adapter: one provider route over OpenAI's Responses API,
 * authenticated by the SIWC OAuth access token.
 *
 * This is a duck-typed implementation of the harness's adapter contract rather
 * than a subclass of its `LlmAdapter` class: a plugin outside the harness tree
 * cannot rely on class identity across package copies, and the registry checks
 * behavior (route identity, non-empty name, a `stream()` method) rather than
 * `instanceof`. The shape of every returned value is the documented one.
 *
 * Transport failures and protocol violations **throw**, which the runtime
 * normalizes into a terminal failure; provider-reported failures that arrive
 * in-band — a usage limit surfacing mid-stream, for instance — end the stream
 * with `finish {kind:'error'}`, exactly as the adapter contract prescribes.
 *
 * @module dsh-chatgpt-provider/adapter
 */
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { CredentialStoreLike } from './accounts.ts';
import { type Config } from './config.ts';
import type { ResolvedImage } from './serialize.ts';
/** The single provider route this plugin owns. */
export declare const PROVIDER = "chatgpt";
/** What the adapter needs from the plugin that owns it. */
export interface ChatGptAdapterDeps {
    /** The current resolved configuration, read per call. */
    config: () => Config;
    /** The credential seam, read per call so a settings change is seen at once. */
    credentials: () => CredentialStoreLike | undefined;
    /** The record id of the account a request bills, or `undefined` when none is saved. */
    accountId: () => Promise<string | undefined>;
    /** Resolve stored image bytes through the attachment seam. */
    readImage: (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<ResolvedImage>;
    /** Report a decision worth an operator's attention. */
    onNotice: (message: string) => void;
    /**
     * The API base this adapter calls. Production omits it and gets the official
     * one; the seam exists so the request path — headers, payload, streaming, and
     * image inlining — can be exercised end to end against a local server. Like
     * the OAuth endpoints, it is deliberately not user-configurable: a deployment
     * that could repoint it from a settings file could be talked into sending an
     * access token elsewhere.
     */
    apiBase?: () => string;
}
/** The adapter instance handed to `ctx.llm.registerAdapter()`. */
export declare class ChatGptAdapter {
    private readonly deps;
    private cache;
    constructor(deps: ChatGptAdapterDeps);
    /** Display metadata for the route; the id must equal the registered route. */
    providerInfo(provider: string): LlmProviderInfo;
    /** The policy the registry captures for this route. */
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
    /**
     * List the signed-in account's models.
     *
     * Advisory by contract: a listing failure degrades the picker rather than the
     * request path, so a transport error yields the configured fallback catalog
     * (or an empty list) instead of throwing into a selector.
     * @param _provider - this adapter's sole route.
     * @returns the models to offer, in the account's order.
     */
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * Append the configured extras to the account's own listing.
     *
     * Configured entries come last and never displace a listed model: the account
     * is the authority on what it offers, and an extra is a deliberate addition
     * the listing simply does not mention.
     * @param listed - the models the account reported.
     * @returns the account's models followed by any configured extras.
     */
    private withConfigured;
    /**
     * Describe one exact model.
     *
     * Context capacity is reported only when it is actually known — from a
     * cached listing or the configured catalog. Reporting a guessed window would
     * let compaction misjudge the budget, and the contract is explicit that an
     * absent field preserves unknown capacity rather than inviting a default.
     * @param provider - this adapter's sole route.
     * @param model - the exact model id.
     * @param signal - cancellation for any lookup.
     * @returns identity plus whatever capacity and reasoning metadata is known.
     */
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * Bind one exact model's metadata and the eventual dispatch to this
     * generation.
     *
     * Implemented rather than inherited (this adapter is duck-typed, not a
     * subclass): the registry's contract expects a dynamic adapter to resolve
     * metadata and hand back a stream entry point bound to the same generation, so
     * a configuration change landing between preparation and dispatch cannot pair
     * one generation's capabilities with another's endpoint. Everything this
     * adapter needs is read from a single closure over the live configuration, so
     * binding means resolving now and streaming through the same instance.
     * @param provider - this adapter's sole route.
     * @param model - the exact model id.
     * @param signal - cancellation for model resolution.
     * @returns the resolved metadata and the generation-bound stream entry point.
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /**
     * Stream one model call.
     * @param options - the harness's assembled request.
     * @returns the translated chunk stream.
     * @throws {ChatGptError} on a missing account, a rejected request, or an unusable response body.
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** The API base for this generation, read per call so a swap reaches the next request. */
    private base;
    /** Map one catalog entry onto the harness's advisory model metadata. */
    private toInfo;
    /** Just the configured extras, for a listing that could not be read. */
    private configuredOnly;
}
/**
 * The account a request should bill.
 *
 * A configured id that is no longer saved falls back to the newest sign-in
 * rather than resolving to nothing: signing one account out while another
 * remains must not leave the provider unable to serve at all. The caller warns
 * when this happens, because the selection silently stopped meaning what it
 * said.
 * @param credentials - the credential seam, when one is mounted.
 * @param configured - the record id the settings section names, if any.
 * @returns the account to bill, or `undefined` when none is saved.
 */
export declare function resolveAccountId(credentials: CredentialStoreLike | undefined, configured: string | undefined): Promise<string | undefined>;
