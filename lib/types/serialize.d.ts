/**
 * Request serialization for the ChatGPT-plan Responses route.
 *
 * This module exists because the ChatGPT-plan route is a **restricted** view of
 * the Responses API, not the general one. Its documented requirements shape
 * every decision here:
 *
 * - `store: false` and `stream: true` on every request.
 * - `input` must be an array carrying the whole needed context; there is no
 *   `previous_response_id` continuation over HTTP.
 * - A `{type:"message", role:"system"}` item is **rejected**. The system slot is
 *   therefore `instructions`, which the docs define as the developer/system
 *   message, and any system-role message in the history is folded into it.
 * - A list of fields is unsupported and must be omitted: `background`,
 *   `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`,
 *   `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`,
 *   `safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation`,
 *   `user`, and `previous_response_id`.
 * - Tools are **flat** at the top level: `{type:"function", name, …}`, never
 *   nested under a `function` key.
 *
 * Three request fields the harness can supply have no supported spelling on
 * this route. Silently dropping them would let a caller believe a sampling or
 * cap setting took effect, so each one throws `UNSUPPORTED` instead — the
 * behavior the adapter contract prescribes for a field a provider cannot honor.
 *
 * @module dsh-chatgpt-provider/serialize
 */
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
/** A resolved image, as much of it as serialization needs. */
export interface ResolvedImage {
    ref: ImageAttachmentRef;
    data: Uint8Array;
}
/** What serialization needs from the surrounding plugin. */
export interface SerializeDeps {
    /** Read stored image bytes, or `undefined` when the attachment seam is absent. */
    readImage?: (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<ResolvedImage>;
    /** Report a decision that changed the request (an image dropped for budget). */
    onNotice?: (message: string) => void;
    /** Ceiling on one image's raw bytes. */
    maxImageBytes?: number;
    /** Ceiling on accumulated raw image bytes per request. */
    maxInlineImageBytes?: number;
}
/**
 * The adapter-private replay payload stored on an assistant message's model
 * source. It carries the response's native output items verbatim: this route is
 * stateless, and the docs require reasoning items returned alongside tool calls
 * to be passed back with the tool outputs, which only a native echo can do
 * faithfully (`encrypted_content` and the assistant `phase` have no neutral
 * representation).
 */
export interface ResponsesReplay {
    /** The `response.output` array from the completed response, verbatim. */
    items: readonly unknown[];
}
/**
 * Recover the native items to replay for one assistant message.
 *
 * The harness already withholds this state unless the same adapter instance
 * owns both the historical and the target route, so only the shape and the
 * block-count agreement the seam documents are re-checked here. A mismatch
 * discards the whole envelope rather than replaying part of a response: the
 * seam drops per-block entries positionally when it drops a block, so a length
 * disagreement means the stored metadata no longer describes the stored
 * content, and reconstructing neutrally is the safe fallback.
 * @param message - a history message.
 * @param blockCount - the number of content blocks about to be serialized.
 * @returns the native items to emit, or `undefined` to reconstruct instead.
 */
export declare function replayItemsFor(message: Message, blockCount: number): unknown[] | undefined;
/**
 * Build the request body for one model call.
 * @param options - the harness's assembled request.
 * @param deps - attachment access and the image budget.
 * @returns the JSON body to POST to `/v1/responses`.
 * @throws {ChatGptError} `UNSUPPORTED` for a field this route cannot honor.
 */
export declare function serializeRequest(options: GenerateOptions, deps?: SerializeDeps): Promise<Record<string, unknown>>;
