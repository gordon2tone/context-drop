import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (p: string) => JSON.parse(fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8'))

test('one version and one shared implementation across both host manifests', () => {
  const v = read('package.json').version
  const claude = read('.claude-plugin/plugin.json')
  const codex = read('.codex-plugin/plugin.json')
  assert.equal(claude.version, v)
  assert.equal(codex.version, v)
  assert.equal(claude.name, codex.name)
  const claudeArgs = claude.mcpServers['context-drop'].args
  const codexArgs = read(codex.mcpServers).mcpServers['context-drop'].args
  assert.equal(claudeArgs[0].replace('${CLAUDE_PLUGIN_ROOT}/', ''), codexArgs[0], 'same server entry point')
  // Codex does not expand ${PLUGIN_ROOT} in args; a relative path with cwd "." resolves against the plugin root.
  assert.equal(read(codex.mcpServers).mcpServers['context-drop'].cwd, '.')
  assert.deepEqual([claudeArgs.at(-1), codexArgs.at(-1)], ['claude', 'codex'])
  assert.ok(fs.existsSync(new URL('../skills/context-drop/SKILL.md', import.meta.url)))
})
