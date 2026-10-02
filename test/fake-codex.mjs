#!/usr/bin/env node
// Stand-in for `codex queue`. Behavior chosen by FAKE_CODEX_MODE; every call is appended to FAKE_CODEX_LOG.
import fs from 'node:fs'
const args = process.argv.slice(2)
if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify([...args, 'CODEX_HOME=' + (process.env.CODEX_HOME ?? '')]) + '\n')
const thread = args[args.indexOf('--thread') + 1]
const mode = process.env.FAKE_CODEX_MODE ?? 'ok'
if (args.includes('-i') || args.includes('--image')) { console.error('Error: `codex queue` does not support image attachments'); process.exit(1) }
if (mode === 'fail') { console.error('Error: thread not found: ' + thread); process.exit(1) }
if (mode === 'hang') setTimeout(() => {}, 60_000)
else console.log(`Queued message msg-${Date.now()} for thread ${thread}.`)
