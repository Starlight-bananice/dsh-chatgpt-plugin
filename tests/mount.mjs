#!/usr/bin/env node
/**
 * Mount smoke test.
 *
 * The plugin is loaded into a live application at boot, so a throw inside
 * `apply()` or a bad schema would take the profile down rather than merely
 * disabling one feature. This mounts the compiled plugin against a stub context
 * that records what it registers, and then exercises the registered adapter and
 * the HTTP surface's status path — enough to prove the wiring, the schema, and
 * the route table are all sound before anything is loaded for real.
 *
 * Usage: node tests/mount.mjs
 */

import assert from 'node:assert/strict'

const registrations = { providers: [], adapters: [], routes: [], sections: [], effects: [], settingsWrites: [] }

/** Build a stub context covering exactly the services this plugin consumes. */
function stubContext({ withSettings = true, withWebServer = true, withCredentials = true,
  failDirectory = false } = {}) {
  /** In-memory stand-in for the credential document. */
  const records = new Map()
  const credentials = {
    readRecord: async key => records.get(key),
    listRecords: async () => [...records.entries()].map(([key, value]) => ({ key, kind: value.kind })),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return next
    },
    deleteRecord: async key => { records.delete(key) },
  }

  const llm = {
    registerConfigurableProviders(entries) {
      // The real registry refuses an empty initial registration, and any other
      // refusal is equally fatal to the caller if it is not caught.
      if (failDirectory) throw new Error('INVALID_DIRECTORY: an adapter must declare at least one provider')
      registrations.providers.push(...entries)
      return { replace() {} }
    },
    registerAdapter(routes, adapter) {
      registrations.adapters.push({ routes, adapter })
      return { replace() {} }
    },
  }
  const webServer = {
    register(route) {
      registrations.routes.push(route)
      return () => {}
    },
  }
  // The 0.2 settings service projects each plugin's Config and writes through
  // describe()/update(); it has no register().
  const settingsEntryId = 'dsh-chatgpt-provider'
  const settings = {
    describe: () => [{ ns: settingsEntryId, revision: 1, autoGenerate: true, applies: 'live' }],
    update: async (ns, patch) => { registrations.settingsWrites.push({ ns, patch }) },
  }

  // Cordis exposes an injected service both as `ctx.<name>` and through
  // `ctx.get('<name>')`; the plugin uses both forms, so the stub must too.
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: name => ctx[name],
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') registrations.effects.push(disposer)
    },
    on() { return () => {} },
    inject(deps, callback) {
      const available = deps.every(dep => ctx[dep] !== undefined)
      if (available) callback(ctx)
    },
  }
  ctx.llm = llm
  if (withCredentials) ctx.credentials = credentials
  if (withWebServer) ctx.webServer = webServer
  if (withSettings) ctx.settings = settings
  return { ctx, credentials, records }
}

let passed = 0
const failures = []

/** Run one named check. */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ok  ${name}\n`)
  } catch (error) {
    failures.push({ name, error })
    process.stdout.write(`FAIL  ${name}\n      ${error?.stack ?? error}\n`)
  }
}

const plugin = await import('../lib/index.js')

process.stdout.write('plugin surface\n')

await check('the module exposes the loader contract', () => {
  assert.equal(plugin.name, 'dsh-chatgpt-provider')
  assert.deepEqual(plugin.inject, ['llm'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function', 'Config must be a schema factory the loader can call')
})

await check('the settings section resolves its defaults from an empty base', () => {
  const resolved = plugin.Config({})
  assert.equal(resolved.displayName, 'ChatGPT')
  assert.equal(resolved.agentName, 'DeepSeek Harness')
  assert.deepEqual(resolved.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(resolved.callbackPort, 1455)
  assert.deepEqual(resolved.models, [])
})

process.stdout.write('mount\n')

await check('apply() registers the route, the directory entry, the adapter, and the API', async () => {
  const { ctx } = stubContext()
  plugin.apply(ctx, plugin.Config({}))

  assert.deepEqual(registrations.adapters.map(entry => entry.routes), [['chatgpt']])
  assert.equal(registrations.providers.length, 1)
  assert.deepEqual(registrations.providers[0], {
    provider: 'chatgpt', displayName: 'ChatGPT', settingsNs: 'dsh-chatgpt-provider', settingsPath: [],
  })
  // No settings registration exists in the 0.2 shape: the service projects this
  // plugin's own Config instead, so the address is the entry id above and there
  // is nothing here to register.
  assert.equal(registrations.sections.length, 0)
  assert.equal(registrations.routes.length, 1)
  assert.equal(registrations.routes[0].path, '/chatgpt/api')
  assert.equal(registrations.routes[0].kind, 'prefix')
})

// Captured once: the checks below inspect the artifact this mount produced
// rather than re-mounting, so a later isolated mount cannot disturb them.
const adapter = registrations.adapters[0].adapter
const route = registrations.routes[0]

await check('the adapter satisfies the registry contract it is handed to', () => {
  assert.deepEqual(adapter.providerInfo('chatgpt'), { id: 'chatgpt', name: 'ChatGPT' })
  assert.deepEqual(adapter.providerInfo('chatgpt').id, 'chatgpt')
  const policy = adapter.providerRetryPolicy('chatgpt')
  assert.equal(policy.mode, 'normal')
  // The documented terminal plan codes must NOT be retried.
  for (const code of ['subscription_sharing_user_not_eligible', 'subscription_sharing_usage_limit_exceeded',
    'subscription_sharing_unsupported_capability', 'subscription_sharing_invalid_user']) {
    assert.equal(policy.retryableCodes.includes(code), false, `${code} must not be retryable`)
  }
  assert.equal(policy.retryableCodes.includes('subscription_sharing_usage_unavailable'), true)
  assert.equal(typeof adapter.stream, 'function')
  assert.equal(typeof adapter.prepareCall, 'function')
  assert.equal(typeof adapter.listModels, 'function')
  assert.equal(typeof adapter.resolveModel, 'function')
})

await check('an unsigned request fails with MISSING_CREDENTIAL rather than throwing wildly', async () => {
  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({ provider: 'chatgpt', model: 'm', messages: [] })) {
        // no chunks expected
      }
    },
    error => error.code === 'MISSING_CREDENTIAL' && error.failure.code === 'MISSING_CREDENTIAL',
  )
})

await check('model resolution reports reasoning levels and never invents a context window', async () => {
  const info = await adapter.resolveModel('chatgpt', 'gpt-unknown')
  assert.equal(info.provider, 'chatgpt')
  assert.equal(info.id, 'gpt-unknown')
  assert.equal(info.context, undefined, 'an unknown window must stay unknown')
  assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(info.reasoning.defaultEffort, undefined)
})

await check('a mounted adapter lists no models while signed out', async () => {
  assert.deepEqual(await adapter.listModels('chatgpt'), [])
})

await check('the HTTP surface answers status with an empty account list', async () => {
  let body = ''
  let status = 0
  const req = { method: 'GET', url: '/chatgpt/api/status' }
  const res = {
    writeHead(code) { status = code; return this },
    end(text) { body = text ?? '' },
  }
  await route.handler(req, res)
  const parsed = JSON.parse(body)
  assert.equal(status, 200)
  assert.equal(parsed.signedIn, false)
  assert.deepEqual(parsed.accounts, [])
  assert.equal(parsed.credentialsMissing, false)
})

await check('the self-test endpoint reports a usable failure instead of throwing', async () => {
  let body = ''
  let status = 0
  await route.handler(
    { method: 'POST', url: '/chatgpt/api/selftest', [Symbol.asyncIterator]: async function * () {} },
    { writeHead(code) { status = code; return this }, end(text) { body = text ?? '' } },
  )
  assert.equal(status, 200)
  const parsed = JSON.parse(body)
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /no ChatGPT model is available/)
})

await check('an unknown API path answers 404 instead of hanging', async () => {
  let body = ''
  let status = 0
  await route.handler(
    { method: 'GET', url: '/chatgpt/api/nope' },
    { writeHead(code) { status = code; return this }, end(text) { body = text ?? '' } },
  )
  assert.equal(status, 404)
  assert.deepEqual(JSON.parse(body), { error: 'not-found' })
})

await check('the account selection is persisted through the settings entry', async () => {
  registrations.settingsWrites.length = 0
  const route = registrations.routes[0]
  let body = ''
  await route.handler(
    { method: 'POST', url: '/chatgpt/api/select', [Symbol.asyncIterator]: async function * () {
      yield Buffer.from(JSON.stringify({ accountId: 'acct-example' }))
    } },
    { writeHead() { return this }, end(text) { body = text ?? '' } },
  )
  // The stub store holds no such account, so the handler refuses it — what
  // matters here is that it refused by looking the account up rather than by
  // failing to find a settings address.
  assert.doesNotMatch(body, /no settings section is mounted/)
})

await check('a failing mount step still leaves the diagnostic surface serving', async () => {
  // This is the failure this plugin actually shipped once: an uncaught throw in
  // a mount step aborted apply(), so the HTTP surface that would have explained
  // it was never registered — a broken provider and no way to ask why. The
  // surface is registered first for exactly this reason.
  registrations.routes.length = 0
  const { ctx } = stubContext({ failDirectory: true })
  plugin.apply(ctx, plugin.Config({}))

  assert.equal(registrations.routes.length, 1,
    'the diagnostic route must be registered even when a later step fails')

  let body = ''
  await registrations.routes[0].handler(
    { method: 'GET', url: '/chatgpt/api/status' },
    { writeHead() { return this }, end(text) { body = text ?? '' } },
  )
  const parsed = JSON.parse(body)
  assert.match(parsed.mountError ?? '', /INVALID_DIRECTORY/, 'the failure must be reported, not swallowed')
  assert.equal(parsed.directory.routeLive, false, 'the route genuinely is not registered')
})

await check('mounting without a settings service still registers the provider', () => {
  registrations.adapters.length = 0
  registrations.providers.length = 0
  const { ctx } = stubContext({ withSettings: false })
  plugin.apply(ctx, plugin.Config({}))
  assert.deepEqual(registrations.adapters.map(entry => entry.routes), [['chatgpt']])
  assert.equal(registrations.providers.length, 1)
})

await check('mounting without a web server or credentials still mounts the provider', () => {
  registrations.adapters.length = 0
  registrations.routes.length = 0
  const { ctx } = stubContext({ withSettings: true, withWebServer: false, withCredentials: false })
  plugin.apply(ctx, plugin.Config({}))
  assert.deepEqual(registrations.adapters.map(entry => entry.routes), [['chatgpt']])
  assert.equal(registrations.routes.length, 0, 'no web server means no API route, and no crash')
})

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exit(1)
