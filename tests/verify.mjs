#!/usr/bin/env node
/**
 * Behavioral checks for the parts of this plugin that can be verified without a
 * live ChatGPT account: the SIWC request contract, the stream translator, the
 * authorization URL, and the failure taxonomy.
 *
 * These run against the compiled `lib/` output, so they also prove the built
 * artifact is importable and wired the way the sources intend.
 *
 * Usage: node tests/verify.mjs
 */

import assert from 'node:assert/strict'
import { buildAuthorizeUrl, createPkce, DYNAMIC_CLIENT_ID, RESOURCE, SCOPE } from '../lib/oauth.js'
import { serializeRequest, replayItemsFor } from '../lib/serialize.js'
import { translateStream } from '../lib/stream.js'
import { codeForStatus, PLAN_CODES } from '../lib/errors.js'
import { accountIdFor, recordKey } from '../lib/accounts.js'
import { assertServiceable } from '../lib/config.js'

let passed = 0
const failures = []

/** Run one named check, recording rather than throwing so all of them report. */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ok  ${name}\n`)
  } catch (error) {
    failures.push({ name, error })
    process.stdout.write(`FAIL  ${name}\n      ${error?.message ?? error}\n`)
  }
}

/** A user text message in the shape serialization reads. */
const userText = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

/** An assistant message in the shape serialization reads. */
const assistant = (blocks, replayState) => ({
  role: 'assistant',
  content: blocks,
  source: { kind: 'model', provider: 'chatgpt', model: 'gpt-x', ...(replayState === undefined ? {} : { replayState }) },
})

/** Minimal GenerateOptions for serialization checks. */
const options = (over) => ({
  provider: 'chatgpt',
  model: 'gpt-x',
  messages: [userText('hello')],
  ...over,
})

/** Frame one SSE payload the way the provider does. */
const frame = (event) => `data: ${JSON.stringify(event)}\n\n`

/** Collect a stream of chunks into an array. */
async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** Build a Response-like body stream from fixed SSE text. */
function bodyOf(text) {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

process.stdout.write('authorization URL\n')

await check('new registration sends the entrypoint client id and the app name hint', () => {
  const url = new URL(buildAuthorizeUrl({
    clientId: DYNAMIC_CLIENT_ID,
    agentNameHint: 'DeepSeek Harness',
    hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111',
    redirectUri: 'http://127.0.0.1:1455/auth/callback',
    state: 'st',
    nonce: 'no',
    codeChallenge: 'cc',
  }))
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/api/accounts/authorize')
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(url.searchParams.get('agent_name_hint'), 'DeepSeek Harness')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('scope'), SCOPE)
  assert.equal(url.searchParams.get('resource'), RESOURCE)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('ext_agent_host_id'), 'urn:uuid:11111111-1111-4111-8111-111111111111')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback')
})

await check('reauthorization omits the app name hint and carries the saved hints', () => {
  const url = new URL(buildAuthorizeUrl({
    clientId: 'oaiapp_issued',
    hostId: 'urn:uuid:2',
    idTokenHint: 'idt',
    loginHint: 'user@example.com',
    redirectUri: 'http://127.0.0.1:1455/auth/callback',
    state: 's',
    nonce: 'n',
    codeChallenge: 'c',
  }))
  assert.equal(url.searchParams.get('client_id'), 'oaiapp_issued')
  assert.equal(url.searchParams.has('agent_name_hint'), false, 'hint must be omitted on reauthorization')
  assert.equal(url.searchParams.get('id_token_hint'), 'idt')
  assert.equal(url.searchParams.get('login_hint'), 'user@example.com')
})

await check('PKCE challenge is the base64url SHA-256 of the verifier, unpadded', async () => {
  const { verifier, challenge } = createPkce()
  assert.match(challenge, /^[A-Za-z0-9_-]+$/, 'must be base64url with no padding')
  const { createHash } = await import('node:crypto')
  const expected = createHash('sha256').update(verifier).digest('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  assert.equal(challenge, expected)
})

process.stdout.write('request contract\n')

await check('store:false and stream:true are always set', async () => {
  const body = await serializeRequest(options())
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
})

await check('the system slot becomes instructions, never a system input item', async () => {
  const body = await serializeRequest(options({ system: 'be terse', messages: [userText('hi')] }))
  assert.equal(body.instructions, 'be terse')
  assert.equal(body.input.some(item => item.role === 'system'), false)
})

await check('a system-role history message is folded into instructions', async () => {
  const body = await serializeRequest(options({
    system: 'first',
    messages: [{ role: 'system', content: [{ type: 'text', text: 'second' }] }, userText('hi')],
  }))
  assert.equal(body.instructions, 'first\n\nsecond')
  assert.equal(body.input.some(item => item.role === 'system'), false)
})

await check('tools are flat, with no nested function wrapper', async () => {
  const body = await serializeRequest(options({
    tools: [{ name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } }],
  }))
  assert.deepEqual(body.tools, [{
    type: 'function', name: 'bash', description: 'run', parameters: { type: 'object', properties: {} },
  }])
  assert.equal('function' in body.tools[0], false)
})

await check('unsupported fields are refused rather than dropped', async () => {
  await assert.rejects(() => serializeRequest(options({ temperature: 0.5 })), /temperature/)
  await assert.rejects(() => serializeRequest(options({ maxTokens: 100 })), /maxTokens/)
  await assert.rejects(() => serializeRequest(options({ stop: ['x'] })), /stop/)
})

await check('a reasoning level is spelled with a summary, and unknown levels are refused', async () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual((await serializeRequest(options({ reasoningEffort: effort }))).reasoning,
      { effort, summary: 'auto' }, `${effort} must reach the wire`)
  }
  // `off` and `none` are not levels this route accepts for its reasoning models.
  await assert.rejects(() => serializeRequest(options({ reasoningEffort: 'off' })), /not one this route accepts/)
  await assert.rejects(() => serializeRequest(options({ reasoningEffort: 'none' })), /not one this route accepts/)
})

await check('an assistant message carries output_text parts, never input_text', async () => {
  // This route rejects an assistant-role `input_text` part with `invalid_value`
  // and a pointer at the offending index. A single-turn probe cannot reveal it,
  // because the failure needs an assistant turn in the history to replay — which
  // is exactly how it reached a live session once.
  const body = await serializeRequest(options({
    messages: [userText('first'), assistant([{ type: 'text', text: 'a reply' }]), userText('second')],
  }))
  const replayed = body.input.find(item => item.role === 'assistant')
  assert.ok(replayed !== undefined, 'the assistant turn must be replayed')
  assert.deepEqual(replayed.content, [{ type: 'output_text', text: 'a reply' }])
  const assistantParts = body.input
    .filter(item => item.role === 'assistant')
    .flatMap(item => item.content)
  assert.equal(assistantParts.some(part => part.type === 'input_text'), false)
  // User messages keep input_text: the two roles take different discriminants.
  const userParts = body.input.filter(item => item.role === 'user').flatMap(item => item.content)
  assert.equal(userParts.every(part => part.type === 'input_text'), true)
})

await check('tool results become function_call_output items and tool calls replay as function_call', async () => {
  const body = await serializeRequest(options({
    messages: [
      userText('go'),
      assistant([{ type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"c":"ls"}' }]),
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: 'call_1' },
      },
    ],
  }))
  assert.deepEqual(body.input[1], { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"c":"ls"}' })
  assert.deepEqual(body.input[2], { type: 'function_call_output', call_id: 'call_1', output: 'ok' })
})

await check('native replay items are echoed verbatim and only for this provider', async () => {
  const native = [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
    { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{}' },
  ]
  const message = assistant(
    [{ type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{}' }],
    { response: { items: native }, blocks: [{ outputIndex: 0, kind: 'tool-call' }] },
  )
  assert.deepEqual(replayItemsFor(message, 1), native)
  // A block-count disagreement discards the envelope; the seam drops entries
  // positionally, so a mismatch means the metadata no longer describes content.
  assert.equal(replayItemsFor(message, 2), undefined)
  const foreign = { ...message, source: { ...message.source, provider: 'other' } }
  assert.equal(replayItemsFor(foreign, 1), undefined)
  const body = await serializeRequest(options({ messages: [userText('q'), message] }))
  assert.deepEqual(body.input.slice(1), native, 'the native items must be replayed verbatim')
})

await check('images are inlined as data URLs and over-budget ones become a stated placeholder', async () => {
  const ref = { attachmentId: 'a1', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: ref }],
    source: { kind: 'user' },
  }]
  const notices = []
  const ok = await serializeRequest(options({ messages }), {
    readImage: async () => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }),
    onNotice: message => notices.push(message),
  })
  assert.equal(ok.input[0].content[1].type, 'input_image')
  assert.equal(ok.input[0].content[1].image_url, 'data:image/png;base64,AQIDBA==')
  assert.equal(notices.length, 0)

  const skipped = await serializeRequest(options({ messages }), {
    readImage: async () => ({ ref, data: new Uint8Array(4) }),
    maxImageBytes: 1,
    onNotice: message => notices.push(message),
  })
  assert.equal(skipped.input[0].content[1].type, 'input_text')
  assert.match(skipped.input[0].content[1].text, /omitted/)
  assert.equal(notices.length, 1, 'a dropped image must be reported, not silent')
})

await check('an image a TOOL returned reaches the model instead of being dropped', async () => {
  // `function_call_output` takes text, so a tool image cannot ride the output
  // item. It used to be replaced by a placeholder and lost entirely — the tool
  // had read the pixels and the model never saw them, which silently broke
  // screenshot checks, visual page validation, and layout review.
  const ref = { attachmentId: 'shot', mediaType: 'image/png', bytes: 4, width: 2, height: 2 }
  const messages = [
    userText('take a screenshot'),
    assistant([{ type: 'tool-call', id: 'call_1', name: 'screenshot', arguments: '{}' }]),
    {
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'call_1',
        content: [{ type: 'text', text: 'captured 2x2' }, { type: 'image', attachment: ref }],
      }],
      source: { kind: 'tool' },
    },
  ]
  const notices = []
  const body = await serializeRequest(options({ messages }), {
    readImage: async () => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }),
    onNotice: message => notices.push(message),
  })

  const output = body.input.find(item => item.type === 'function_call_output')
  assert.ok(output, 'the tool result must still produce a function_call_output item')
  assert.equal(output.output, 'captured 2x2\n[image result follows in the next user message, as an image input]')

  const outputIndex = body.input.indexOf(output)
  const carrier = body.input[outputIndex + 1]
  assert.equal(carrier.role, 'user', 'the image must follow its output immediately')
  assert.equal(carrier.content[0].type, 'input_image')
  assert.equal(carrier.content[0].image_url, 'data:image/png;base64,AQIDBA==')
  assert.equal(notices.length, 0)

  // Same ceilings as a user-supplied image: an over-budget tool image is a
  // stated placeholder, never a silent drop.
  const limited = await serializeRequest(options({ messages }), {
    readImage: async () => ({ ref, data: new Uint8Array(4) }),
    maxImageBytes: 1,
    onNotice: message => notices.push(message),
  })
  const limitedIndex = limited.input.findIndex(item => item.type === 'function_call_output')
  const carried = limited.input[limitedIndex + 1]
  assert.equal(carried.role, 'user')
  assert.equal(carried.content[0].type, 'input_text')
  assert.match(carried.content[0].text, /tool image omitted/)
  assert.equal(notices.length, 1, 'a dropped tool image must be reported')

  // No attachment seam at all: still a stated placeholder, and the text of the
  // tool result is never lost.
  const seam = await serializeRequest(options({ messages }), {})
  const seamIndex = seam.input.findIndex(item => item.type === 'function_call_output')
  assert.match(seam.input[seamIndex].output, /captured 2x2/)
  assert.match(seam.input[seamIndex + 1].content[0].text, /no attachment service/)
})

process.stdout.write('stream translation\n')

await check('a text turn yields block deltas, usage before finish, and nothing after', async () => {
  const chunks = await collect(translateStream(bodyOf(
    frame({ type: 'response.created', response: { id: 'resp_1' } })
    + frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } })
    + frame({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } })
    + frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hel' })
    + frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'lo' })
    + frame({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Hello' })
    + frame({ type: 'response.completed', response: {
      id: 'resp_1', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] }],
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 2 } },
    } }),
  )))
  const kinds = chunks.map(chunk => chunk.type)
  assert.deepEqual(kinds, ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
  const finishIndex = kinds.indexOf('finish')
  assert.equal(kinds.slice(finishIndex + 1).length, 0, 'nothing may follow finish')
  assert.deepEqual(chunks[3].block, { type: 'text', text: 'Hello' })
  // Disjoint counts: cached input is reported separately, not folded into inputTokens.
  assert.deepEqual(chunks[4].usage, {
    inputTokens: 6, outputTokens: 7, cacheReadTokens: 4, reasoningTokens: 2,
  })
  assert.deepEqual(chunks[5].reason, { kind: 'stop' })
  assert.equal(Array.isArray(chunks[5].replayState.response.items), true)
})

await check('a tool call keeps raw JSON arguments and finishes as tool-calls', async () => {
  const chunks = await collect(translateStream(bodyOf(
    frame({ type: 'response.output_item.added', output_index: 0, item: {
      type: 'function_call', call_id: 'call_9', name: 'bash', arguments: '',
    } })
    + frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a":' })
    + frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '1}' })
    + frame({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"a":1}' })
    + frame({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } })
    + frame({ type: 'response.completed', response: { id: 'r', output: [] } }),
  )))
  const delta = chunks.find(chunk => chunk.type === 'tool-call-delta')
  assert.equal(delta.id, 'call_9')
  assert.equal(delta.name, 'bash')
  const end = chunks.find(chunk => chunk.type === 'block-end')
  assert.deepEqual(end.block, { type: 'tool-call', id: 'call_9', name: 'bash', arguments: '{"a":1}' })
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

await check('interleaved text and tool calls get distinct block indexes', async () => {
  const chunks = await collect(translateStream(bodyOf(
    frame({ type: 'response.content_part.added', output_index: 0, part: { type: 'output_text' } })
    + frame({ type: 'response.output_text.delta', output_index: 0, delta: 'a' })
    + frame({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'c', name: 'n' } })
    + frame({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' })
    + frame({ type: 'response.output_text.done', output_index: 0, text: 'a' })
    + frame({ type: 'response.output_item.done', output_index: 1 })
    + frame({ type: 'response.completed', response: { output: [] } }),
  )))
  const indexes = chunks.filter(chunk => chunk.type === 'block-start').map(chunk => chunk.index)
  assert.deepEqual(indexes, [0, 1], 'indexes are allocated in first-seen order')
  const textEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')
  assert.equal(textEnd.index, 0)
})

await check('a usage-limit failure arriving mid-stream becomes an error finish with its exact code', async () => {
  const chunks = await collect(translateStream(bodyOf(
    frame({ type: 'response.output_text.delta', output_index: 0, delta: 'partial' })
    + frame({ type: 'response.failed', response: {
      status: 'failed', error: { code: PLAN_CODES.usageLimitExceeded, message: 'limit reached' },
    } }),
  )))
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'subscription_sharing_usage_limit_exceeded')
})

await check('an incomplete response maps max_output_tokens to max-tokens', async () => {
  const chunks = await collect(translateStream(bodyOf(
    frame({ type: 'response.incomplete', response: {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [],
    } }),
  )))
  assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' })
})

await check('a stream that ends without a terminal event is a failure, not a success', async () => {
  const chunks = await collect(translateStream(bodyOf(
    frame({ type: 'response.output_text.delta', output_index: 0, delta: 'truncated' }),
  )))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'STREAM_INCOMPLETE')
})

await check('a non-JSON payload does not break the stream', async () => {
  const chunks = await collect(translateStream(bodyOf(
    'data: not json\n\n'
    + frame({ type: 'response.completed', response: { output: [] } }),
  )))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

process.stdout.write('failure taxonomy and account addressing\n')

await check('plan codes are preserved verbatim and terminal ones are recognizable', () => {
  assert.equal(codeForStatus(429, `{"error":{"code":"${PLAN_CODES.usageLimitExceeded}"}}`), PLAN_CODES.usageLimitExceeded)
  assert.equal(codeForStatus(403, `{"error":{"code":"${PLAN_CODES.userNotEligible}"}}`), PLAN_CODES.userNotEligible)
  assert.equal(codeForStatus(503, 'upstream unavailable'), 'PROVIDER_UNAVAILABLE')
  assert.equal(codeForStatus(401, 'nope'), 'AUTH')
  assert.equal(codeForStatus(429, 'slow down'), 'RATE_LIMIT')
})

await check('account ids are stable, distinct per registration, and grammar-legal', () => {
  const a = accountIdFor('sub-1', 'oaiapp_a')
  assert.equal(a, accountIdFor('sub-1', 'oaiapp_a'), 'must be deterministic')
  assert.notEqual(a, accountIdFor('sub-1', 'oaiapp_b'), 'a second registration is a second account')
  assert.notEqual(a, accountIdFor('sub-2', 'oaiapp_a'), 'a second subject is a second account')
  assert.match(a, /^[a-z][a-z0-9-]*$/, 'must satisfy the credential-key segment grammar')
  assert.equal(recordKey(a), `chatgpt/${a}`)
})

await check('cross-field configuration rules are enforced', () => {
  assert.throws(() => assertServiceable({ reasoningEfforts: [], }), /at least one/)
  assert.throws(() => assertServiceable({ reasoningEfforts: ['high'], reasoningEffort: 'low' }), /one of reasoningEfforts/)
  assert.throws(() => assertServiceable({ maxImageBytes: 10, maxInlineImageBytes: 1 }), /must not exceed/)
  assert.throws(() => assertServiceable({ models: [{ id: 'x' }, { id: 'x' }] }), /duplicate/)
  assert.doesNotThrow(() => assertServiceable({}))
})

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exit(1)
