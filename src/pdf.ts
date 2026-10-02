import { inflateSync } from 'node:zlib'

// Best-effort text extraction for simple text-based PDFs: inflates content streams and
// reads string operands of Tj/TJ/'/" inside BT..ET blocks.
// ponytail: no font CMaps (CID/Type0 fonts, custom encodings fail and are reported as failures),
// swap in a real PDF parser if pilot users hit that often.
export function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1')
  const blocks: string[] = []
  const streamRe = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = streamRe.exec(raw))) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    const dict = raw.slice(Math.max(0, m.index - 300), m.index)
    let data = buf.subarray(start, end)
    if (/\/FlateDecode/.test(dict.slice(dict.lastIndexOf('<<')))) {
      try { data = inflateSync(data) } catch { try { data = inflateSync(trimEol(data)) } catch { continue } }
    }
    for (const bt of data.toString('latin1').match(/BT[\s\S]*?ET/g) ?? []) blocks.push(textOps(bt))
    streamRe.lastIndex = end
  }
  return blocks.join('\n').replace(/[ \t]+\n/g, '\n').trim()
}

function trimEol(b: Buffer) {
  let n = b.length
  while (n && (b[n - 1] === 10 || b[n - 1] === 13)) n--
  return b.subarray(0, n)
}

function textOps(bt: string): string {
  let out = ''
  const re = /\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")|(T\*|Td|TD)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(bt))) {
    if (m[1] !== undefined) {
      for (const s of m[1].match(/\((?:\\.|[^\\)])*\)/g) ?? []) out += unescape(s.slice(1, -1))
    } else if (m[2] !== undefined) out += unescape(m[2])
    else if (out && !out.endsWith('\n')) out += m[3] === 'T*' ? '\n' : ' '
  }
  return out
}

function unescape(s: string) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c: string) =>
    /\d/.test(c) ? String.fromCharCode(parseInt(c, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[c] ?? c)
}
