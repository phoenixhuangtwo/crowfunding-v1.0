import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import test from 'node:test'

const projectDir = resolve(import.meta.dirname, '..')
const scriptPath = join(projectDir, 'scripts', 'local-processes.sh')

async function freePort() {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('无法分配测试端口'))
      const port = address.port
      server.close(error => error ? reject(error) : resolvePort(port))
    })
  })
}

function run(action: string, env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [scriptPath, action], {
    cwd: projectDir,
    env,
    encoding: 'utf8',
    timeout: 20_000
  })
}

test('local process manager exposes start, restart, stop, and status commands', () => {
  const result = run('help', process.env)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /start/)
  assert.match(result.stdout, /restart/)
  assert.match(result.stdout, /stop/)
  assert.match(result.stdout, /status/)
})

test('local process manager completes an isolated start, restart, status, and stop lifecycle', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'crowdfunding-process-test-'))
  const apiPort = await freePort()
  const webPort = await freePort()
  const env = {
    ...process.env,
    API_PORT: String(apiPort),
    WEB_PORT: String(webPort),
    LOCAL_RUNTIME_DIR: runtimeDir,
    LOCAL_API_ENTRY: join(projectDir, 'tests', 'fixtures', 'local-api-stub.mjs')
  }

  try {
    const started = run('start', env)
    assert.equal(started.status, 0, started.stderr || started.stdout)
    assert.match(started.stdout, /前端.*运行中/)
    assert.match(started.stdout, /API.*运行中/)

    const firstStatus = run('status', env)
    assert.equal(firstStatus.status, 0, firstStatus.stderr || firstStatus.stdout)
    assert.match(firstStatus.stdout, new RegExp(`127\\.0\\.0\\.1:${webPort}`))
    assert.match(firstStatus.stdout, new RegExp(`127\\.0\\.0\\.1:${apiPort}`))

    const restarted = run('restart', env)
    assert.equal(restarted.status, 0, restarted.stderr || restarted.stdout)

    const stopped = run('stop', env)
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout)

    const finalStatus = run('status', env)
    assert.notEqual(finalStatus.status, 0)
    assert.match(finalStatus.stdout, /前端.*未运行/)
    assert.match(finalStatus.stdout, /API.*未运行/)
  } finally {
    run('stop', env)
    rmSync(runtimeDir, { recursive: true, force: true })
  }
})
