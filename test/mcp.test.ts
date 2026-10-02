import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { PNG } from './fixtures.ts'

const MCP = new URL('../src/mcp.ts', import.meta.url).pathname
const FAKE = new URL('./fake-codex.mjs', import.meta.url).pathname
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-mcp-'))
// Port 0 keeps the test daemon off the user's real port.
fs.writeFileSync(path.join(home, 'keys.json'), JSON.stringify({ uiKey: 'u'.repeat(48), adapterKey: 'a'.repeat(48), port: 0 }))

function startMcp(hostName: 'claude' | 'codex', env: Record<string, string> = {}) {
  const p = spawn(process.execPath, [MCP, '--host', hostName], {
    env: { ...process.env, CONTEXT_DROP_HOME: home, CONTEXT_DROP_NO_BROWSER: '1', CONTEXT_DROP_CODEX_BIN: FAKE, FAKE_CODEX_LOG: path.join(home, 'codex.log'), FAKE_CODEX_MODE: 'ok', CLAUDE_CODE_SESSION_ID: '', ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const waiting = new Map<number, (m: any) => void>()
  const notes: any[] = []
  readline.createInterface({ input: p.stdout! }).on('line', l => {
    const m = JSON.parse(l)
    if (m.id !== undefined && waiting.has(m.id)) waiting.get(m.id)!(m)
    else notes.push(m)
  })
  let next = 1
  const rpc = (method: string, params: unknown = {}) => new Promise<any>(res => {
    const id = next++
    waiting.set(id, res)
    p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const notify = (method: string) => p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
  const tool = async (name: string, args: unknown = {}) => (await rpc('tools/call', { name, arguments: args })).result
  after(() => p.kill())
  return { rpc, notify, tool, notes }
}

const keys = () => JSON.parse(fs.readFileSync(path.join(home, 'keys.json'), 'utf8'))
const ui = async (method: string, p: string, body?: unknown, raw?: Buffer) => {
  const k = keys()
  const r = await fetch(`http://127.0.0.1:${k.port}${p}`, { method, headers: { authorization: `Bearer ${k.uiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) })
  return r.json()
}
const until = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)) }
  throw new Error('timed out')
}

after(async () => {
  const k = keys()
  await fetch(`http://127.0.0.1:${k.port}/api/adapter/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${k.adapterKey}` } }).catch(() => {})
})

test('claude host: channel capability, open_drop starts the service, send is pushed, read_drop returns the image', async () => {
  const c = startMcp('claude', { CLAUDE_CODE_SESSION_ID: 'c1aade00-0000-4000-8000-000000000001' })
  const init = (await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })).result
  assert.deepEqual(init.capabilities.experimental, { 'claude/channel': {} })
  c.notify('notifications/initialized')
  const names = (await c.rpc('tools/list')).result.tools.map((t: any) => t.name)
  assert.deepEqual(names, ['open_drop', 'list_drops', 'read_drop', 'acknowledge_drop', 'close_drop'])

  const opened = await c.tool('open_drop', { label: 'Fix login' })
  const url = /http:\/\/localhost:\d+\/\?d=([\w-]+)#k=\w+/.exec(opened.content[0].text)
  assert.ok(url, opened.content[0].text)
  const destId = url![1]
  await until(async () => (await ui('GET', `/api/destinations/${destId}`)).destination.connection === 'connected')

  await ui('POST', `/api/destinations/${destId}/draft/items?name=shot.png`, undefined, PNG)
  await ui('POST', `/api/destinations/${destId}/submissions`, { id: 'sub-mcp00001', note: 'The login button is clipped' })
  await until(() => c.notes.some(n => n.method === 'notifications/claude/channel'))
  const push = c.notes.find(n => n.method === 'notifications/claude/channel')
  assert.equal(push.params.meta.submission_id, 'sub-mcp00001')
  assert.equal(push.params.meta.destination, 'Fix login')
  assert.match(push.params.content, /The login button is clipped/)
  await until(async () => (await ui('GET', `/api/destinations/${destId}`)).submissions[0].state === 'sent')

  const read = await c.tool('read_drop', { submission_id: 'sub-mcp00001' })
  const img = read.content.find((x: any) => x.type === 'image')
  assert.equal(img.mimeType, 'image/png')
  assert.deepEqual(Buffer.from(img.data, 'base64'), PNG)
  assert.equal((await ui('GET', `/api/destinations/${destId}`)).submissions[0].state, 'retrieved')

  const list = await c.tool('list_drops')
  assert.match(list.content[0].text, /sub-mcp00001\s+retrieved/)
})

test('codex host: requires thread id, delivers via codex queue, tools scoped to that thread', async () => {
  const log = path.join(home, 'codex.log') // the daemon was started by the first test, so it carries this env
  const c = startMcp('codex', { CODEX_HOME: '/custom/codex-home' })
  const init = (await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })).result
  assert.equal(init.capabilities.experimental, undefined, 'codex host is not a Claude channel')
  const missing = await c.tool('open_drop', {})
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /CODEX_THREAD_ID/)

  const opened = await c.tool('open_drop', { conversation_id: '01a0fdb2-0000-7000-8000-00000000c0de', label: 'Codex task' })
  const destId = /\?d=([\w-]+)/.exec(opened.content[0].text)![1]
  await ui('POST', `/api/destinations/${destId}/submissions`, { id: 'sub-mcp00002', note: 'docs excerpt' })
  await until(async () => ['delivered', 'failed'].includes((await ui('GET', `/api/destinations/${destId}`)).submissions[0].state))
  const sub = (await ui('GET', `/api/destinations/${destId}`)).submissions[0]
  assert.equal(sub.state, 'delivered', JSON.stringify(sub.history))
  assert.match(fs.readFileSync(log, 'utf8'), /CODEX_HOME=\/custom\/codex-home/, 'codex queue runs against the chat\'s own Codex home')

  const other = await c.tool('read_drop', { submission_id: 'sub-mcp00002', conversation_id: 'some-other-thread' })
  assert.equal(other.isError, true, 'another thread cannot read it')
  const read = await c.tool('read_drop', { submission_id: 'sub-mcp00002', conversation_id: '01a0fdb2-0000-7000-8000-00000000c0de' })
  assert.match(read.content[0].text, /docs excerpt/)
})
