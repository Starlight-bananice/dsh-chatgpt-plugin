#!/usr/bin/env node
/**
 * End-to-end sign-in test against a local stand-in for OpenAI's authorization
 * server.
 *
 * It drives the *whole* flow through the plugin's own code — PKCE generation,
 * the authorization URL, the loopback callback listener, state validation, the
 * code exchange, real RS256 ID-token verification against a served JWKS, grant
 * persistence, access-token resolution, rotating refresh, and revocation — with
 * only the remote endpoints swapped for a local server. That is the same seam
 * `OAuthEndpoints` exists for, and it is why this test can assert things no
 * hand-written unit test would: the PKCE verifier is checked by a server that
 * actually recomputes the challenge, and the ID token is verified against a key
 * it did not issue.
 *
 * Usage: node tests/signin.mjs
 */

import assert from 'node:assert/strict'
import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KEY_ID = 'test-key-1'
const ISSUED_CLIENT_ID = 'oaiapp_testissued123'

/** base64url without padding, as JOSE uses. */
const b64 = value => Buffer.from(value).toString('base64url')

/** Mint a signed ID token for the fake issuer. */
function idToken(claims) {
  const header = b64(JSON.stringify({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' }))
  const payload = b64(JSON.stringify(claims))
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey)
  return `${header}.${payload}.${b64(signature)}`
}

/** Server-side state the fake token endpoint checks against. */
const state = {
  issuedCodes: new Map(),
  liveRefreshTokens: new Set(),
  /** How many refresh grants the fake endpoint actually served. */
  refreshCount: 0,
  revoked: [],
  /** Set to force the next token response to be rejected. */
  failNextExchange: undefined,
  /** Overrides merged into the next ID token, to exercise claim validation. */
  idTokenOverrides: {},
}

/** Read a request body. */
async function body(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const send = (status, payload, raw = false) => {
    res.writeHead(status, { 'content-type': raw ? 'application/json' : 'application/json' })
    res.end(raw ? payload : JSON.stringify(payload))
  }

  if (url.pathname === '/jwks') {
    const jwk = publicKey.export({ format: 'jwk' })
    send(200, { keys: [{ ...jwk, kid: KEY_ID, alg: 'RS256', use: 'sig' }] })
    return
  }

  if (url.pathname === '/.well-known/openid-configuration') {
    send(200, { issuer: ISSUER, revocation_endpoint: `${BASE}/revoke` })
    return
  }

  if (url.pathname === '/revoke' && req.method === 'POST') {
    void body(req).then((form) => {
      state.revoked.push({ token: form.get('token'), hint: form.get('token_type_hint'), clientId: form.get('client_id') })
      // The documented success response is an empty 200.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end()
    })
    return
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    void body(req).then((form) => {
      if (state.failNextExchange !== undefined) {
        const failure = state.failNextExchange
        state.failNextExchange = undefined
        send(failure.status, failure.body)
        return
      }
      const grantType = form.get('grant_type')
      const clientId = form.get('client_id')

      if (grantType === 'authorization_code') {
        const code = form.get('code')
        const record = state.issuedCodes.get(code)
        if (record === undefined) {
          send(400, { error: 'invalid_grant', error_description: 'unknown code' })
          return
        }
        state.issuedCodes.delete(code)
        // Recompute the challenge from the verifier: this is what makes the
        // test prove the client's PKCE is correct rather than merely present.
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
        if (challenge !== record.challenge) {
          send(400, { error: 'invalid_grant', error_description: 'PKCE verifier did not match the challenge' })
          return
        }
        if (form.get('redirect_uri') !== record.redirectUri) {
          send(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
          return
        }
        if (form.get('resource') !== RESOURCE) {
          send(400, { error: 'invalid_grant', error_description: 'resource missing or wrong' })
          return
        }
        if (clientId !== ISSUED_CLIENT_ID) {
          send(400, { error: 'invalid_client', error_description: `unexpected client_id ${clientId}` })
          return
        }
        const refresh = `refresh-${randomUUID()}`
        state.liveRefreshTokens.add(refresh)
        send(200, {
          access_token: `access-${randomUUID()}`,
          refresh_token: refresh,
          id_token: idToken({
            iss: ISSUER,
            aud: ISSUED_CLIENT_ID,
            sub: 'user-subject-1',
            email: 'tester@example.com',
            nonce: record.nonce,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
            scope: GRANTED_SCOPE,
            ...state.idTokenOverrides,
          }),
          token_type: 'Bearer',
          expires_in: 3600,
          scope: GRANTED_SCOPE,
        })
        return
      }

      if (grantType === 'refresh_token') {
        state.refreshCount += 1
        const presented = form.get('refresh_token')
        // Rotation is one-time-use: a spent token must never work again, which
        // is exactly the failure a non-serialized refresh would produce.
        if (!state.liveRefreshTokens.has(presented)) {
          send(400, { error: 'invalid_grant', error_description: 'refresh token already used or unknown' })
          return
        }
        state.liveRefreshTokens.delete(presented)
        if (form.get('scope') !== null) {
          send(400, { error: 'invalid_request', error_description: 'scope must be omitted on refresh' })
          return
        }
        if (form.get('resource') !== RESOURCE) {
          send(400, { error: 'invalid_request', error_description: 'resource must be repeated on refresh' })
          return
        }
        const refresh = `refresh-${randomUUID()}`
        state.liveRefreshTokens.add(refresh)
        send(200, {
          access_token: `access-refreshed-${randomUUID()}`,
          refresh_token: refresh,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: GRANTED_SCOPE,
        })
        return
      }

      send(400, { error: 'unsupported_grant_type' })
    })
    return
  }

  send(404, { error: 'not_found' })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const PORT = server.address().port
const BASE = `http://127.0.0.1:${PORT}`
const ISSUER = BASE
const RESOURCE = 'https://api.openai.com/v1'
const GRANTED_SCOPE = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke'

const ENDPOINTS = {
  authorize: `${BASE}/authorize`,
  token: `${BASE}/token`,
  discovery: `${BASE}/.well-known/openid-configuration`,
  jwks: `${BASE}/jwks`,
  issuer: ISSUER,
}

// Imported after the server exists so the module's own constants cannot mask a
// mistake in how the endpoints are threaded through.
const { SignInManager } = await import('../lib/signin.js')
const { accessTokenFor, listAccounts, readGrant, ensureHostId } = await import('../lib/accounts.js')
const { revokeSession } = await import('../lib/oauth.js')

/**
 * In-memory credential store.
 *
 * `modifyRecord` is serialized through one promise chain, because the real
 * service performs a *locked* read-modify-write and anything relying on that
 * (the host identifier, a rotating refresh token) would be tested against a
 * weaker contract than it actually runs under.
 */
function store() {
  const records = new Map()
  let chain = Promise.resolve()
  const counters = { reads: 0, modifies: 0 }
  return {
    counters,
    readRecord: async key => { counters.reads += 1; return records.get(key) },
    listRecords: async () => [...records.entries()].map(([key, value]) => ({ key, kind: value.kind })),
    modifyRecord: (key, mutate) => {
      counters.modifies += 1
      const run = chain.then(async () => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return next
      })
      // The chain must survive a rejected mutation, or one failure would wedge
      // every later write.
      chain = run.then(() => undefined, () => undefined)
      return run
    },
    deleteRecord: async key => { records.delete(key) },
    _records: records,
  }
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

/** Build a manager over a fresh store. */
function manager(credentials, overrides = {}) {
  return new SignInManager({
    credentials: () => credentials,
    config: () => ({ agentName: 'DeepSeek Harness', callbackPort: 14400 + Math.floor(Math.random() * 400), ...overrides }),
    hostId: async () => 'urn:uuid:test-host-0000-4000-8000-000000000000',
    onNotice: () => {},
    endpoints: ENDPOINTS,
  })
}

/** Poll until the attempt settles, or give up. */
async function settled(mgr, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const view = mgr.view()
    if (view.state !== 'waiting' && view.state !== 'exchanging') return view
    if (Date.now() > deadline) throw new Error(`attempt did not settle; still ${view.state}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * Act as the browser: read the authorization request the client built, register
 * the code server-side, then hit the loopback callback exactly as OpenAI would.
 */
async function actAsBrowser(view, { omitClientId = false, wrongState = false, error = undefined } = {}) {
  const authorize = new URL(view.url)
  const attemptState = authorize.searchParams.get('state')
  const redirectUri = authorize.searchParams.get('redirect_uri')
  const challenge = authorize.searchParams.get('code_challenge')
  const nonce = authorize.searchParams.get('nonce')

  const callback = new URL(redirectUri)
  if (error !== undefined) {
    callback.searchParams.set('error', error)
    callback.searchParams.set('state', wrongState ? 'not-the-state' : attemptState)
  } else {
    const code = `code-${randomUUID()}`
    // Registered server-side so the token endpoint can validate the exchange
    // against the very challenge this attempt sent.
    state.issuedCodes.set(code, { challenge, nonce, redirectUri })
    callback.searchParams.set('code', code)
    callback.searchParams.set('state', wrongState ? 'not-the-state' : attemptState)
    callback.searchParams.set('scope', GRANTED_SCOPE)
    if (!omitClientId) callback.searchParams.set('client_id', ISSUED_CLIENT_ID)
  }
  const response = await fetch(callback)
  return { status: response.status, authorize }
}

process.stdout.write('host identifier\n')

await check('the host id is minted once and reused across calls', async () => {
  const credentials = store()
  let minted = 0
  const first = await ensureHostId(credentials, () => { minted += 1; return `urn:uuid:host-${minted}` })
  const second = await ensureHostId(credentials, () => { minted += 1; return `urn:uuid:host-${minted}` })
  assert.equal(first, second)
  assert.equal(minted, 1, 'a second call must not mint a new identity')
})

await check('a concurrent first use still yields exactly one host id', async () => {
  const credentials = store()
  let minted = 0
  const results = await Promise.all([1, 2, 3, 4].map(async () =>
    ensureHostId(credentials, () => { minted += 1; return `urn:uuid:race-${minted}` })))
  assert.equal(new Set(results).size, 1, `all callers must agree; got ${JSON.stringify(results)}`)
  if (minted !== 1) {
    // The seam serializes writes, so a single record is the contract; more than
    // one mint is tolerable only if the stored value is the one everyone read.
    assert.equal(results[0], results[1])
  }
})

process.stdout.write('full sign-in\n')

await check('a complete sign-in stores a plan-enabled account', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  const started = await mgr.start({ kind: 'new' })
  assert.equal(started.state, 'waiting')
  assert.ok(started.url !== undefined)
  const authorize = new URL(started.url)
  assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(authorize.searchParams.get('agent_name_hint'), 'DeepSeek Harness')
  assert.equal(authorize.searchParams.get('ext_agent_host_id'), 'urn:uuid:test-host-0000-4000-8000-000000000000')
  assert.ok(authorize.searchParams.get('code_challenge') !== null)

  const { status } = await actAsBrowser(mgr.view())
  assert.equal(status, 200)
  const view = await settled(mgr)
  assert.equal(view.state, 'completed', `expected completion, got ${JSON.stringify(view)}`)

  const accounts = await listAccounts(credentials)
  assert.equal(accounts.length, 1)
  const account = accounts[0]
  assert.equal(account.email, 'tester@example.com')
  assert.equal(account.subject, 'user-subject-1')
  assert.equal(account.clientId, ISSUED_CLIENT_ID, 'the issued client id must be what is stored')
  assert.equal(account.planEnabled, true)
  assert.deepEqual(account.scopes, GRANTED_SCOPE.split(' '))
  // The grant must carry the host identity and issuer this attempt used, or a
  // later refresh would authorize from an identity the host does not have.
  const stored = await readGrant(credentials, account.id)
  assert.equal(stored.hostId, 'urn:uuid:test-host-0000-4000-8000-000000000000')
  assert.equal(stored.issuer, ISSUER)
  assert.ok(typeof stored.idToken === 'string' && stored.idToken.length > 0,
    'the id token must be retained for a later id_token_hint')
})

await check('a fresh token is served from a plain read, taking no document lock', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  await actAsBrowser(mgr.view())
  await settled(mgr)
  const accounts = await listAccounts(credentials)
  const before = await readGrant(credentials, accounts[0].id)

  // Every model request resolves its token here, so the fresh path must not
  // acquire the credential document's lock: doing so would serialize unrelated
  // requests against each other for no reason.
  const modifiesBefore = credentials.counters.modifies
  const { accessToken, grant } = await accessTokenFor(credentials, accounts[0].id, undefined, ENDPOINTS)
  assert.equal(accessToken, before.accessToken)
  assert.equal(grant.refreshToken, before.refreshToken, 'a fresh token must not rotate')
  assert.equal(credentials.counters.modifies, modifiesBefore,
    'serving a fresh token must not write through the locked path')
})

await check('a stale token does take the locked path', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  await actAsBrowser(mgr.view())
  await settled(mgr)
  const id = (await listAccounts(credentials))[0].id
  const grant = await readGrant(credentials, id)
  await credentials.modifyRecord(`chatgpt/${id}`, async () => ({
    kind: 'grant', payload: { ...grant, expiresAt: Date.now() - 1000 },
  }))
  const modifiesBefore = credentials.counters.modifies
  await accessTokenFor(credentials, id, undefined, ENDPOINTS)
  assert.equal(credentials.counters.modifies, modifiesBefore + 1,
    'a refresh must go through the locked read-modify-write exactly once')
})

await check('earliest_refresh_at does not retire a token that has not expired', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  await actAsBrowser(mgr.view())
  await settled(mgr)
  const id = (await listAccounts(credentials))[0].id
  const grant = await readGrant(credentials, id)
  // The real server sets this roughly 54 minutes into a 60-minute token, so it
  // sits in the future for most of the token's life. Treating it as a usability
  // gate makes every request refresh — a token exchange and a refresh-token
  // rotation per model call — which the provider tolerates, so nothing looks
  // broken. It only costs a round trip and churns a single-use credential.
  await credentials.modifyRecord(`chatgpt/${id}`, async () => ({
    kind: 'grant',
    payload: { ...grant, earliestRefreshAt: Math.floor(Date.now() / 1000) + 3600 },
  }))
  const modifiesBefore = credentials.counters.modifies
  const { accessToken, grant: served } = await accessTokenFor(credentials, id, undefined, ENDPOINTS)
  assert.equal(accessToken, grant.accessToken, 'the stored token must be served as-is')
  assert.equal(served.refreshToken, grant.refreshToken, 'the refresh token must not rotate')
  assert.equal(credentials.counters.modifies, modifiesBefore,
    'a usable token must not take the locked refresh path')
})

await check('an expired token refreshes and rotates the refresh token', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  await actAsBrowser(mgr.view())
  await settled(mgr)
  const accounts = await listAccounts(credentials)
  const id = accounts[0].id

  // Age the grant past the refresh margin, keeping the refresh token live.
  const grant = await readGrant(credentials, id)
  await credentials.modifyRecord(`chatgpt/${id}`, async () => ({
    kind: 'grant', payload: { ...grant, expiresAt: Date.now() - 1000 },
  }))
  const stale = grant.refreshToken

  const { accessToken, grant: refreshed } = await accessTokenFor(credentials, id, undefined, ENDPOINTS)
  assert.match(accessToken, /^access-refreshed-/, 'a stale token must be renewed')
  assert.notEqual(refreshed.refreshToken, stale, 'the refresh token must rotate')
  // The old token is now spent: replaying it must fail, which is the whole
  // reason refreshes have to be serialized.
  const replayed = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: ISSUED_CLIENT_ID, refresh_token: stale, resource: RESOURCE,
    }),
  })
  assert.equal(replayed.status, 400, 'a spent refresh token must be rejected')
  assert.equal((await readGrant(credentials, id)).refreshToken, refreshed.refreshToken,
    'the rotated token must be the one persisted')
})

await check('a second refresh uses the rotated token, not the first', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  await actAsBrowser(mgr.view())
  await settled(mgr)
  const id = (await listAccounts(credentials))[0].id
  for (let round = 0; round < 3; round += 1) {
    const grant = await readGrant(credentials, id)
    await credentials.modifyRecord(`chatgpt/${id}`, async () => ({
      kind: 'grant', payload: { ...grant, expiresAt: Date.now() - 1000 },
    }))
    const { accessToken } = await accessTokenFor(credentials, id, undefined, ENDPOINTS)
    assert.match(accessToken, /^access-refreshed-/, `round ${String(round)} failed to refresh`)
  }
})

await check('two concurrent resolutions of a stale token refresh exactly once', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  await actAsBrowser(mgr.view())
  await settled(mgr)
  const id = (await listAccounts(credentials))[0].id
  const grant = await readGrant(credentials, id)
  await credentials.modifyRecord(`chatgpt/${id}`, async () => ({
    kind: 'grant', payload: { ...grant, expiresAt: Date.now() - 1000 },
  }))

  // The documented requirement: refreshes for one session must be serialized,
  // because the refresh token is single-use and rotates on every exchange. Two
  // racing refreshes would leave one of them holding a token that no longer
  // works, wedging the account until a manual re-sign-in.
  const before = state.refreshCount
  const [first, second] = await Promise.all([
    accessTokenFor(credentials, id, undefined, ENDPOINTS),
    accessTokenFor(credentials, id, undefined, ENDPOINTS),
  ])
  assert.equal(state.refreshCount - before, 1, 'exactly one refresh exchange may be performed')
  assert.equal(first.accessToken, second.accessToken, 'both callers must receive the same token')
  assert.equal((await readGrant(credentials, id)).accessToken, first.accessToken,
    'the rotated token must be the one persisted')
})

await check('a burst of concurrent resolutions still refreshes at most once', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  await actAsBrowser(mgr.view())
  await settled(mgr)
  const id = (await listAccounts(credentials))[0].id
  const grant = await readGrant(credentials, id)
  await credentials.modifyRecord(`chatgpt/${id}`, async () => ({
    kind: 'grant', payload: { ...grant, expiresAt: Date.now() - 1000 },
  }))
  const before = state.refreshCount
  const results = await Promise.all(Array.from({ length: 8 }, async () =>
    accessTokenFor(credentials, id, undefined, ENDPOINTS)))
  assert.equal(state.refreshCount - before, 1, 'a burst must collapse to one refresh exchange')
  assert.equal(new Set(results.map(entry => entry.accessToken)).size, 1)
})

process.stdout.write('callback and claim validation\n')

await check('a callback with the wrong state never settles the attempt', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  const { status } = await actAsBrowser(mgr.view(), { wrongState: true })
  assert.equal(status, 400, 'a state mismatch must be refused with 400')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(mgr.view().state, 'waiting', 'the attempt must still be waiting')
  mgr.cancel()
})

await check('declined consent settles as cancelled, not failed', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  await actAsBrowser(mgr.view(), { error: 'access_denied' })
  const view = await settled(mgr)
  assert.equal(view.state, 'cancelled')
  assert.equal((await listAccounts(credentials)).length, 0)
})

await check('a new registration without an issued client id is refused', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  await actAsBrowser(mgr.view(), { omitClientId: true })
  const view = await settled(mgr)
  assert.equal(view.state, 'failed')
  assert.match(view.error ?? '', /MISSING_ISSUED_CLIENT_ID/)
  assert.equal((await listAccounts(credentials)).length, 0, 'nothing may be stored')
})

await check('an ID token whose nonce is wrong is rejected', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  state.idTokenOverrides = { nonce: 'a-different-nonce' }
  try {
    await actAsBrowser(mgr.view())
    const view = await settled(mgr)
    assert.equal(view.state, 'failed')
    assert.match(view.error ?? '', /ID_TOKEN_INVALID/)
    assert.equal((await listAccounts(credentials)).length, 0)
  } finally {
    state.idTokenOverrides = {}
  }
})

await check('an ID token minted for another audience is rejected', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  state.idTokenOverrides = { aud: 'some-other-client' }
  try {
    await actAsBrowser(mgr.view())
    const view = await settled(mgr)
    assert.equal(view.state, 'failed')
    assert.match(view.error ?? '', /ID_TOKEN_INVALID/)
  } finally {
    state.idTokenOverrides = {}
  }
})

await check('a token endpoint failure surfaces its code without storing anything', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  state.failNextExchange = {
    status: 400,
    body: { error: 'invalid_grant', error_description: 'code already used' },
  }
  await actAsBrowser(mgr.view())
  const view = await settled(mgr)
  assert.equal(view.state, 'failed')
  assert.match(view.error ?? '', /REFRESH_TOKEN_UNUSABLE|TOKEN_REQUEST_FAILED/)
  assert.equal((await listAccounts(credentials)).length, 0)
})

await check('cancelling an attempt releases the listener and settles as cancelled', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  const started = await mgr.start({ kind: 'new' })
  assert.equal(started.state, 'waiting')
  const view = mgr.cancel()
  assert.equal(view.state, 'cancelled')
})

await check('reauthorizing reuses the issued client id and omits the app name hint', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  await actAsBrowser(mgr.view())
  await settled(mgr)
  const id = (await listAccounts(credentials))[0].id

  const second = manager(credentials)
  const started = await second.start({ kind: 'account', id })
  const authorize = new URL(started.url)
  assert.equal(authorize.searchParams.get('client_id'), ISSUED_CLIENT_ID)
  assert.equal(authorize.searchParams.has('agent_name_hint'), false)
  assert.equal(authorize.searchParams.get('login_hint'), 'tester@example.com')
  assert.ok(authorize.searchParams.get('id_token_hint') !== null, 'the retained id token is the hint')
  second.cancel()
})

await check('another attempt is refused while one is in flight', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  await assert.rejects(() => mgr.start({ kind: 'new' }), error => error.code === 'ALREADY_IN_FLIGHT')
  mgr.cancel()
})

process.stdout.write('sign-out\n')

await check('revocation posts the documented form and an empty 200 is success', async () => {
  const credentials = store()
  const mgr = manager(credentials)
  await mgr.start({ kind: 'new' })
  await actAsBrowser(mgr.view())
  await settled(mgr)
  const grant = await readGrant(credentials, (await listAccounts(credentials))[0].id)
  const before = state.revoked.length
  await revokeSession({ clientId: grant.clientId, refreshToken: grant.refreshToken }, ENDPOINTS)
  assert.equal(state.revoked.length, before + 1)
  const last = state.revoked.at(-1)
  assert.equal(last.token, grant.refreshToken)
  assert.equal(last.hint, 'refresh_token')
  assert.equal(last.clientId, ISSUED_CLIENT_ID)
})

server.close()

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exit(1)
