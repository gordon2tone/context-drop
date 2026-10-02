import { deflateSync } from 'node:zlib'

export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc00000030101009c8d2c5d0000000049454e44ae426082', 'hex')
export function makePdf(text: string, compress = true) {
  const content = Buffer.from(`BT /F1 12 Tf 72 712 Td (${text}) Tj ET`)
  const body = compress ? deflateSync(content) : content
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n4 0 obj << /Length ${body.length}${compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`),
    body, Buffer.from('\nendstream\nendobj\n%%EOF\n'),
  ])
}
