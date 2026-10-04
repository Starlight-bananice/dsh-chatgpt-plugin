#!/usr/bin/env node
/**
 * Adapter integration test against a local stand-in for the OpenAI API.
 *
 * `verify.mjs` exercises serialization and translation as pure functions. This
 * one drives the *adapter* — credential resolution, the HTTP request, headers,
 * streaming, and image inlining — so the pieces are proven to be wired to each
 * other, not merely correct in isolation. Only the API base is swapped, through
 * the same `apiBase` seam the OAuth endpoints use.
 *
 * Usage: node tests/adapter.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'

/** What the fake API saw, so the test can assert on the real wire request. */
const seen = { requests: [], responses: [] }

/** SSE frame helper. */
const frame = event => `data: ${JSON.stringify(event)}\n\n`

/** The SSE body the fake `/responses` returns, unless a test overrides it. */
let responsesScript = () => [
  frame({ type: 'response.created', response: { id: 'resp_test' } }),
  frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } }),
  frame({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }),
  frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hi ' }),
  frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'there' }),
  frame({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Hi there' }),
  frame({ type: 'response.completed', response: {
    id: 'resp_test',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi there' }] }],
    usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 2 },
      output_tokens: 5, output_tokens_details: { reasoning_tokens: 1 } },
  } }),
].join('')

/** Status and body the fake `/responses` returns for a rejected request. */
let rejectWith = undefined

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const record = {
      method: req.method, path: url.pathname, headers: req.headers,
      body: raw === '' ? undefined : JSON.parse(raw),
    }
    seen.requests.push(record)

    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list', context_window: 400000 },
          { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list' },
          { slug: 'internal-experiment', display_name: 'Hidden', visibility: 'hidden' },
          { display_name: 'No slug at all', visibility: 'list' },
        ],
      }))
      return
    }

    if (url.pathname === '/v1/responses') {
      if (rejectWith !== undefined) {
        const { status, body } = rejectWith
        res.writeHead(status, { 'content-type': 'application/json', 'openai-request-id': 'req_test_123' })
        res.end(JSON.stringify(body))
        return
      }
      const script = responsesScript(record)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      // Sent in two writes so the reader has to handle a frame split across
      // chunks, which is what a real stream does.
      const half = Math.floor(script.length / 2)
      res.write(script.slice(0, half))
      setImmediate(() => { res.end(script.slice(half)) })
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}/v1`

const { ChatGptAdapter } = await import('../lib/adapter.js')

const ACCESS_TOKEN = 'access-token-for-tests'
const ACCOUNT_ID = 'acct-test0000000000'

/** An in-memory credential store holding one live account grant. */
function store(grantOverrides = {}) {
  const records = new Map()
  records.set(`chatgpt/${ACCOUNT_ID}`, {
    kind: 'grant',
    payload: {
      type: 'chatgpt-plan',
      subject: 'sub-1',
      email: 'tester@example.com',
      issuer: BASE,
      clientId: 'oaiapp_test',
      hostId: 'urn:uuid:host',
      accessToken: ACCESS_TOKEN,
      refreshToken: 'refresh-value',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['chatgpt.tokens.use.direct'],
      savedAt: new Date().toISOString(),
      ...grantOverrides,
    },
  })
  return {
    readRecord: async key => records.get(key),
    listRecords: async () => [...records.entries()].map(([key, value]) => ({ key, kind: value.kind })),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return next
    },
    deleteRecord: async key => { records.delete(key) },
  }
}

/** Build an adapter over one store. */
function adapter(credentials, overrides = {}) {
  return new ChatGptAdapter({
    config: () => ({ displayName: 'ChatGPT', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: [], ...overrides.config }),
    credentials: () => credentials,
    accountId: async () => (overrides.signedOut === true ? undefined : ACCOUNT_ID),
    readImage: async (ref) => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }),
    onNotice: () => {},
    apiBase: () => BASE,
  })
}

/** Collect a chunk stream. */
async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

const userText = (text, extra = []) => ({
  role: 'user', content: [{ type: 'text', text }, ...extra], source: { kind: 'user' },
})

let passed = 0
const failures = []
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

process.stdout.write('model catalog\n')

await check('listModels maps the account catalog, filters visibility, and drops slugless entries', async () => {
  seen.requests.length = 0
  const models = await adapter(store()).listModels('chatgpt')
  assert.deepEqual(models.map(model => model.id), ['gpt-6.1-sol', 'gpt-6-astra'])
  assert.equal(models[0].name, 'GPT-6.1 Sol')
  assert.equal(models[0].provider, 'chatgpt')
  const request = seen.requests.at(-1)
  assert.equal(request.path, '/v1/models')
  assert.equal(request.headers.authorization, `Bearer ${ACCESS_TOKEN}`)
})

await check('resolveModel reports the context window only after the listing discloses it', async () => {
  const subject = adapter(store())
  const before = await subject.resolveModel('chatgpt', 'gpt-6.1-sol')
  assert.equal(before.context, undefined, 'nothing is known before the catalog is read')
  await subject.listModels('chatgpt')
  const after = await subject.resolveModel('chatgpt', 'gpt-6.1-sol')
  assert.deepEqual(after.context, { contextWindow: 400000 })
  const unknown = await subject.resolveModel('chatgpt', 'not-in-catalog')
  assert.equal(unknown.context, undefined, 'an unlisted model must not inherit a guess')
})

await check('a signed-out adapter lists nothing rather than failing the picker', async () => {
  seen.requests.length = 0
  const models = await adapter(store(), { signedOut: true }).listModels('chatgpt')
  assert.deepEqual(models, [])
  assert.equal(seen.requests.length, 0, 'no request may be made without an account')
})

await check('a stale account selection falls back to a saved account instead of serving nothing', async () => {
  const credentials = store()
  const { resolveAccountId } = await import('../lib/adapter.js')
  // The configured account was signed out; another one is still saved.
  assert.equal(await resolveAccountId(credentials, 'acct-signed-out'), ACCOUNT_ID,
    'a missing selection must fall back, not resolve to nothing')
  assert.equal(await resolveAccountId(credentials, ACCOUNT_ID), ACCOUNT_ID)
  assert.equal(await resolveAccountId(credentials, undefined), ACCOUNT_ID)
  assert.equal(await resolveAccountId(undefined, ACCOUNT_ID), undefined)
})

await check('configured extras are appended after the listed models and never duplicate one', async () => {
  // The account's listing is narrower than what the models actually serve: a
  // companion client's bundled catalog names ids this endpoint never returns,
  // and the provider answers them. An extra is opt-in so nothing appears that
  // the operator did not ask for, and it never displaces a listed model.
  const subject = adapter(store(), {
    config: { models: [
      { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
      { id: 'gpt-6-sol' },
      { id: 'gpt-6-luna', name: 'a duplicate the listing must not gain' },
      { id: 'gpt-6-astra', name: 'already listed, so not an extra' },
    ] },
  })
  const models = await subject.listModels('chatgpt')
  assert.deepEqual(models.map(model => model.id),
    ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol'],
    'the listing keeps its own order and extras follow, deduplicated')
  assert.equal(models.find(model => model.id === 'gpt-6-luna').name, 'GPT-6 Luna',
    'the first entry for an id wins')
  assert.equal(models.find(model => model.id === 'gpt-6-sol').name, 'gpt-6-sol',
    'an extra without a name falls back to its id')
  assert.equal(await subject.resolveModel('chatgpt', 'gpt-6-luna').then(info => info.name), 'GPT-6 Luna',
    'a configured extra must resolve, so a picker can label it')
})

process.stdout.write('inference request\n')

await check('a stream sends the documented headers and a SIWC-safe payload', async () => {
  seen.requests.length = 0
  const chunks = await collect(adapter(store()).stream({
    provider: 'chatgpt',
    model: 'gpt-6.1-sol',
    system: 'be terse',
    reasoningEffort: 'high',
    messages: [userText('hello')],
    tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {} } }],
  }))

  const request = seen.requests.at(-1)
  assert.equal(request.path, '/v1/responses')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.authorization, `Bearer ${ACCESS_TOKEN}`)
  assert.equal(request.headers['content-type'], 'application/json')
  assert.match(request.headers.accept, /event-stream/)
  assert.match(request.headers['user-agent'], /^dsh-chatgpt-provider\//, 'app attribution is mandatory')

  const body = request.body
  assert.equal(body.model, 'gpt-6.1-sol')
  assert.equal(body.store, false, 'store:false is mandatory on this route')
  assert.equal(body.stream, true, 'stream:true is mandatory on this route')
  assert.equal(body.instructions, 'be terse')
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' })
  // Every documented unsupported field must be absent, not merely unused.
  for (const forbidden of ['temperature', 'max_output_tokens', 'previous_response_id', 'metadata',
    'top_p', 'truncation', 'user', 'prompt_cache_retention', 'background', 'conversation']) {
    assert.equal(forbidden in body, false, `${forbidden} must not be sent`)
  }
  assert.equal(body.input.some(item => item.role === 'system'), false)
  assert.deepEqual(body.tools, [{
    type: 'function', name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {} },
  }])

  assert.deepEqual(chunks.map(chunk => chunk.type),
    ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  assert.deepEqual(chunks.at(-2).usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 1 })
})

await check('a request image is inlined as a data URL in the wire payload', async () => {
  seen.requests.length = 0
  const ref = { attachmentId: 'a1', mediaType: 'image/png', bytes: 4, width: 2, height: 2 }
  await collect(adapter(store()).stream({
    provider: 'chatgpt',
    model: 'gpt-6.1-sol',
    messages: [userText('what is this', [{ type: 'image', attachment: ref }])],
  }))
  const body = seen.requests.at(-1).body
  const parts = body.input[0].content
  assert.deepEqual(parts[0], { type: 'input_text', text: 'what is this' })
  assert.equal(parts[1].type, 'input_image')
  assert.equal(parts[1].image_url, 'data:image/png;base64,AQIDBA==')
})

await check('the tool-call round trip keeps arguments raw and finishes as tool-calls', async () => {
  responsesScript = () => [
    frame({ type: 'response.output_item.added', output_index: 0, item: {
      type: 'function_call', call_id: 'call_7', name: 'bash', arguments: '',
    } }),
    frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"cmd":' }),
    frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '"ls"}' }),
    frame({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } }),
    frame({ type: 'response.completed', response: { id: 'r', output: [{ type: 'function_call', call_id: 'call_7' }] } }),
  ].join('')
  try {
    const chunks = await collect(adapter(store()).stream({
      provider: 'chatgpt', model: 'gpt-6.1-sol', messages: [userText('list files')],
    }))
    const end = chunks.find(chunk => chunk.type === 'block-end')
    assert.deepEqual(end.block, { type: 'tool-call', id: 'call_7', name: 'bash', arguments: '{"cmd":"ls"}' })
    assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
    assert.equal(Array.isArray(chunks.at(-1).replayState.response.items), true)
  } finally {
    responsesScript = () => [
      frame({ type: 'response.completed', response: { id: 'r', output: [] } }),
    ].join('')
  }
})

process.stdout.write('failures\n')

await check('a usage-limit rejection keeps the provider code and status', async () => {
  rejectWith = {
    status: 429,
    body: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit reached', param: null } },
  }
  try {
    const credentials = store()
    await assert.rejects(
      () => collect(adapter(credentials).stream({ provider: 'chatgpt', model: 'gpt-6.1-sol', messages: [userText('hi')] })),
      (error) => {
        assert.equal(error.code, 'subscription_sharing_usage_limit_exceeded')
        assert.equal(error.failure.code, 'subscription_sharing_usage_limit_exceeded',
          'the harness reads `failure`, so it must agree with `code`')
        assert.equal(error.failure.status, 429)
        assert.equal(error.failure.requestId, 'req_test_123', 'the request id must survive for diagnostics')
        return true
      },
    )
  } finally {
    rejectWith = undefined
  }
})

await check('a mid-stream provider failure ends the stream with an error finish, not a throw', async () => {
  responsesScript = () => [
    frame({ type: 'response.output_text.delta', output_index: 0, delta: 'partial' }),
    frame({ type: 'response.failed', response: {
      status: 'failed',
      error: { code: 'subscription_sharing_usage_unavailable', message: 'could not check usage' },
    } }),
  ].join('')
  try {
    const chunks = await collect(adapter(store()).stream({
      provider: 'chatgpt', model: 'gpt-6.1-sol', messages: [userText('hi')],
    }))
    const finish = chunks.at(-1)
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'subscription_sharing_usage_unavailable')
  } finally {
    responsesScript = () => [frame({ type: 'response.completed', response: { id: 'r', output: [] } })].join('')
  }
})

await check('a signed-out request fails with MISSING_CREDENTIAL before any network call', async () => {
  seen.requests.length = 0
  await assert.rejects(
    () => collect(adapter(store(), { signedOut: true }).stream({ provider: 'chatgpt', model: 'm', messages: [] })),
    error => error.code === 'MISSING_CREDENTIAL',
  )
  assert.equal(seen.requests.length, 0, 'no request may be attempted without an account')
})

await check('an already-aborted signal prevents the request from being sent', async () => {
  seen.requests.length = 0
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => collect(adapter(store()).stream({
      provider: 'chatgpt', model: 'gpt-6.1-sol', messages: [userText('hi')], signal: controller.signal,
    })),
  )
})

server.close()

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exit(1)
