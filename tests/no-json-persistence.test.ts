import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('API runtime no longer reads or writes dev-state JSON', async () => {
  const source = await readFile(new URL('../server/server.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /dev-state\.json|loadState\(|saveState\(|readFileSync|writeFileSync/)
})
