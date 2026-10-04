/**
 * Response-stream translation: Responses SSE events into harness chunks.
 *
 * Two documented properties drive the shape of this module:
 *
 * - Inference counts as successful **only** after `response.completed`; a stream
 *   that ends without a terminal event is a failure, not an empty answer.
 * - A usage-limit failure can arrive *after* streaming has begun, as
 *   `response.failed` carrying `error.code` such as
 *   `subscription_sharing_usage_limit_exceeded`. That is an in-band provider
 *   failure, so it becomes a terminal `finish {kind:'error'}` rather than a
 *   thrown transport error.
 *
 * Block indexes are allocated in first-seen stream order and reused for every
 * delta of the same block, which is what lets the harness assemble interleaved
 * text and tool calls. Tool-call arguments stay raw JSON strings end to end.
 *
 * @module dsh-chatgpt-provider/stream
 */
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ChatGptError } from './errors.ts';
/**
 * Translate a Responses event stream into harness chunks.
 *
 * @param body - the response body stream.
 * @param onFailure - receives a provider failure discovered in-band, for logging.
 * @returns the chunk stream, ending with exactly one terminal `finish`.
 */
export declare function translateStream(body: ReadableStream<Uint8Array>, onFailure?: (error: ChatGptError) => void): AsyncIterable<StreamChunk>;
/** Whether a provider code names a ChatGPT-plan condition worth its own message. */
export declare function planCodeOf(text: string): string | undefined;
