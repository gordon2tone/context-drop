import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store, classify, LIMITS, RETENTION, describe } from '../src/store.ts'
import { pdfText } from '../src/pdf.ts'
import { PNG, makePdf } from './fixtures.ts'

function tmpStore(now = () => Date.now()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-store-'))
  return { dir, store: new Store(dir, now) }
}
function tmpFile(dir: string, buf: Buffer | string) {
  const p = path.join(dir, 'up-' + Math.random())
  fs.writeFileSync(p, buf)
  return p
}

test('classify by content, not by claimed name', () => {
  assert.equal(classify(PNG, 'x.txt').kind, 'image')
  assert.equal(classify(Buffer.from('%PDF-1.4'), 'a').kind, 'pdf')
  assert.equal(classify(Buffer.from('# hi'), 'a.md').mime, 'text/markdown')
  assert.throws(() => classify(Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), 'doc.docx'), /not a supported type/)
  assert.throws(() => classify(Buffer.from([0xff, 0xfe, 0x41]), 'bad.txt'), /not a supported type/)
})

test('pdf extraction: compressed, uncompressed, and failure', () => {
  assert.equal(pdfText(makePdf('Hello \\(world\\)')), 'Hello (world)')
  assert.equal(pdfText(makePdf('Plain', false)), 'Plain')
  assert.equal(pdfText(Buffer.from('%PDF-1.4\n%%EOF')), '')
})

test('drafts are per destination and survive reload', () => {
  const { dir, store } = tmpStore()
  const a = store.openDestination('codex', 'thread-a')
  const b = store.openDestination('codex', 'thread-b', 'Fix login', '/proj')
  assert.notEqual(a.id, b.id)
  assert.equal(store.openDestination('codex', 'thread-a').id, a.id, 'same conversation reuses destination')
  assert.match(a.label, /^Codex chat thread-a/)
  store.setNote(a.id, 'note A')
  store.addFile(b.id, tmpFile(dir, PNG), '../../etc/shot.png')
  const reloaded = new Store(dir)
  assert.equal(reloaded.draft(a.id).note, 'note A')
  assert.equal(reloaded.draft(a.id).items.length, 0)
  const item = reloaded.draft(b.id).items[0]
  assert.equal(item.name, 'shot.png', 'path components stripped')
  assert.match(item.file!, /^[0-9a-f]{32}$/, 'stored under generated name')
})

test('limits reject the bad item and keep the valid ones', () => {
  const { dir, store } = tmpStore()
  const d = store.openDestination('claude', 's1')
  store.addFile(d.id, tmpFile(dir, 'ok text'), 'a.txt')
  const big = tmpFile(dir, Buffer.alloc(LIMITS.file + 1, 0x61))
  assert.throws(() => store.addFile(d.id, big, 'big.txt'), /25 MiB/)
  assert.equal(fs.existsSync(big), false, 'rejected upload deleted')
  assert.throws(() => store.addFile(d.id, tmpFile(dir, Buffer.from([0x50, 0x4b, 3, 4, 0])), 'x.zip'), /not a supported/)
  for (let i = 0; i < 9; i++) store.addLink(d.id, `https://example.com/${i}`)
  assert.throws(() => store.addLink(d.id, 'https://example.com/x'), /at most 10/)
  assert.throws(() => store.addLink(d.id, 'javascript:alert(1)'), /Only http/)
  assert.equal(store.draft(d.id).items.length, 10)
})

test('pdf extraction failure is recorded, not hidden', () => {
  const { dir, store } = tmpStore()
  const d = store.openDestination('claude', 's1')
  const ok = store.addFile(d.id, tmpFile(dir, makePdf('Readable')), 'a.pdf')
  const bad = store.addFile(d.id, tmpFile(dir, Buffer.from('%PDF-1.4\n%%EOF')), 'scan.pdf')
  assert.deepEqual(ok.extract, { ok: true, chars: 8 })
  assert.equal(bad.extract?.ok, false)
})

test('submit is idempotent and locks destination', () => {
  const { store } = tmpStore()
  const a = store.openDestination('claude', 's1')
  const b = store.openDestination('claude', 's2')
  store.addLink(a.id, 'https://example.com')
  const first = store.submit(a.id, 'sub-00000001', 'look at this')
  const again = store.submit(a.id, 'sub-00000001', 'look at this')
  assert.equal(first.created, true)
  assert.equal(again.created, false)
  assert.equal(Object.keys(store.data.submissions).length, 1)
  assert.equal(store.draft(a.id).items.length, 0, 'draft cleared after send')
  assert.throws(() => store.submit(b.id, 'sub-00000001'), /another destination/)
  assert.throws(() => store.submit(b.id, 'sub-00000002'), /Nothing to send/)
})

test('cancel, retry, ordering, and closing', () => {
  const { store } = tmpStore()
  const d = store.openDestination('codex', 't')
  store.setNote(d.id, 'one'); store.submit(d.id, 'sub-00000001')
  store.setNote(d.id, 'two'); store.submit(d.id, 'sub-00000002')
  assert.equal(store.nextFor(d.id)?.id, 'sub-00000001')
  store.transition('sub-00000001', 'delivering')
  assert.equal(store.nextFor(d.id), undefined, 'no overtaking while in flight')
  store.transition('sub-00000001', 'delivered')
  assert.throws(() => store.cancel('sub-00000001'), /cannot be recalled/)
  assert.throws(() => store.retry('sub-00000001'), /Only failed/)
  store.transition('sub-00000002', 'failed', 'boom')
  store.retry('sub-00000002')
  store.closeDestination(d.id)
  assert.equal(store.sub('sub-00000002').state, 'cancelled')
  assert.throws(() => store.addLink(d.id, 'https://x.com'), /disconnected/)
})

test('retention: undelivered expire after 7 days, delivered files after 24h', () => {
  let now = 1_000_000
  const { dir, store } = tmpStore(() => now)
  const d = store.openDestination('claude', 's')
  store.addFile(d.id, tmpFile(dir, 'x'), 'a.txt'); store.submit(d.id, 'sub-delivered')
  store.addFile(d.id, tmpFile(dir, 'y'), 'b.txt'); store.submit(d.id, 'sub-waiting')
  const draftItem = store.addFile(d.id, tmpFile(dir, 'z'), 'c.txt')
  store.transition('sub-delivered', 'sent')
  now += RETENTION.delivered + 1
  store.sweep()
  assert.equal(store.sub('sub-delivered').filesDeleted, true)
  assert.equal(store.sub('sub-waiting').state, 'queued')
  now += RETENTION.undelivered
  store.sweep()
  assert.equal(store.sub('sub-waiting').state, 'expired')
  assert.equal(fs.existsSync(store.filePath(draftItem)!), false)
  assert.equal(store.draft(d.id).items.length, 0)
})

test('describe frames material and names the retrieval tool', () => {
  const { dir, store } = tmpStore()
  const d = store.openDestination('claude', 's', 'Fix login')
  store.addFile(d.id, tmpFile(dir, PNG), 'shot.png')
  const { sub } = store.submit(d.id, 'sub-00000009', 'Button is clipped')
  const text = describe(sub, d, store.filesDir)
  assert.match(text, /Button is clipped/)
  assert.match(text, /Image shot\.png, image\/png/)
  assert.match(text, /read_drop tool \(submission_id "sub-00000009"\)/)
})
