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

import type { ContentBlock, StreamChunk, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { PLAN_CODES, providerCodeOf } from './errors.ts'
import type { ChatGptError } from './errors.ts'

/** Reason a terminal event reported for an incomplete response. */
interface IncompleteDetails {
  reason?: string
}

/** Split a byte stream into SSE `data:` payloads. */
async function * ssePayloads(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE frames are separated by a blank line; tolerate CRLF and LF alike.
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer)
        if (boundary === null) break
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const payload = frame
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n')
        if (payload !== '') yield payload
      }
    }
    // A final frame that the server closed without a trailing blank line still
    // carries its payload.
    for (const line of buffer.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trimStart()
      if (payload !== '') yield payload
    }
  } finally {
    reader.releaseLock()
  }
}

/** Read a string field without trusting the event's shape. */
function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

/** Read a number field without trusting the event's shape. */
function num(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read a nested object field without trusting the event's shape. */
function obj(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = source[key]
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * Map the response's usage block onto the harness's disjoint token counts.
 *
 * The harness defines `inputTokens` as **uncached** input only, with cached and
 * cache-write input reported separately, while the provider reports a total
 * `input_tokens` that already includes them. The cache fields are therefore
 * subtracted out rather than double-counted.
 * @param usage - the `usage` object from a terminal event.
 * @returns a usage chunk payload, or `undefined` when nothing usable is present.
 */
function toUsage(usage: Record<string, unknown> | undefined): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
} | undefined {
  if (usage === undefined) return undefined
  const input = num(usage, 'input_tokens')
  const output = num(usage, 'output_tokens')
  if (input === undefined || output === undefined) return undefined
  const details = obj(usage, 'input_tokens_details')
  const cached = details === undefined ? undefined : num(details, 'cached_tokens')
  const cacheWrite = details === undefined ? undefined : num(details, 'cache_write_tokens')
  const outputDetails = obj(usage, 'output_tokens_details')
  const reasoning = outputDetails === undefined ? undefined : num(outputDetails, 'reasoning_tokens')
  const cachedTokens = cached ?? 0
  return {
    inputTokens: Math.max(0, input - cachedTokens - (cacheWrite ?? 0)),
    outputTokens: output,
    ...cached === undefined ? {} : { cacheReadTokens: cached },
    ...cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

/** One in-flight block, keyed by the stream's `output_index`. */
interface OpenBlock {
  /** Harness block index, allocated in first-seen order. */
  index: number
  type: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** Tool-call identity, captured from the item that opened the block. */
  callId?: string
  name?: string
  arguments: string
  /** Native item index this block came from, recorded for replay metadata. */
  outputIndex: number
}

/**
 * Translate a Responses event stream into harness chunks.
 *
 * @param body - the response body stream.
 * @param onFailure - receives a provider failure discovered in-band, for logging.
 * @returns the chunk stream, ending with exactly one terminal `finish`.
 */
export async function * translateStream(
  body: ReadableStream<Uint8Array>,
  onFailure?: (error: ChatGptError) => void,
): AsyncIterable<StreamChunk> {
  /** Harness block index per `output_index`, allocated on first sight. */
  const indexes = new Map<number, number>()
  /** Blocks currently open, so a delta can find its block without re-deriving it. */
  const open = new Map<number, OpenBlock>()
  /** Per-block replay entries, in emitted block order. */
  const blockEntries: unknown[] = []
  let nextIndex = 0
  let sawTerminal = false
  let sawToolCall = false

  const indexFor = (outputIndex: number): number => {
    const existing = indexes.get(outputIndex)
    if (existing !== undefined) return existing
    const allocated = nextIndex
    nextIndex += 1
    indexes.set(outputIndex, allocated)
    return allocated
  }

  /** Close one open block, emitting its assembled form. */
  function * close(outputIndex: number): Generator<StreamChunk> {
    const block = open.get(outputIndex)
    if (block === undefined) return
    open.delete(outputIndex)
    let assembled: ContentBlock
    if (block.type === 'tool-call') {
      const id = block.callId ?? `call_${String(outputIndex)}`
      const call: ToolCallBlock = {
        type: 'tool-call',
        id: id as ToolCallBlock['id'],
        name: block.name ?? '',
        arguments: block.arguments,
      }
      assembled = call
      sawToolCall = true
    } else if (block.type === 'reasoning') {
      assembled = { type: 'reasoning', text: block.text }
    } else {
      assembled = { type: 'text', text: block.text }
    }
    blockEntries.push({ outputIndex, kind: block.type })
    yield { type: 'block-end', index: block.index, block: assembled }
  }

  /** Open a block for one `output_index` if it is not already open. */
  function * start(
    outputIndex: number,
    type: OpenBlock['type'],
    seed: Partial<OpenBlock> = {},
  ): Generator<StreamChunk> {
    if (open.has(outputIndex)) return
    const index = indexFor(outputIndex)
    open.set(outputIndex, { index, type, text: '', arguments: '', outputIndex, ...seed })
    yield { type: 'block-start', index, blockType: type }
  }

  for await (const payload of ssePayloads(body)) {
    let event: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(payload)
      if (typeof parsed !== 'object' || parsed === null) continue
      event = parsed as Record<string, unknown>
    } catch {
      // A payload that is not JSON cannot be acted on; the stream's terminal
      // event is still required before success is reported, so skipping here
      // cannot turn a broken stream into a successful one.
      continue
    }
    const type = str(event, 'type')
    if (type === undefined) continue
    const outputIndex = num(event, 'output_index')

    switch (type) {
      case 'response.output_item.added': {
        const item = obj(event, 'item')
        if (item === undefined || outputIndex === undefined) break
        const itemType = str(item, 'type')
        if (itemType === 'function_call') {
          yield * start(outputIndex, 'tool-call', {
            callId: str(item, 'call_id'),
            name: str(item, 'name'),
            arguments: str(item, 'arguments') ?? '',
          })
        } else if (itemType === 'reasoning') {
          yield * start(outputIndex, 'reasoning')
        }
        // A `message` item opens no block yet: the block belongs to its first
        // content part, which is what actually carries text.
        break
      }
      case 'response.content_part.added': {
        const part = obj(event, 'part')
        if (part === undefined || outputIndex === undefined) break
        if (str(part, 'type') === 'output_text') yield * start(outputIndex, 'text')
        break
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        const delta = str(event, 'delta')
        if (delta === undefined || delta === '' || outputIndex === undefined) break
        yield * start(outputIndex, 'text')
        const block = open.get(outputIndex)
        if (block === undefined) break
        block.text += delta
        yield { type: 'text-delta', index: block.index, text: delta }
        break
      }
      case 'response.output_text.done':
      case 'response.refusal.done': {
        if (outputIndex === undefined) break
        // The `done` event carries the authoritative full text; the assembled
        // deltas are replaced rather than trusted to agree.
        const finalText = str(event, 'text') ?? str(event, 'refusal')
        const block = open.get(outputIndex)
        if (block !== undefined && finalText !== undefined) block.text = finalText
        yield * close(outputIndex)
        break
      }
      case 'response.content_part.done': {
        // Closing happens on the part's own `done`/text-done event; this is a
        // no-op guard so a part that omitted its `done` still closes here.
        if (outputIndex !== undefined) yield * close(outputIndex)
        break
      }
      case 'response.function_call_arguments.delta': {
        const delta = str(event, 'delta')
        if (delta === undefined || delta === '' || outputIndex === undefined) break
        const block = open.get(outputIndex)
        if (block === undefined) break
        block.arguments += delta
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: (block.callId ?? `call_${String(outputIndex)}`) as ToolCallBlock['id'],
          ...block.name === undefined ? {} : { name: block.name },
          argumentsDelta: delta,
        }
        break
      }
      case 'response.function_call_arguments.done': {
        if (outputIndex === undefined) break
        const block = open.get(outputIndex)
        const authoritative = str(event, 'arguments')
        if (block !== undefined && authoritative !== undefined) block.arguments = authoritative
        break
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const delta = str(event, 'delta')
        if (delta === undefined || delta === '' || outputIndex === undefined) break
        yield * start(outputIndex, 'reasoning')
        const block = open.get(outputIndex)
        if (block === undefined) break
        block.text += delta
        yield { type: 'reasoning-delta', index: block.index, text: delta }
        break
      }
      case 'response.reasoning_summary_part.done':
      case 'response.reasoning_text.done': {
        if (outputIndex === undefined) break
        // Reasoning deltas of one item are one block; the item's own `done`
        // closes it, so the summary/text `done` events only annotate.
        break
      }
      case 'response.output_item.done': {
        if (outputIndex === undefined) break
        yield * close(outputIndex)
        break
      }
      case 'response.completed': {
        sawTerminal = true
        const response = obj(event, 'response')
        const usage = response === undefined ? undefined : toUsage(obj(response, 'usage'))
        if (usage !== undefined) yield { type: 'usage', usage }
        const items = response === undefined ? undefined : response['output']
        yield {
          type: 'finish',
          reason: sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' },
          replayState: {
            // Native echo for the next request: this route is stateless, and
            // reasoning items must travel back with their tool outputs.
            response: { items: Array.isArray(items) ? items : [] },
            blocks: blockEntries,
          },
        }
        return
      }
      case 'response.incomplete': {
        sawTerminal = true
        const response = obj(event, 'response')
        const details = response === undefined ? undefined : obj(response, 'incomplete_details') as
          IncompleteDetails | undefined
        const usage = response === undefined ? undefined : toUsage(obj(response, 'usage'))
        if (usage !== undefined) yield { type: 'usage', usage }
        const reason = details?.reason
        if (reason === 'max_output_tokens') {
          yield { type: 'finish', reason: { kind: 'max-tokens' } }
        } else {
          const failure = {
            message: `ChatGPT response was incomplete (${reason ?? 'unspecified reason'})`,
            code: reason === 'content_filter' ? 'CONTENT_FILTER' : 'INCOMPLETE_RESPONSE',
          }
          yield { type: 'finish', reason: { kind: 'error', failure } }
        }
        return
      }
      case 'response.failed': {
        sawTerminal = true
        const response = obj(event, 'response')
        const error = response === undefined ? undefined : obj(response, 'error')
        const code = error === undefined ? undefined : str(error, 'code')
        const message = error === undefined ? undefined : str(error, 'message')
        const failure = {
          message: `ChatGPT response failed (${code ?? 'unknown_error'}): ${message ?? 'no detail'}`,
          code: code ?? 'RESPONSE_FAILED',
        }
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }
      case 'error': {
        sawTerminal = true
        const code = str(event, 'code') ?? 'STREAM_ERROR'
        const message = str(event, 'message') ?? 'the provider reported a stream error'
        yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
        return
      }
      default:
        // Unknown event types are ignored on purpose: the event vocabulary is
        // open, and a new informational event must not break an existing run.
        break
    }
  }

  if (!sawTerminal) {
    // The docs are explicit that only `response.completed` confirms inference,
    // so a stream that stopped early is a failure however much text it carried.
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'the ChatGPT response stream ended without a terminal event '
            + '(response.completed, response.failed, or response.incomplete)',
          code: 'STREAM_INCOMPLETE',
        },
      },
    }
  }
}

/** Whether a provider code names a ChatGPT-plan condition worth its own message. */
export function planCodeOf(text: string): string | undefined {
  const code = providerCodeOf(text)
  return code !== undefined && (Object.values(PLAN_CODES) as string[]).includes(code) ? code : undefined
}
