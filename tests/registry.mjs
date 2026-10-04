#!/usr/bin/env node
/**
 * Registry integration test: this plugin's adapter driven by the **real**
 * `LlmRuntime`, not the stub the other suites use.
 *
 * Every other test calls the adapter directly, which proves the adapter works
 * but not that the harness accepts it. The registry validates what an adapter
 * returns — provider identity, model metadata, reasoning identifiers, and the
 * failure it normalizes out of a thrown error — and it is where a duck-typed,
 * out-of-tree adapter could plausibly be rejected. This test loads the harness's
 * own compiled `LlmRuntime` plus cordis, registers the plugin's adapter for real,
 * and asserts that routing, model discovery, metadata resolution, call-config
 * validation, and terminal-failure normalization all behave.
 *
 * It is the closest thing to "will ChatGPT models actually appear in the picker
 * and serve a request" that can be checked without a live ChatGPT account.
 *
 * Usage: node tests/registry.mjs   (set DSH_CHECKOUT to point at the harness)
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const require = createRequire(join(ROOT, 'package.json'))

/** Locate the harness checkout whose compiled packages this test loads. */
function findCheckout() {
  const candidates = [
    process.env['DSH_CHECKOUT'],
    join(homedir(), 'deepseek-harness'),
    join(homedir(), 'Documents', 'deepseek-harness'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'packages', 'llm', 'llm', 'lib', 'index.js'))) return candidate
  }
  return undefined
}

const checkout = findCheckout()
if (checkout === undefined) {
  process.stdout.write('registry: no harness checkout found (set DSH_CHECKOUT); skipping\n')
  process.exit(0)
}

const load = async relative => import(pathToFileURL(join(checkout, relative)).href)
const { Context } = await load('vendor/cordis/lib/index.js')
const llm = await load('packages/llm/llm/lib/index.js')
const LlmRuntime = llm.default
const { createUserMessage } = llm
const { ChatGptAdapter } = await import('../lib/adapter.js')

// ── A fake API so model discovery and streaming have something to talk to ────
let responsesScript = () => `data: ${JSON.stringify({
  type: 'response.completed',
  response: { id: 'r', output: [], usage: { input_tokens: 3, output_tokens: 1 } },
})}\n\n`

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [
        { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list', context_window: 400000 },
        { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list' },
      ] }))
      return
    }
    if (url.pathname === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesScript())
      return
    }
    res.writeHead(404).end()
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const API_BASE = `http://127.0.0.1:${server.address().port}/v1`

const ACCESS_TOKEN = 'registry-test-token'
const ACCOUNT_ID = 'acct-registrytest00'

/** An in-memory credential store holding one live account grant. */
function store() {
  const records = new Map()
  records.set(`chatgpt/${ACCOUNT_ID}`, { kind: 'grant', payload: {
    type: 'chatgpt-plan', subject: 'sub', email: 'tester@example.com', issuer: 'https://auth.openai.com',
    clientId: 'oaiapp_test', hostId: 'urn:uuid:host', accessToken: ACCESS_TOKEN, refreshToken: 'refresh',
    tokenType: 'Bearer', expiresAt: Date.now() + 3_600_000,
    scopes: ['chatgpt.tokens.use.direct'], savedAt: new Date().toISOString(),
  } })
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

/** Build a runtime with this plugin's adapter registered for real. */
async function runtime({ signedIn = true } = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new ChatGptAdapter({
    config: () => ({ displayName: 'ChatGPT', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: [] }),
    credentials: () => store(),
    accountId: async () => (signedIn ? ACCOUNT_ID : undefined),
    readImage: async ref => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }),
    onNotice: () => {},
    apiBase: () => API_BASE,
  })
  ctx.llm.registerAdapter(['chatgpt'], adapter)
  return ctx
}

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

process.stdout.write('registration\n')

await check('the runtime accepts the duck-typed adapter and reports the route', async () => {
  const ctx = await runtime()
  const providers = ctx.llm.listProviders()
  assert.deepEqual(providers, [{ id: 'chatgpt', name: 'ChatGPT' }])
})

await check('a duplicate route is refused, proving the adapter really owns it', async () => {
  const ctx = await runtime()
  assert.throws(() => ctx.llm.registerAdapter(['chatgpt'], { providerInfo: () => ({ id: 'chatgpt', name: 'x' }) }),
    error => error.code === 'DUPLICATE_ADAPTER')
})

process.stdout.write('model discovery\n')

await check('listModels surfaces the account catalog through the registry', async () => {
  const ctx = await runtime()
  const models = await ctx.llm.listModels('chatgpt')
  assert.deepEqual(models.map(model => model.id), ['gpt-6.1-sol', 'gpt-6-astra'])
  assert.equal(models[0].name, 'GPT-6.1 Sol')
  assert.equal(models[0].provider, 'chatgpt')
})

await check('resolveModelInfo accepts the metadata this adapter returns', async () => {
  const ctx = await runtime()
  await ctx.llm.listModels('chatgpt')
  const info = await ctx.llm.resolveModelInfo('chatgpt', 'gpt-6.1-sol')
  assert.equal(info.id, 'gpt-6.1-sol')
  assert.deepEqual(info.context, { contextWindow: 400000 })
  // The registry validates these identifiers; a malformed list would throw
  // INVALID_MODEL_REASONING rather than reaching a picker.
  assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh', 'max'])
})

await check('an advertised effort is accepted and an unadvertised one is refused', async () => {
  const ctx = await runtime()
  const accepted = await ctx.llm.resolveCallConfig({ provider: 'chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'high' })
  assert.equal(accepted.reasoningEffort, 'high')
  // `off` is deliberately not advertised: this route's models refuse the wire
  // value that would disable reasoning, so the registry must refuse it rather
  // than pass it down and let the provider reject the whole request.
  await assert.rejects(
    () => ctx.llm.resolveCallConfig({ provider: 'chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'off' }),
    error => error.code === 'UNSUPPORTED_REASONING_EFFORT',
  )
  // The top of the advertised range must be accepted.
  const top = await ctx.llm.resolveCallConfig({ provider: 'chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'max' })
  assert.equal(top.reasoningEffort, 'max')
})

process.stdout.write('dispatch and failure normalization\n')

await check('a routed request reaches the adapter and streams through the registry', async () => {
  const ctx = await runtime()
  responsesScript = () => [
    `data: ${JSON.stringify({ type: 'response.content_part.added', output_index: 0, part: { type: 'output_text' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'pong' })}\n\n`,
    `data: ${JSON.stringify({ type: 'response.output_text.done', output_index: 0, text: 'pong' })}\n\n`,
    `data: ${JSON.stringify({ type: 'response.completed', response: {
      id: 'r', output: [], usage: { input_tokens: 3, output_tokens: 1 },
    } })}\n\n`,
  ].join('')
  const chunks = []
  for await (const chunk of ctx.llm.stream({
    provider: 'chatgpt',
    model: 'gpt-6.1-sol',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } })],
  })) chunks.push(chunk)
  assert.deepEqual(chunks.map(chunk => chunk.type),
    ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

await check('a thrown adapter error keeps its code through the registry normalizer', async () => {
  // This is the load-bearing assertion for an out-of-tree adapter: the harness
  // prefers an error's own `failure` snapshot over its class, because
  // `instanceof` cannot hold across package copies. If the code did not survive,
  // retry policy and every diagnostic would see only UNKNOWN.
  const ctx = await runtime({ signedIn: false })
  const chunks = []
  for await (const chunk of ctx.llm.stream({
    provider: 'chatgpt',
    model: 'gpt-6.1-sol',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } })],
  })) chunks.push(chunk)
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'MISSING_CREDENTIAL',
    `expected MISSING_CREDENTIAL, got ${String(finish.reason.failure.code)}`)
})

await check('the retry policy the registry captured excludes the terminal plan codes', async () => {
  const ctx = await runtime()
  const policy = ctx.llm.providerRetryPolicy('chatgpt')
  assert.equal(policy.mode, 'normal')
  for (const code of ['subscription_sharing_user_not_eligible', 'subscription_sharing_usage_limit_exceeded',
    'subscription_sharing_unsupported_capability', 'subscription_sharing_route_not_supported',
    'subscription_sharing_invalid_user', 'MISSING_CREDENTIAL', 'UNSUPPORTED']) {
    assert.equal(policy.retryableCodes.includes(code), false, `${code} must not be retryable`)
  }
  assert.equal(policy.retryableCodes.includes('subscription_sharing_usage_unavailable'), true)
})

await check('a route the adapter does not own is refused by the registry', async () => {
  const ctx = await runtime()
  await assert.rejects(
    () => ctx.llm.listModels('not-registered'),
    error => error.code === 'NO_ADAPTER',
  )
})

server.close()

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exit(1)
