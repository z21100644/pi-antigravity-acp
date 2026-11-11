import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { ensureBridgeToken, HTTP_BASE_URL } from '../http-bridge.js'

export async function registerPlugin({ piDesktopDir, pluginDir, userDir = join(homedir(), '.pi-desktop') }) {
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8'))
  const hostExe = join(piDesktopDir, 'resources/bin/pi-desktop-host-core.exe')
  if (!existsSync(hostExe)) throw new Error(`PI Desktop host not found: ${hostExe}`)
  mkdirSync(userDir, { recursive: true })
  const child = spawn(hostExe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: userDir } })
  const closed = new Promise(resolveClosed => child.once('close', resolveClosed)), pending = new Map()
  let nextId = 0, stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
  child.once('error', error => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error) }
    pending.clear()
  })
  createInterface({ input: child.stdout }).on('line', line => {
    let response
    try { response = JSON.parse(line) } catch { return }
    const task = pending.get(response.id)
    if (!task) return
    pending.delete(response.id)
    clearTimeout(task.timer)
    response.error ? task.reject(new Error(response.error.message)) : task.resolve(response.result)
  })
  function rpc(method, params = {}) {
    return new Promise((resolveResult, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)) }, 10_000)
      pending.set(id, { resolve: resolveResult, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  try {
    await rpc('app.handshake', { protocolVersion: 11 })
    const loaded = await rpc('plugins.loadDev', { path: resolve(pluginDir) })
    const token = ensureBridgeToken(userDir), id = `plugin:${manifest.id}:antigravity`
    await rpc('providers.setSecret', { id, secretValue: token })
    const result = await rpc('providers.list', { includeDisabled: false })
    const provider = result.providers.find(row => row.id === id)
    assert.ok(provider, 'Host did not register the Antigravity provider')
    assert.equal(provider.baseUrl, HTTP_BASE_URL)
    assert.equal(provider.authKind, 'api_key')
    assert.equal(provider.hasSecret, true)
    assert.equal(provider.models.length, manifest.contributes.providers[0].models.length)
    const secret = await rpc('providers.getSecret', { id })
    assert.equal(secret.value, token, 'Local bridge token did not persist')
    return { version: loaded.plugin.version, providerId: id, baseUrl: provider.baseUrl,
      localTokenConfigured: true, models: provider.models.map(model => model.id) }
  } finally {
    for (const task of pending.values()) clearTimeout(task.timer)
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 1500)
    await closed
    clearTimeout(timer)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { 'pi-desktop': { type: 'string' }, 'plugin-dir': { type: 'string' } } })
    if (!values['pi-desktop'] || !values['plugin-dir']) throw new Error('--pi-desktop and --plugin-dir are required')
    const result = await registerPlugin({ piDesktopDir: resolve(values['pi-desktop']), pluginDir: resolve(values['plugin-dir']) })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } catch (error) { console.error(`ACP registration failed: ${error.message}`); process.exitCode = 1 }
}
