import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startService } from '../src/service.ts'
import { PNG } from './fixtures.ts'
import http from 'node:http'

const FAKE = new URL('./fake-codex.mjs', import.meta.url).pathname
fs.chmodSync(FAKE, 0o755)

export async function boot(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-svc-'))
  const svc = await startService({ dir, port: 0, codexBin: FAKE, tickMs: 30, pollMs: 400, staleMs: 300, codexTimeoutMs: 800, ...extra })
  const base = `http://127.0.0.1:${svc.port}`
  const call = async (method: string, p: string, body?: unknown, o: { key?: string; headers?: Record<string, string>; raw?: Buffer | string } = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${o.key ?? svc.keys.uiKey}`, ...o.headers }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const r = await fetch(base + p, { method, headers, body: o.raw ?? (body === undefined ? undefined : JSON.stringify(body)) })
    const text = await r.text()
    return { status: r.status, body: text.startsWith('{') ? JSON.parse(text) : text }
  }
  const adapter = (p: string, body: unknown) => call('POST', '/api/adapter/' + p, body, { key: svc.keys.adapterKey })
  after(() => svc.close())
  return { svc, dir, base, call, adapter }
}

const until = async (fn: () => Promise<boolean> | boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 25)) }
  throw new Error('timed out waiting')
}

test('rejects missing keys, wrong key type, foreign origins, and rebinding hosts', async () => {
  const { call, base, svc } = await boot()
  assert.equal((await call('GET', '/api/destinations', undefined, { key: 'nope' })).status, 401)
  assert.equal((await call('GET', '/api/destinations', undefined, { key: svc.keys.adapterKey })).status, 401, 'adapter key is not a UI key')
  assert.equal((await call('GET', '/api/destinations', undefined, { headers: { origin: 'https://evil.example' } })).status, 403)
  const status = await new Promise(res => http.get(base + '/api/destinations', { headers: { authorization: `Bearer ${svc.keys.uiKey}`, host: `evil.example:${svc.port}` } }, r => { r.resume(); res(r.statusCode) }))
  assert.equal(status, 403)
  assert.equal((await call('GET', '/api/destinations')).status, 200)
  const page = await fetch(base + '/')
  assert.match(page.headers.get('content-security-policy')!, /script-src 'self'/)
})

test('codex: open, stage, send, delivered via codex queue with image paths; double send is one submission', async () => {
  const { call, adapter, dir, svc } = await boot()
  const log = path.join(dir, 'codex-calls.log')
  process.env.FAKE_CODEX_LOG = log
  process.env.FAKE_CODEX_MODE = 'ok'
  const open = await adapter('open', { agent: 'codex', conversationId: '01a0fdb2-e358-7540-959c-d4bc74b11d81', project: '/work/app' })
  assert.equal(open.status, 200)
  const id = open.body.destination.id
  assert.match(open.body.url, new RegExp(`\\?d=${id}#k=${svc.keys.uiKey}$`))
  const up = await call('POST', `/api/destinations/${id}/draft/items?name=shot.png`, undefined, { raw: PNG, headers: { 'content-type': 'image/png' } })
  assert.equal(up.body.kind, 'image')
  const [a, b] = await Promise.all([
    call('POST', `/api/destinations/${id}/submissions`, { id: 'sub-aaaaaaaa', note: 'Fix the clipped button' }),
    call('POST', `/api/destinations/${id}/submissions`, { id: 'sub-aaaaaaaa', note: 'Fix the clipped button' }),
  ])
  assert.deepEqual([a.status, b.status].sort(), [200, 201])
  await until(async () => (await call('GET', `/api/destinations/${id}`)).body.submissions[0].state === 'delivered')
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(calls.length, 1, 'exactly one codex queue call')
  const args = calls[0]
  assert.deepEqual(args.slice(0, 3), ['queue', '--thread', '01a0fdb2-e358-7540-959c-d4bc74b11d81'])
  assert.match(args[4], /Fix the clipped button/)
  const imgPath = /Image shot\.png, image\/png, 70 B: (\S+)/.exec(args[4])![1]
  assert.ok(fs.existsSync(imgPath), 'message names a real readable image file')
  const sub = (await call('GET', `/api/destinations/${id}`)).body.submissions[0]
  assert.match(sub.hostRef, /^msg-/)
})

test('codex failure keeps material for retry; timeout becomes uncertain', async () => {
  const { call, adapter } = await boot()
  process.env.FAKE_CODEX_LOG = ''
  process.env.FAKE_CODEX_MODE = 'fail'
  const id = (await adapter('open', { agent: 'codex', conversationId: 'thread-fail' })).body.destination.id
  await call('POST', `/api/destinations/${id}/draft/items`, { url: 'https://example.com/docs' })
  await call('POST', `/api/destinations/${id}/submissions`, { id: 'sub-fail0001' })
  const state = async () => (await call('GET', `/api/destinations/${id}`)).body.submissions[0]
  await until(async () => (await state()).state === 'failed')
  assert.match((await state()).history.at(-1).detail, /thread not found/)
  process.env.FAKE_CODEX_MODE = 'hang'
  assert.equal((await call('POST', '/api/submissions/sub-fail0001/retry')).status, 200)
  await until(async () => (await state()).state === 'uncertain', 4000)
  process.env.FAKE_CODEX_MODE = 'ok'
  await call('POST', '/api/submissions/sub-fail0001/retry')
  await until(async () => (await state()).state === 'delivered')
})

test('claude: long-poll hands out in order, report marks sent, read marks retrieved, ownership enforced', async () => {
  const { call, adapter, svc } = await boot()
  const conv = 'aaaaaaaa-1111-2222-3333-444444444444'
  const id = (await adapter('open', { agent: 'claude', conversationId: conv, label: 'Fix login' })).body.destination.id
  let dest = (await call('GET', `/api/destinations/${id}`)).body.destination
  assert.equal(dest.connection, 'disconnected', 'no adapter polling yet')
  const { connId } = (await adapter('connect', { agent: 'claude', conversationId: conv })).body
  for (const n of [1, 2]) {
    await call('PUT', `/api/destinations/${id}/draft`, { note: `note ${n}` })
    await call('POST', `/api/destinations/${id}/submissions`, { id: `sub-ord0000${n}` })
  }
  const poll = () => call('GET', `/api/adapter/poll?conn=${connId}`, undefined, { key: svc.keys.adapterKey })
  const p1 = await poll()
  assert.equal(p1.body.submission.id, 'sub-ord00001')
  assert.match(p1.body.text, /note 1/)
  const p2 = await poll()
  assert.equal(p2.body.submission, null, 'second waits until first is resolved')
  await adapter('report', { connId, submissionId: 'sub-ord00001', ok: true })
  assert.equal((await poll()).body.submission.id, 'sub-ord00002')
  dest = (await call('GET', `/api/destinations/${id}`)).body.destination
  assert.equal(dest.connection, 'connected')
  // Another conversation cannot read it.
  assert.equal((await adapter('read', { agent: 'claude', conversationId: 'someone-else', submissionId: 'sub-ord00001' })).status, 404)
  const read = await adapter('read', { agent: 'claude', conversationId: conv, submissionId: 'sub-ord00001' })
  assert.equal(read.body.submission.state, 'retrieved')
  // Adapter dies with sub 2 in flight -> uncertain, never silently lost.
  await until(async () => (await call('GET', `/api/destinations/${id}`)).body.submissions[0].state === 'uncertain', 3000)
})

test('routing: ten destinations, duplicate labels, same project, distinct deliveries', async () => {
  const { call, adapter, dir } = await boot()
  const log = path.join(dir, 'route.log')
  process.env.FAKE_CODEX_LOG = log
  process.env.FAKE_CODEX_MODE = 'ok'
  const ids: string[] = []
  for (let i = 0; i < 10; i++) {
    const r = await adapter('open', { agent: 'codex', conversationId: `thread-${i}`, label: 'Same title', project: '/same/project' })
    ids.push(r.body.destination.id)
  }
  assert.equal(new Set(ids).size, 10)
  await Promise.all(ids.map((id, i) => call('POST', `/api/destinations/${id}/submissions`, { id: `sub-route00${i}`, note: `payload-${i}` })))
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim().split('\n').length === 10)
  for (const line of fs.readFileSync(log, 'utf8').trim().split('\n')) {
    const a = JSON.parse(line)
    const thread = a[2].replace('thread-', '')
    assert.match(a[4], new RegExp(`payload-${thread}\\b`), 'payload went to its own thread')
  }
})

test('closed destination refuses new material; stale tab cannot send', async () => {
  const { call, adapter } = await boot()
  const id = (await adapter('open', { agent: 'codex', conversationId: 'thread-close' })).body.destination.id
  await call('DELETE', `/api/destinations/${id}`)
  const r = await call('POST', `/api/destinations/${id}/submissions`, { id: 'sub-closed01', note: 'hi' })
  assert.equal(r.status, 409)
  assert.match(r.body.error, /disconnected/)
  // Reconnecting the same chat reopens the same destination, never a different one.
  const again = await adapter('open', { agent: 'codex', conversationId: 'thread-close' })
  assert.equal(again.body.destination.id, id)
  assert.equal(again.body.destination.connection, 'available')
})

test('oversize upload is rejected without disturbing staged items; unsafe file preview is inert', async () => {
  const { call, adapter, base, svc } = await boot()
  const id = (await adapter('open', { agent: 'codex', conversationId: 'thread-size' })).body.destination.id
  process.env.FAKE_CODEX_MODE = 'hang'
  const ok = await call('POST', `/api/destinations/${id}/draft/items?name=${encodeURIComponent('<img src=x onerror=alert(1)>.html')}`, undefined, { raw: '<script>alert(1)</script>', headers: { 'content-type': 'text/html' } })
  assert.equal(ok.status, 200)
  const big = await call('POST', `/api/destinations/${id}/draft/items?name=big.txt`, undefined, { raw: Buffer.alloc(26 * 1048576, 0x61) })
  assert.equal(big.status, 413)
  assert.equal((await call('GET', `/api/destinations/${id}`)).body.draft.items.length, 1)
  assert.equal(ok.body.kind, 'text')
  const f = await fetch(`${base}/api/files/${ok.body.id}`, { headers: { authorization: `Bearer ${svc.keys.uiKey}` } })
  assert.equal(f.headers.get('content-type'), 'text/plain; charset=utf-8', 'html upload is served as inert text')
  assert.equal(f.headers.get('x-content-type-options'), 'nosniff')
  assert.match(f.headers.get('content-security-policy')!, /sandbox/)
  assert.equal(await f.text(), '<script>alert(1)</script>')
})
