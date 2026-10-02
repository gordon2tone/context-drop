// Context Drop page. Plain DOM, no framework; all user data is inserted as text, never as HTML.
const $ = id => document.getElementById(id)
const AGENT = { claude: 'Claude Code', codex: 'Codex' }
const SYMBOL = { queued: '… Queued', delivering: '↻ Delivering', sent: '→ Pushed (unconfirmed)', delivered: '✓ Delivered', retrieved: '✓✓ Retrieved', uncertain: '⚠ Uncertain', failed: '✕ Failed', cancelled: '⊘ Cancelled', expired: '⊘ Expired' }
const CLS = { delivered: 'ok', retrieved: 'ok', uncertain: 'warn', failed: 'bad' }
const MAX_FILE = 25 * 1048576

let key = new URLSearchParams(location.hash.slice(1)).get('k')
try { if (key) localStorage.setItem('cd-key', key); else key = localStorage.getItem('cd-key') } catch {}
if (location.hash) history.replaceState(null, '', location.pathname + location.search)
let cur = new URLSearchParams(location.search).get('d')
let detail = null
let uploads = 0
let noteTimer = null
const previews = new Map() // item id -> element, so polling does not refetch previews
const confirmRetry = new Set()
// Polling must not rebuild unchanged lists: that would steal keyboard focus and close open <details>.
const sigs = {}
function update(el, data, build) {
  const sig = JSON.stringify(data)
  if (sigs[el.id] === sig) return
  sigs[el.id] = sig
  el.replaceChildren(...build())
}

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v)
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k))
  return el
}
const size = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`
const when = t => new Date(t).toLocaleString()
const say = (text, cls = '') => { const m = $('msg'); m.className = cls; m.textContent = text }

async function api(method, path, body, raw) {
  const headers = { authorization: 'Bearer ' + key }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (raw) headers['content-type'] = raw.type || 'application/octet-stream'
  const r = await fetch(path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status })
  return j
}

function fatal(text) { $('fatal').textContent = text; $('fatal').hidden = false; $('view').hidden = true }

// ---- sidebar
async function loadDests() {
  const { destinations } = await api('GET', '/api/destinations')
  // Duplicate labels get a short chat id so the user can tell them apart (routing never uses labels).
  const dup = new Set(destinations.map(d => d.label).filter((l, i, a) => a.indexOf(l) !== i))
  update($('dests'), [destinations, cur], () => destinations.length ? destinations.map(d => h('li', {},
    h('button', { type: 'button', 'aria-current': d.id === cur ? 'page' : false, onclick: () => switchTo(d.id) },
      h('span', { class: 'l' }, d.label),
      h('span', { class: 's' }, `${AGENT[d.agent]}${d.project ? ' · ' + d.project.split(/[\\/]/).pop() : ''}${dup.has(d.label) ? ' · chat ' + d.conversationId.slice(0, 8) : ''}`),
      h('span', { class: 's' }, connText(d), d.pending ? ` · ${d.pending} pending` : '', d.draftItems ? ` · ${d.draftItems} staged` : ''))))
    : [h('li', { class: 'hint' }, 'No chats connected yet.')])
}
const connText = d => d.connection === 'connected' ? '● Connected' : d.connection === 'available' ? '● Ready' : d.closed ? '○ Disconnected' : '○ Session offline'

async function switchTo(id) {
  if (id === cur) return
  await flushNote()
  cur = id
  history.pushState(null, '', '?d=' + encodeURIComponent(id))
  previews.clear()
  $('note').dataset.dest = ''
  say('')
  await refresh()
  $('main').focus()
}
addEventListener('popstate', () => { cur = new URLSearchParams(location.search).get('d'); refresh() })

// ---- main view
async function refresh() {
  if (!key) return fatal('This page needs its access key. Open it from the link your agent gave you when you started Context Drop in that chat.')
  try { await loadDests() } catch (e) { return fatal(e.status === 401 ? 'The access key is invalid. Ask the agent to open Context Drop again for a fresh link.' : 'The Context Drop service is not reachable. It starts again when an agent opens Context Drop.') }
  if (!cur) { $('view').hidden = true; $('fatal').hidden = false; $('fatal').textContent = 'Pick a chat on the left.'; return }
  try { detail = await api('GET', `/api/destinations/${encodeURIComponent(cur)}`) } catch (e) {
    // A stale tab never silently switches to another chat.
    return fatal(e.status === 404 ? 'This chat is no longer known to Context Drop. Open Context Drop again from the chat you want.' : e.message)
  }
  $('fatal').hidden = true
  $('view').hidden = false
  render()
}

function render() {
  const { destination: d, draft, submissions } = detail
  document.title = `Context Drop · ${d.label}`
  $('agent').textContent = AGENT[d.agent]
  $('label').textContent = d.label
  $('drop-label').textContent = d.label
  $('project').textContent = `${d.project ? `Project: ${d.project}` : 'Project: not reported'} · chat ${d.conversationId.slice(0, 8)}`
  $('conn').textContent = connText(d)
  const cb = $('connbanner')
  cb.hidden = d.connection !== 'disconnected'
  cb.className = 'banner' + (d.closed ? ' bad' : '')
  cb.textContent = d.closed
    ? 'This chat is disconnected. Nothing new can be sent here. Ask the agent in that chat to open Context Drop again to reconnect it.'
    : 'The Claude Code session for this chat is not connected right now. Anything you send stays queued for this chat and is delivered when the session reconnects.'

  const note = $('note')
  if (note.dataset.dest !== d.id || (document.activeElement !== note && !noteTimer)) { note.value = draft.note; note.dataset.dest = d.id }

  const items = draft.items
  $('count').textContent = `(${items.length}/10, ${size(items.reduce((n, i) => n + i.size, 0))})`
  update($('items'), [items, uploads, [...previews.values()].filter(p => p._text).length], () => [...items.map(itemRow), ...(uploads ? [h('li', {}, h('div', { class: 'thumb' }, '↑'), h('div', { class: 'sub' }, `Uploading ${uploads} item(s)…`), h('span'))] : [])])
  const pendingId = sessionStorage.getItem('cd-send-' + d.id)
  if (pendingId && submissions.some(s => s.id === pendingId)) sessionStorage.removeItem('cd-send-' + d.id)

  const send = $('send')
  send.textContent = `Send to ${d.label}`
  send.disabled = d.closed || uploads > 0 || (!items.length && !note.value.trim())
  for (const id of ['pick', 'link', 'addtext', 'clear', 'disconnect']) $(id).disabled = d.closed
  update($('history'), [submissions, [...confirmRetry]], () => submissions.length ? submissions.map(subRow) : [h('li', { class: 'sub' }, 'Nothing sent yet.')])
}

function itemRow(i) {
  let thumb = previews.get(i.id)
  if (!thumb) {
    thumb = h('div', { class: 'thumb' }, i.kind === 'link' ? '🔗 Link' : i.kind === 'pdf' ? 'PDF' : i.kind === 'text' ? 'Text' : 'Image')
    previews.set(i.id, thumb)
    if (i.kind === 'image' || i.kind === 'text' || (i.kind === 'pdf' && i.extract?.ok)) loadPreview(i, thumb)
  }
  const info = h('div', {},
    h('div', { class: 'name' }, i.kind === 'link' ? i.url : i.name),
    h('div', { class: 'sub' }, `${i.kind === 'link' ? 'Link (not fetched; the agent decides whether it can open it)' : i.mime} · ${size(i.size)}`),
    i.source ? h('div', { class: 'sub' }, `Source: ${i.source}`) : null,
    i.kind === 'pdf' ? h('div', { class: i.extract?.ok ? 'sub ok' : 'sub warn' }, i.extract?.ok ? `✓ Text extracted (${i.extract.chars} characters)` : `⚠ ${i.extract?.error}`) : null,
    thumb._text || null)
  return h('li', {}, thumb, info, h('button', { class: 'b', type: 'button', 'aria-label': `Remove ${i.kind === 'link' ? i.url : i.name}`, onclick: () => removeItem(i.id) }, 'Remove'))
}

async function loadPreview(i, thumb) {
  try {
    const r = await fetch(`/api/files/${i.id}${i.kind === 'pdf' ? '?extract' : ''}`, { headers: { authorization: 'Bearer ' + key } })
    if (!r.ok) return
    if (i.kind === 'image') {
      thumb.replaceChildren(h('img', { src: URL.createObjectURL(await r.blob()), alt: `Preview of ${i.name}` }))
    } else {
      const t = await r.text()
      thumb._text = h('pre', { class: 'preview' }, t.slice(0, 600) + (t.length > 600 ? '…' : ''))
      if (detail) render()
    }
  } catch {}
}

function subRow(s) {
  const actions = []
  if (['queued', 'failed', 'uncertain'].includes(s.state)) actions.push(h('button', { class: 'b', type: 'button', onclick: () => act(`/api/submissions/${s.id}/cancel`, 'POST', 'Cancelled.') }, 'Cancel'))
  if (s.state === 'failed') actions.push(h('button', { class: 'b', type: 'button', onclick: () => act(`/api/submissions/${s.id}/retry`, 'POST', 'Queued again.') }, 'Retry'))
  if (s.state === 'uncertain') actions.push(h('button', { class: 'b', type: 'button', onclick: () => {
    if (!confirmRetry.has(s.id)) { confirmRetry.add(s.id); render(); return }
    confirmRetry.delete(s.id); act(`/api/submissions/${s.id}/retry`, 'POST', 'Queued again.')
  } }, confirmRetry.has(s.id) ? 'Confirm: send again (may duplicate)' : 'Retry…'))
  if (!s.filesDeleted && s.state !== 'delivering' && s.items.some(i => i.kind !== 'link')) actions.push(h('button', { class: 'b', type: 'button', onclick: () => act(`/api/submissions/${s.id}/files`, 'DELETE', 'Local copies deleted.') }, 'Delete local copies'))
  const accepted = ['sent', 'delivered', 'retrieved'].includes(s.state)
  const life = s.filesDeleted ? 'Local attachments deleted.' : ['cancelled', 'expired'].includes(s.state) ? `Local copies deleted ${when(s.expiresAt)}.`
    : accepted ? `Local attachments deleted ${when(s.expiresAt)}; after that the agent can no longer retrieve them.` : `Expires undelivered ${when(s.expiresAt)}.`
  return h('li', {},
    h('div', {}, h('span', { class: 'state ' + (CLS[s.state] || '') }, SYMBOL[s.state]), ' · ', h('span', { class: 'sub' }, when(s.createdAt))),
    h('div', { class: 'sub' }, s.stateText),
    s.note ? h('div', {}, s.note.length > 200 ? s.note.slice(0, 200) + '…' : s.note) : null,
    h('div', { class: 'sub' }, s.items.length ? s.items.map(i => i.kind === 'link' ? i.url : i.name).join(', ') : 'No attachments'),
    h('div', { class: 'sub' }, life),
    h('details', { class: 'log' }, h('summary', {}, 'History'), h('ul', {}, s.history.map(e => h('li', {}, `${when(e.at)}: ${e.state}${e.detail ? ' (' + e.detail + ')' : ''}`)))),
    actions.length ? h('div', { class: 'actions' }, actions) : null)
}

async function act(path, method, ok) {
  try { await api(method, path); say(ok, 'ok') } catch (e) { say(e.message, 'bad') }
  await refresh()
}

// ---- staging
async function stageFiles(files, source) {
  const dest = cur
  for (const f of files) {
    if (f.size > MAX_FILE) { say(`"${f.name}" is ${size(f.size)}; files are limited to 25 MiB. Other items were kept.`, 'bad'); continue }
    uploads++; render()
    try {
      const q = `?name=${encodeURIComponent(f.name || 'pasted')}${source ? '&source=' + encodeURIComponent(source) : ''}`
      await api('POST', `/api/destinations/${encodeURIComponent(dest)}/draft/items${q}`, undefined, f)
      say(`Staged ${f.name || 'item'}.`)
    } catch (e) { say(`${e.message} Other staged items were kept.`, 'bad') }
    finally { uploads--; if (dest === cur) await refresh() }
  }
}
async function stageLink(url) {
  try { await api('POST', `/api/destinations/${encodeURIComponent(cur)}/draft/items`, { url }); say('Link staged.') } catch (e) { say(e.message, 'bad') }
  await refresh()
}
const stageText = (text, name = 'pasted-text.txt') => stageFiles([new File([text], name, { type: 'text/plain' })])
async function removeItem(id) {
  try { await api('DELETE', `/api/destinations/${encodeURIComponent(cur)}/draft/items/${id}`); previews.delete(id) } catch (e) { say(e.message, 'bad') }
  await refresh()
}

$('pick').onclick = () => $('file').click()
$('file').onchange = e => { stageFiles([...e.target.files]); e.target.value = '' }
$('linkform').onsubmit = e => { e.preventDefault(); const v = $('link').value.trim(); if (v) { stageLink(v); $('link').value = '' } }
$('addtext').onclick = () => { const v = $('textin').value; if (v.trim()) { stageText(v); $('textin').value = '' } }

const isUrl = t => /^https?:\/\/\S+$/i.test(t.trim())
document.addEventListener('paste', e => {
  if (!detail || detail.destination.closed) return
  const files = [...(e.clipboardData?.files ?? [])]
  if (files.length) { e.preventDefault(); return stageFiles(files) }
  if (e.target.closest?.('input, textarea')) return // normal typing paste
  const text = e.clipboardData?.getData('text/plain') ?? ''
  if (!text.trim()) return
  e.preventDefault()
  isUrl(text) ? stageLink(text.trim()) : stageText(text)
})
const drop = $('drop')
document.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over') })
document.addEventListener('dragleave', e => { if (!e.relatedTarget) drop.classList.remove('over') })
document.addEventListener('drop', e => {
  e.preventDefault(); drop.classList.remove('over')
  if (!detail || detail.destination.closed) return
  const dt = e.dataTransfer
  if (dt.files.length) return stageFiles([...dt.files])
  const uri = dt.getData('text/uri-list').split('\n').find(l => l && !l.startsWith('#'))
  const text = dt.getData('text/plain')
  if (text && text.trim() !== uri?.trim() && !isUrl(text)) stageText(text, 'dropped-text.txt')
  else if (uri || isUrl(text)) stageLink((uri || text).trim())
})

// ---- note, send, controls
async function flushNote() {
  if (!noteTimer) return
  clearTimeout(noteTimer); noteTimer = null
  const n = $('note')
  if (n.dataset.dest) await api('PUT', `/api/destinations/${encodeURIComponent(n.dataset.dest)}/draft`, { note: n.value }).catch(e => say(e.message, 'bad'))
}
$('note').oninput = () => {
  clearTimeout(noteTimer)
  noteTimer = setTimeout(flushNote, 400)
  $('send').disabled = detail.destination.closed || uploads > 0 || (!detail.draft.items.length && !$('note').value.trim())
}

$('send').onclick = async () => {
  const dest = detail.destination
  // One logical submission per user action: the id survives retries, refreshes, and double clicks.
  const k = 'cd-send-' + dest.id
  let id = sessionStorage.getItem(k)
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(k, id) }
  $('send').disabled = true
  clearTimeout(noteTimer); noteTimer = null
  try {
    const s = await api('POST', `/api/destinations/${encodeURIComponent(dest.id)}/submissions`, { id, note: $('note').value })
    sessionStorage.removeItem(k)
    $('note').value = ''
    say(`Sent to ${dest.label}: ${SYMBOL[s.state]}. Status updates below.`, 'ok')
  } catch (e) {
    if (e.status === undefined || e.status >= 500) say('Could not confirm the send. Press Send again; it will not create a duplicate.', 'warn')
    else { sessionStorage.removeItem(k); say(e.message, 'bad') }
  }
  await refresh()
}
$('clear').onclick = async () => {
  try { await api('DELETE', `/api/destinations/${encodeURIComponent(cur)}/draft`); $('note').value = ''; previews.clear(); say('Draft cleared.') } catch (e) { say(e.message, 'bad') }
  await refresh()
}
$('disconnect').onclick = () => act(`/api/destinations/${encodeURIComponent(cur)}`, 'DELETE', 'Disconnected. Queued items were cancelled.')
$('rename').onclick = () => { $('renameform').hidden = false; $('renamein').value = detail.destination.label; $('renamein').focus() }
$('renamecancel').onclick = () => { $('renameform').hidden = true; $('rename').focus() }
$('renameform').onsubmit = async e => {
  e.preventDefault()
  try { await api('PATCH', `/api/destinations/${encodeURIComponent(cur)}`, { label: $('renamein').value }); $('renameform').hidden = true; say('Renamed. Routing is unchanged.') } catch (err) { say(err.message, 'bad') }
  await refresh()
}

refresh()
setInterval(() => { if (!document.hidden) refresh() }, 1500)
