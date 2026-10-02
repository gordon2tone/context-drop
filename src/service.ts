import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { Store, UserError, describe, type Agent, type Dest, type Sub, type State } from './store.ts'

export const VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
export const DEFAULT_PORT = 47821
const WEB = new URL('../web/', import.meta.url)

export const STATE_TEXT: Record<State, string> = {
  queued: 'Queued: saved locally, waiting to deliver',
  delivering: 'Delivering to the chat…',
  sent: 'Pushed to the session. Claude Code does not confirm receipt; this becomes Retrieved when the agent reads it.',
  delivered: 'Delivered: the host accepted it into this chat. Not yet read by the agent.',
  retrieved: 'Retrieved: the agent read this submission.',
  uncertain: 'Delivery uncertain: it may already be in the chat. Check the chat before retrying.',
  failed: 'Failed: not delivered. Your material is kept and can be retried.',
  cancelled: 'Cancelled: will not be delivered.',
  expired: 'Expired: retention period ended before delivery.',
}

export type Keys = { uiKey: string; adapterKey: string; port: number }
export type ServiceOpts = { dir: string; port?: number; codexBin?: string; tickMs?: number; pollMs?: number; staleMs?: number; codexTimeoutMs?: number; onShutdown?: () => void }
type Conn = { id: string; agent: Agent; conversationId: string; lastSeen: number; polling: number }

export function loadKeys(dir: string): Keys {
  const file = path.join(dir, 'keys.json')
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  const keys = { uiKey: crypto.randomBytes(24).toString('hex'), adapterKey: crypto.randomBytes(24).toString('hex'), port: DEFAULT_PORT }
  saveKeys(dir, keys)
  return keys
}
function saveKeys(dir: string, keys: Keys) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify(keys), { mode: 0o600 })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const safeEq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

export async function startService(opts: ServiceOpts) {
  const { dir } = opts
  const tickMs = opts.tickMs ?? 500, pollMs = opts.pollMs ?? 25_000, staleMs = opts.staleMs ?? 40_000
  const store = new Store(dir)
  const keys = loadKeys(dir)
  const conns = new Map<string, Conn>()
  const inflight = new Map<string, string>() // submission id -> claude connection id
  const codexBusy = new Set<string>()
  const tmpDir = path.join(dir, 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true })

  // Diagnostics: ids, states, durations, errors. Never contents or keys.
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    fs.appendFile(path.join(dir, 'service.log'), JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n', () => {})

  // Anything left mid-delivery by a previous run has unknown outcome.
  for (const s of Object.values(store.data.submissions)) if (s.state === 'delivering') store.transition(s.id, 'uncertain', 'Service restarted during delivery')
  store.sweep()

  // Only move out of "delivering"; the agent may already have retrieved it.
  function finish(subId: string, state: State, detail?: string, hostRef?: string) {
    inflight.delete(subId)
    const s = store.data.submissions[subId]
    if (!s) return
    if (s.state === 'delivering') store.transition(subId, state, detail, hostRef)
    else { s.history.push({ state, at: store.now(), detail: `Late result ignored (now ${s.state}): ${detail ?? state}` }); store.save() }
    log('delivery', { sub: subId, state })
  }

  function connection(d: Dest): 'connected' | 'disconnected' | 'available' {
    if (d.closed) return 'disconnected'
    if (d.agent === 'codex') return 'available'
    const t = Date.now()
    return [...conns.values()].some(c => c.agent === 'claude' && c.conversationId === d.conversationId && (c.polling > 0 || t - c.lastSeen < staleMs)) ? 'connected' : 'disconnected'
  }

  const subView = (s: Sub) => ({ ...s, expiresAt: store.expiresAt(s), stateText: STATE_TEXT[s.state] })
  const destView = (d: Dest) => {
    const draft = store.data.drafts[d.id]
    const subs = store.subsFor(d.id)
    return { ...d, connection: connection(d), draftItems: draft?.items.length ?? 0, pending: subs.filter(s => ['queued', 'delivering', 'uncertain', 'failed'].includes(s.state)).length }
  }

  // ---- Codex delivery: `codex queue` is the host's own command for adding a message to an existing session.
  function codexBin() {
    // ponytail: on Windows npm installs codex as a .cmd shim that execFile cannot run without a shell;
    // set CONTEXT_DROP_CODEX_BIN to the native codex.exe until the Windows pilot pins the path.
    return opts.codexBin ?? process.env.CONTEXT_DROP_CODEX_BIN ?? 'codex'
  }
  function deliverCodex(d: Dest, s: Sub) {
    codexBusy.add(d.id)
    store.transition(s.id, 'delivering', 'Running codex queue')
    // `codex queue` (0.160) rejects -i image attachments, so images reach the agent through read_drop.
    const args = ['queue', '--thread', d.conversationId, '--message', describe(s, d, store.filesDir)]
    const started = Date.now()
    // The thread lives in the Codex home of the chat that opened this destination, not necessarily ours.
    const env = d.codexHome ? { ...process.env, CODEX_HOME: d.codexHome } : process.env
    execFile(codexBin(), args, { timeout: opts.codexTimeoutMs ?? 60_000, cwd: os.homedir(), env, windowsHide: true }, (err, stdout, stderr) => {
      codexBusy.delete(d.id)
      const ms = Date.now() - started
      const ref = /Queued message (\S+)/.exec(stdout)?.[1]
      if (!err && ref) return finish(s.id, 'delivered', `Codex queued message ${ref} (${ms} ms)`, ref)
      if (!err) return finish(s.id, 'uncertain', 'codex queue exited without a confirmation id')
      if (err.killed || (err as NodeJS.ErrnoException).code === 'ETIMEDOUT') return finish(s.id, 'uncertain', `codex queue timed out after ${ms} ms`)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return finish(s.id, 'failed', 'The codex command was not found on PATH (set CONTEXT_DROP_CODEX_BIN).')
      const why = String(stderr || err.message).trim().split('\n').filter(Boolean).pop() ?? 'unknown error'
      finish(s.id, 'failed', `codex queue failed: ${why}`)
    })
  }

  function tick() {
    for (const d of Object.values(store.data.destinations)) {
      if (d.agent !== 'codex' || d.closed || codexBusy.has(d.id)) continue
      const s = store.nextFor(d.id)
      if (s) deliverCodex(d, s)
    }
    const t = Date.now()
    for (const [subId, connId] of inflight) {
      const c = conns.get(connId)
      if (!c || (c.polling === 0 && t - c.lastSeen > staleMs)) finish(subId, 'uncertain', 'Claude Code adapter disconnected before confirming the push')
    }
    for (const [id, c] of conns) if (c.polling === 0 && t - c.lastSeen > staleMs * 3) conns.delete(id)
  }
  const ticker = setInterval(tick, tickMs)
  const sweeper = setInterval(() => store.sweep(), 3600_000)

  // ---- HTTP plumbing
  function readJson(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', c => { size += c.length; if (size > 1_000_000) { reject(new UserError(413, 'Request too large')); req.destroy() } else chunks.push(c) })
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { reject(new UserError(400, 'Invalid JSON')) } })
      req.on('error', reject)
    })
  }
  function readToTemp(req: http.IncomingMessage, max: number): Promise<string> {
    const file = path.join(tmpDir, crypto.randomBytes(12).toString('hex'))
    return new Promise((resolve, reject) => {
      if (Number(req.headers['content-length']) > max) return reject(new UserError(413, `Files are limited to ${max / 1048576} MiB`))
      const out = fs.createWriteStream(file, { mode: 0o600 })
      let size = 0
      const fail = (e: Error) => { out.destroy(); fs.rmSync(file, { force: true }); reject(e) }
      req.on('data', c => { size += c.length; if (size > max) { fail(new UserError(413, `Files are limited to ${max / 1048576} MiB`)); req.destroy() } })
      req.on('error', fail)
      req.pipe(out)
      out.on('finish', () => size <= max && resolve(file))
      out.on('error', fail)
    })
  }
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    if (res.headersSent) return
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  let port = 0
  const allowedHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`]

  // Adapter calls carry agent + conversation; a submission is visible only to its own conversation.
  function owned(body: any, subId: string) {
    const s = store.data.submissions[subId]
    const d = s && store.data.destinations[s.destId]
    if (!d || d.agent !== body.agent || d.conversationId !== body.conversationId) throw new UserError(404, 'No such submission for this chat')
    return { s, d }
  }
  const asAgent = (a: unknown): Agent => { if (a !== 'claude' && a !== 'codex') throw new UserError(400, 'agent must be claude or codex'); return a }
  const asConv = (c: unknown) => { if (typeof c !== 'string' || !/^[\w.:-]{4,128}$/.test(c)) throw new UserError(400, 'Invalid conversation id'); return c }
  const pageUrl = (d: Dest) => `http://localhost:${port}/?d=${d.id}#k=${keys.uiKey}`

  type Handler = (req: http.IncomingMessage, res: http.ServerResponse, p: string[], url: URL) => Promise<unknown> | unknown
  const routes: [string, RegExp, 'ui' | 'adapter' | 'none', Handler][] = [
    ['GET', /^\/$/, 'none', (_q, res) => serveStatic(res, 'index.html', 'text/html; charset=utf-8')],
    ['GET', /^\/app\.js$/, 'none', (_q, res) => serveStatic(res, 'app.js', 'text/javascript; charset=utf-8')],
    ['GET', /^\/api\/health$/, 'adapter', () => ({ ok: true, version: VERSION, pid: process.pid })],

    // ---- browser API
    ['GET', /^\/api\/destinations$/, 'ui', () => ({ version: VERSION, destinations: Object.values(store.data.destinations).sort((a, b) => b.createdAt - a.createdAt).map(destView) })],
    ['GET', /^\/api\/destinations\/([\w-]+)$/, 'ui', (_q, _r, [id]) => ({
      destination: destView(store.dest(id)), draft: store.draft(id),
      submissions: store.subsFor(id).reverse().map(subView), retentionMs: { undelivered: 7 * 864e5, delivered: 864e5 },
    })],
    ['PATCH', /^\/api\/destinations\/([\w-]+)$/, 'ui', async (q, _r, [id]) => { store.rename(id, (await readJson(q)).label); return destView(store.dest(id)) }],
    ['DELETE', /^\/api\/destinations\/([\w-]+)$/, 'ui', (_q, _r, [id]) => { store.closeDestination(id); log('close', { dest: id }); return destView(store.dest(id)) }],
    ['PUT', /^\/api\/destinations\/([\w-]+)\/draft$/, 'ui', async (q, _r, [id]) => { store.setNote(id, (await readJson(q)).note ?? ''); return store.draft(id) }],
    ['DELETE', /^\/api\/destinations\/([\w-]+)\/draft$/, 'ui', (_q, _r, [id]) => { store.clearDraft(id); return store.draft(id) }],
    ['POST', /^\/api\/destinations\/([\w-]+)\/draft\/items$/, 'ui', async (q, _r, [id], url) => {
      store.dest(id)
      if (String(q.headers['content-type']).startsWith('application/json')) {
        const b = await readJson(q)
        return store.addLink(id, b.url, b.title)
      }
      const tmp = await readToTemp(q, 25 * 1048576)
      const item = store.addFile(id, tmp, decodeURIComponent(url.searchParams.get('name') ?? 'untitled'), url.searchParams.get('source') ?? undefined)
      log('stage', { dest: id, item: item.id, kind: item.kind, size: item.size })
      return item
    }],
    ['DELETE', /^\/api\/destinations\/([\w-]+)\/draft\/items\/([\w-]+)$/, 'ui', (_q, _r, [id, item]) => { store.removeItem(id, item); return store.draft(id) }],
    ['POST', /^\/api\/destinations\/([\w-]+)\/submissions$/, 'ui', async (q, res, [id]) => {
      const b = await readJson(q)
      const { sub, created } = store.submit(id, b.id, b.note)
      if (created) log('submit', { dest: id, sub: sub.id, items: sub.items.length })
      setImmediate(tick)
      send(res, created ? 201 : 200, subView(sub))
    }],
    ['POST', /^\/api\/submissions\/([\w-]+)\/cancel$/, 'ui', (_q, _r, [id]) => subView(store.cancel(id))],
    ['POST', /^\/api\/submissions\/([\w-]+)\/retry$/, 'ui', (_q, _r, [id]) => { const s = subView(store.retry(id)); setImmediate(tick); return s }],
    ['DELETE', /^\/api\/submissions\/([\w-]+)\/files$/, 'ui', (_q, _r, [id]) => subView(store.deleteFiles(id))],
    ['GET', /^\/api\/files\/([\w-]+)$/, 'ui', (_q, res, [id], url) => {
      const item = store.findItem(id)
      const p = item && store.filePath(item)
      if (!item || !p) throw new UserError(404, 'File not available (deleted or expired)')
      const extract = url.searchParams.has('extract') && item.kind === 'pdf'
      const file = extract ? p + '.txt' : p
      if (!fs.existsSync(file)) throw new UserError(404, 'File not available')
      // Previews never execute: images as images, everything else as inert text or a download.
      const type = item.kind === 'image' ? item.mime : item.kind === 'pdf' && !extract ? 'application/octet-stream' : 'text/plain; charset=utf-8'
      res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox; default-src none', 'content-disposition': item.kind === 'image' || extract || item.kind === 'text' ? 'inline' : 'attachment', 'cache-control': 'no-store' })
      fs.createReadStream(file).pipe(res)
    }],

    // ---- adapter API (MCP servers)
    ['POST', /^\/api\/adapter\/open$/, 'adapter', async q => {
      const b = await readJson(q)
      const d = store.openDestination(asAgent(b.agent), asConv(b.conversationId), b.label, typeof b.project === 'string' ? b.project.slice(0, 300) : undefined,
        b.agent === 'codex' && typeof b.codexHome === 'string' && path.isAbsolute(b.codexHome) ? b.codexHome : undefined)
      log('open', { dest: d.id, agent: d.agent })
      setImmediate(tick)
      return { destination: destView(d), url: pageUrl(d) }
    }],
    ['POST', /^\/api\/adapter\/connect$/, 'adapter', async q => {
      const b = await readJson(q)
      const c: Conn = { id: crypto.randomUUID(), agent: asAgent(b.agent), conversationId: asConv(b.conversationId), lastSeen: Date.now(), polling: 0 }
      conns.set(c.id, c)
      log('connect', { conn: c.id, agent: c.agent })
      return { connId: c.id }
    }],
    ['GET', /^\/api\/adapter\/poll$/, 'adapter', async (_q, res, _p, url) => {
      const c = conns.get(url.searchParams.get('conn') ?? '')
      if (!c) throw new UserError(410, 'Unknown connection; reconnect')
      let gone = false
      res.on('close', () => { gone = true })
      c.polling++
      try {
        const deadline = Date.now() + pollMs
        while (!gone && Date.now() < deadline) {
          c.lastSeen = Date.now()
          for (const d of Object.values(store.data.destinations)) {
            if (d.agent !== c.agent || d.conversationId !== c.conversationId || d.closed) continue
            const s = store.nextFor(d.id)
            if (!s) continue
            store.transition(s.id, 'delivering', 'Handed to the Claude Code channel adapter')
            inflight.set(s.id, c.id)
            return { submission: s, destination: d, text: describe(s, d, store.filesDir) }
          }
          await sleep(150)
        }
        return { submission: null }
      } finally { c.polling--; c.lastSeen = Date.now() }
    }],
    ['POST', /^\/api\/adapter\/report$/, 'adapter', async q => {
      const b = await readJson(q)
      if (inflight.get(b.submissionId) !== b.connId) throw new UserError(409, 'Submission is not in flight on this connection')
      finish(b.submissionId, b.ok ? 'sent' : 'failed', b.ok ? 'Channel notification written to the Claude Code session' : String(b.detail ?? 'Adapter error'))
      return { ok: true }
    }],
    ['POST', /^\/api\/adapter\/list$/, 'adapter', async q => {
      const b = await readJson(q)
      const d = store.findDest(asAgent(b.agent), asConv(b.conversationId))
      return { destination: d ? destView(d) : null, url: d ? pageUrl(d) : null, submissions: d ? store.subsFor(d.id).reverse().slice(0, 50).map(subView) : [] }
    }],
    ['POST', /^\/api\/adapter\/read$/, 'adapter', async q => {
      const b = await readJson(q)
      const { s, d } = owned(b, b.submissionId)
      if (s.state === 'cancelled' || s.state === 'expired') throw new UserError(409, `Submission ${s.id} was ${s.state} and should not be used`)
      if (s.state !== 'retrieved') { store.transition(s.id, 'retrieved', 'Agent called read_drop'); inflight.delete(s.id) }
      log('retrieved', { sub: s.id })
      return { submission: subView(s), destination: d, filesDir: store.filesDir, text: describe(s, d, store.filesDir) }
    }],
    ['POST', /^\/api\/adapter\/ack$/, 'adapter', async q => {
      const b = await readJson(q)
      const { s } = owned(b, b.submissionId)
      if (s.state !== 'retrieved' && s.state !== 'cancelled' && s.state !== 'expired') { store.transition(s.id, 'retrieved', 'Agent acknowledged'); inflight.delete(s.id) }
      return subView(s)
    }],
    ['POST', /^\/api\/adapter\/close$/, 'adapter', async q => {
      const b = await readJson(q)
      const d = store.findDest(asAgent(b.agent), asConv(b.conversationId))
      if (!d) throw new UserError(404, 'No Context Drop destination for this chat')
      store.closeDestination(d.id)
      return destView(d)
    }],
    ['POST', /^\/api\/adapter\/shutdown$/, 'adapter', (_q, res) => {
      send(res, 200, { ok: true })
      setImmediate(() => { close(); opts.onShutdown?.() })
    }],
  ]

  function serveStatic(res: http.ServerResponse, name: string, type: string) {
    res.writeHead(200, {
      'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' blob: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    })
    res.end(fs.readFileSync(new URL(name, WEB)))
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    try {
      // DNS-rebinding and cross-site defenses; localhost alone is not authorization.
      if (!allowedHosts().includes(String(req.headers.host))) throw new UserError(403, 'Bad host')
      const origin = req.headers.origin
      if (origin && !allowedHosts().map(h => `http://${h}`).includes(origin)) throw new UserError(403, 'Bad origin')
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname))
      if (!route) throw new UserError(404, 'Not found')
      const [, re, auth, handler] = route
      if (auth !== 'none') {
        const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
        if (!safeEq(token, auth === 'ui' ? keys.uiKey : keys.adapterKey)) throw new UserError(401, 'Missing or invalid credentials')
      }
      const out = await handler(req, res, re.exec(url.pathname)!.slice(1), url)
      if (out !== undefined) send(res, 200, out)
    } catch (e) {
      const status = e instanceof UserError ? e.status : 500
      if (status === 500) log('error', { path: url.pathname, error: String((e as Error).message).slice(0, 300) })
      send(res, status, { error: e instanceof UserError ? e.message : 'Internal error' })
    }
  })
  server.requestTimeout = 0

  port = await new Promise<number>((resolve, reject) => {
    const want = opts.port ?? keys.port
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EADDRINUSE' || want === 0) return reject(e)
      server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port))
    })
    server.listen(want, '127.0.0.1', () => resolve((server.address() as any).port))
  })
  if (keys.port !== port && opts.port === undefined) { keys.port = port; saveKeys(dir, keys) }
  log('start', { port, version: VERSION, pid: process.pid })

  function close() {
    clearInterval(ticker); clearInterval(sweeper)
    server.closeAllConnections()
    server.close()
  }
  return { port, keys, store, close, tick, conns }
}

export function defaultHome() {
  return process.env.CONTEXT_DROP_HOME || path.join(os.homedir(), '.context-drop')
}

// Daemon entry: one service per user, guarded by a lock file so concurrent adapters don't race.
if (import.meta.main) {
  const dir = defaultHome()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const lock = path.join(dir, 'service.lock')
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }) } catch {
    const pid = Number(fs.readFileSync(lock, 'utf8'))
    if (pid && alive(pid)) process.exit(0)
    fs.rmSync(lock, { force: true })
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })
  }
  const release = () => { try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.rmSync(lock) } catch {} }
  process.on('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0))
  await startService({ dir, onShutdown: () => process.exit(0) })
}
