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
import { ChatGptError } from "./errors.js";
/** Wire spelling of a reasoning effort; the adapter's ids are these names. */
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** Default ceiling on accumulated inlined image payload, before base64 expansion. */
const DEFAULT_MAX_INLINE_IMAGE_BYTES = 24 * 1024 * 1024;
/** Default ceiling on one inlined image, before base64 expansion. */
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Whether a value is a plausible native output item list. */
function isItemList(value) {
    if (!Array.isArray(value))
        return false;
    return value.every((entry) => {
        if (typeof entry !== 'object' || entry === null)
            return false;
        const type = entry['type'];
        return typeof type === 'string' && type !== '';
    });
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
export function replayItemsFor(message, blockCount) {
    const source = message.source;
    if (source.kind !== 'model' || source.provider !== 'chatgpt')
        return undefined;
    const envelope = source.replayState;
    if (typeof envelope !== 'object' || envelope === null)
        return undefined;
    const record = envelope;
    if (record.blocks !== undefined && Array.isArray(record.blocks) && record.blocks.length !== blockCount) {
        return undefined;
    }
    const response = record.response;
    if (typeof response !== 'object' || response === null)
        return undefined;
    const items = response['items'];
    return isItemList(items) ? items : undefined;
}
/** Render one user-role message's text/image blocks into Responses content parts. */
async function userContentParts(blocks, deps, budget, signal) {
    const parts = [];
    for (const block of blocks) {
        if (block.type === 'text') {
            if (block.text !== '')
                parts.push({ type: 'input_text', text: block.text });
            continue;
        }
        if (block.type !== 'image')
            continue;
        const limit = deps.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
        const total = deps.maxInlineImageBytes ?? DEFAULT_MAX_INLINE_IMAGE_BYTES;
        if (deps.readImage === undefined) {
            parts.push({ type: 'input_text',
                text: '[image omitted: this deployment mounts no attachment service to resolve it]' });
            continue;
        }
        if (block.attachment.bytes > limit || budget.used + block.attachment.bytes > total) {
            // Deterministic refusal rather than a silently shortened message: the
            // placeholder states what happened, and the operator sees the same fact.
            deps.onNotice?.(`chatgpt: omitting an image of ${String(block.attachment.bytes)} bytes; `
                + `per-image limit ${String(limit)} and per-request budget ${String(total)} apply`);
            parts.push({ type: 'input_text', text: '[image omitted: exceeds this adapter\'s request image budget]' });
            continue;
        }
        const resolved = await deps.readImage(block.attachment, signal);
        budget.used += resolved.data.byteLength;
        const base64 = Buffer.from(resolved.data).toString('base64');
        parts.push({
            type: 'input_image',
            // The documented spelling is `image_url`, and inline bytes ride a data URL.
            image_url: `data:${resolved.ref.mediaType};base64,${base64}`,
            detail: 'auto',
        });
    }
    return parts;
}
/** Collapse a tool result's TEXT content into the single string this route takes. */
function toolOutput(blocks) {
    const parts = [];
    for (const block of blocks) {
        if (block.type === 'text')
            parts.push(block.text);
        else if (block.type === 'image')
            parts.push(TOOL_IMAGE_ANNOUNCEMENT);
    }
    return parts.join('\n');
}
/**
 * Text left in `function_call_output` where an image used to be dropped.
 *
 * `function_call_output` carries text, so an image cannot ride the output item
 * itself. Dropping it there and nowhere else lost the picture entirely: the
 * tool had read the pixels and the model never saw them, which broke every
 * screen-check, visual page validation, and Office layout review. The image is
 * now re-attached as its own user message right after the outputs (see
 * `toolResultImagePart`), and this line keeps the output item self-describing
 * for an auditor reading the transcript.
 */
const TOOL_IMAGE_ANNOUNCEMENT = '[image result follows in the next user message, as an image input]';
/**
 * Serialize ONE image a tool returned, as an `input_image` part.
 *
 * Deliberately the same path user-supplied images take — the same
 * `deps.readImage` seam, the same per-image and per-request byte ceilings, the
 * same data-URL spelling, and the same deterministic text placeholder when the
 * image cannot be sent. A second, weaker path for tool images would be a second
 * set of failure modes.
 *
 * @param block - the image content block from a tool result.
 * @param deps - attachment access and the byte ceilings.
 * @param budget - accumulated per-request image bytes, mutated on success.
 * @param signal - the request's cancellation signal.
 * @param count - how many images this same tool result returned, for the notice.
 * @returns the `input_image` part, or the placeholder part that replaced it.
 */
async function toolResultImagePart(block, deps, budget, signal, count) {
    const limit = deps.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    const total = deps.maxInlineImageBytes ?? DEFAULT_MAX_INLINE_IMAGE_BYTES;
    const notice = (reason) => {
        deps.onNotice?.(`chatgpt: omitting an image returned by a tool (${String(count)} in this result); ${reason}`);
        return { type: 'input_text', text: `[tool image omitted: ${reason}]` };
    };
    if (deps.readImage === undefined) {
        return notice('this deployment mounts no attachment service to resolve it');
    }
    if (block.attachment.bytes > limit) {
        return notice(`per-image limit ${String(limit)} bytes, image is ${String(block.attachment.bytes)}`);
    }
    if (budget.used + block.attachment.bytes > total) {
        return notice(`per-request image budget ${String(total)} bytes already reached`);
    }
    const resolved = await deps.readImage(block.attachment, signal);
    budget.used += resolved.data.byteLength;
    return {
        type: 'input_image',
        image_url: `data:${resolved.ref.mediaType};base64,${Buffer.from(resolved.data).toString('base64')}`,
        detail: 'auto',
    };
}
/**
 * Build the request body for one model call.
 * @param options - the harness's assembled request.
 * @param deps - attachment access and the image budget.
 * @returns the JSON body to POST to `/v1/responses`.
 * @throws {ChatGptError} `UNSUPPORTED` for a field this route cannot honor.
 */
export async function serializeRequest(options, deps = {}) {
    // Fields the ChatGPT-plan route does not accept. Each is refused rather than
    // dropped: a caller that set one is entitled to know it did not apply.
    if (options.temperature !== undefined) {
        throw new ChatGptError('chatgpt: this route does not accept `temperature`; ChatGPT plan usage omits sampling controls', 'UNSUPPORTED');
    }
    if (options.maxTokens !== undefined) {
        throw new ChatGptError('chatgpt: this route does not accept `maxTokens` (`max_output_tokens` is unsupported on ChatGPT '
            + 'plan usage); remove the request output cap', 'UNSUPPORTED');
    }
    if (options.stop !== undefined && options.stop.length > 0) {
        throw new ChatGptError('chatgpt: this route does not accept `stop` sequences; remove them from the request', 'UNSUPPORTED');
    }
    const budget = { used: 0 };
    const input = [];
    const systemTexts = [];
    if (options.system !== undefined && options.system !== '')
        systemTexts.push(options.system);
    for (const message of options.messages) {
        if (message.role === 'system') {
            // No system item may appear in `input`; the instructions slot owns it.
            const text = message.content.map(block => block.type === 'text' ? block.text : '').join('\n');
            if (text !== '')
                systemTexts.push(text);
            continue;
        }
        if (message.role === 'assistant') {
            const replayed = replayItemsFor(message, message.content.length);
            if (replayed !== undefined) {
                // Native echo: preserves reasoning items, their encrypted content, and
                // the assistant phase, none of which survive reconstruction.
                input.push(...replayed);
                continue;
            }
            const text = message.content
                .filter(block => block.type === 'text')
                .map(block => block.text)
                .join('');
            if (text !== '') {
                // An assistant-role message accepts `output_text` (or `refusal`) parts —
                // never `input_text`, which this route rejects with `invalid_value` and a
                // pointer at the offending part. The distinction only bites once a
                // conversation has an assistant turn to replay, so a single-turn probe
                // cannot reveal it.
                input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
            }
            for (const block of message.content) {
                if (block.type !== 'tool-call')
                    continue;
                input.push({
                    type: 'function_call',
                    call_id: block.id,
                    name: block.name,
                    // Arguments stay the raw JSON string the model produced.
                    arguments: block.arguments,
                });
            }
            // Reasoning blocks are display-only here: without the native item there
            // is nothing faithful to send back, and inventing one would be worse.
            continue;
        }
        // User role. Tool results become their own items; text and images become
        // one message, in block order.
        const contentParts = await userContentParts(message.content.filter(block => block.type === 'text' || block.type === 'image'), deps, budget, options.signal);
        if (contentParts.length > 0)
            input.push({ role: 'user', content: contentParts });
        for (const block of message.content) {
            if (block.type !== 'tool-result')
                continue;
            input.push({
                type: 'function_call_output',
                call_id: block.toolCallId,
                output: toolOutput(block.content),
            });
            // Images a tool returned cannot ride `function_call_output`, which takes
            // text. They follow as one user message per result, immediately after it,
            // so the visual order of the conversation is preserved. Native items that
            // belong to this result keep preceding them, and order within `input` is
            // the only thing this stateless route sends.
            const images = block.content.filter((part) => part.type === 'image');
            if (images.length === 0)
                continue;
            const parts = [];
            for (const image of images) {
                parts.push(await toolResultImagePart(image, deps, budget, options.signal, images.length));
            }
            if (parts.length > 0)
                input.push({ role: 'user', content: parts });
        }
    }
    const tools = (options.tools ?? []).map(tool => ({
        // Flat shape: this API has no nested `function` wrapper.
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    }));
    const body = {
        model: options.model,
        input,
        // Both are mandatory on every HTTP request in this flow.
        store: false,
        stream: true,
    };
    if (systemTexts.length > 0)
        body['instructions'] = systemTexts.join('\n\n');
    if (tools.length > 0)
        body['tools'] = tools;
    const effort = options.reasoningEffort;
    if (effort !== undefined) {
        // There is no "off" spelling on this route: its reasoning models refuse
        // `none`, so an effort that would disable reasoning is refused here rather
        // than silently dropped — a caller that asked for no reasoning is entitled
        // to know it did not get it.
        if (!REASONING_EFFORTS.has(effort)) {
            throw new ChatGptError(`chatgpt: reasoning effort "${effort}" is not one this route accepts; supported levels are `
                + `${[...REASONING_EFFORTS].join(', ')}`, 'UNSUPPORTED');
        }
        // `summary: auto` is what makes reasoning legible to the harness: without
        // it a reasoning item arrives with an empty summary and no text to show.
        body['reasoning'] = { effort, summary: 'auto' };
    }
    return body;
}
//# sourceMappingURL=serialize.js.map