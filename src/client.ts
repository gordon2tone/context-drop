import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defaultHome, VERSION, type Keys } from './service.ts'

export type Svc = { base: string; keys: Keys }

const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map(v => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

async function health(home: string): Promise<(Svc & { version: string }) | undefined> {
  try {
    const keys: Keys = JSON.parse(fs.readFileSync(path.join(home, 'keys.json'), 'utf8'))
    const base = `http://127.0.0.1:${keys.port}`
    const r = await fetch(base + '/api/health', { headers: { authorization: `Bearer ${keys.adapterKey}` }, signal: AbortSignal.timeout(1500) })
    if (r.ok) return { base, keys, version: (await r.json()).version }
  } catch {}
}

// Find the shared per-user service, starting (or upgrading) it when needed.
export async function ensureService(home = defaultHome()): Promise<Svc> {
  let s = await health(home)
  if (s && newer(VERSION, s.version)) {
    await api(s, '/api/adapter/shutdown', {}).catch(() => {})
    for (let i = 0; i < 30 && (await health(home)); i++) await new Promise(r => setTimeout(r, 100))
    s = undefined
  }
  if (s) return s
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const err = fs.openSync(path.join(home, 'service.err.log'), 'a')
  spawn(process.execPath, [fileURLToPath(new URL('./service.ts', import.meta.url))], {
    detached: true, stdio: ['ignore', 'ignore', err], env: { ...process.env, CONTEXT_DROP_HOME: home }, windowsHide: true,
  }).unref()
  fs.closeSync(err)
  for (let i = 0; i < 100; i++) {
    if ((s = await health(home))) return s
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`Context Drop service did not start; see ${path.join(home, 'service.err.log')}`)
}

export async function api(svc: Svc, p: string, body: unknown) {
  const r = await fetch(svc.base + p, {
    method: 'POST', headers: { authorization: `Bearer ${svc.keys.adapterKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j
}

export function openBrowser(url: string) {
  if (process.env.CONTEXT_DROP_NO_BROWSER) return false
  let wsl = false
  try { wsl = process.platform === 'linux' && /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')) } catch {}
  const [cmd, args] = process.platform === 'win32' || wsl ? [wsl ? 'rundll32.exe' : 'rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  try {
    const p = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true })
    p.on('error', () => {})
    p.unref()
    return true
  } catch { return false }
}
