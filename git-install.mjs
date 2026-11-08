/** Install a local Git release through DSH/pnpm, boot Web, then test the installed entry against a fake API. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = dirname(fileURLToPath(import.meta.url))
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT ?? process.cwd())
const temporary = await mkdtemp(join(tmpdir(), 'dsh-quota-git-'))
const home = join(temporary, 'home')
const source = join(temporary, 'release')
const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents') }
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

async function run(args, environment = env) {
  const child = spawn(process.execPath, args, { cwd: dshRoot, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 120_000)
  let code
  try { [code] = await once(child, 'close') }
  finally { clearTimeout(timer) }
  assert.equal(timedOut, false, 'DSH fixture exceeded its deadline')
  assert.equal(code, 0, stdout + stderr)
  return { stdout, stderr }
}
const cli = args => run(['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...args])
function git(...args) {
  const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
try {
  for (const file of ['package.json', ...pkg.files]) await cp(join(root, file), join(source, file), { recursive: true })
  git('init', '--quiet')
  git('add', '.')
  git('-c', 'user.name=Package test', '-c', 'user.email=package-test@example.invalid', 'commit', '--quiet', '-m', 'Release fixture')
  const spec = 'git+' + pathToFileURL(source).href + '#' + git('rev-parse', 'HEAD')
  const installed = await cli(['plugin', '--profile', 'web', 'add', spec])
  assert.match(installed.stdout + installed.stderr, /dsh-provider-quota/)
  const path = join(home, 'profiles/web/node_modules/dsh-provider-quota')
  const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.exports['.'], './dist/index.js')
  console.log('GIT_INSTALL_OK ' + pkg.version)

  const probe = join(temporary, 'probe.mjs')
  await writeFile(probe, `import assert from 'node:assert/strict'
export const inject = ['pluginManager', 'settings', 'appReady', 'appExit']
export function apply(ctx) {
  ctx.effect(() => {
    let task = Promise.resolve()
    const off = ctx.appReady.onReady(() => { task = Promise.resolve().then(async () => {
      const rows = await ctx.pluginManager.listPlugins()
      assert.ok(rows.some(row => row.moduleName === 'dsh-provider-quota' && row.fiberPhase === 'active'))
      const descriptor = ctx.settings.describe().find(row => row.ns === 'provider-quota')
      assert.ok(descriptor)
      assert.deepEqual(descriptor.value.providers, {})
      await ctx.settings.mutate('provider-quota', [{ op: 'set', path: ['providers', 'quota-test'], value: { maxOutputTokens: 8192 } }], descriptor.revision)
      const saved = ctx.settings.describe().find(row => row.ns === 'provider-quota')
      assert.equal(saved.value.providers['quota-test'].maxOutputTokens, 8192)
      assert.equal(saved.value.providers['quota-test'].requestsPerMinute, 10)
      console.log('GIT_WEB_READY native-settings-save=ok')
      ctx.appExit(0)
    }).catch(error => { console.error(error); ctx.appExit(1) }) })
    return async () => { off(); await task }
  })
}
`)
  const patch = join(temporary, 'probe.patch.json')
  await writeFile(patch, JSON.stringify([{ insert: [{ id: 'quota-git-probe', name: pathToFileURL(probe).href }] }]))
  const boot = await cli(['web', '--patch', patch, '--no-open', '--port', '0'])
  assert.ok(!/failed to import|did not activate/.test(boot.stderr), boot.stderr)
  assert.match(boot.stdout, /GIT_WEB_READY native-settings-save=ok/)
  console.log('GIT_WEB_READY native-settings-save=ok')
  const integration = await run(['--import', 'tsx/esm', join(root, 'integration.mjs')], {
    ...env, DSH_SOURCE_ROOT: dshRoot, DSH_QUOTA_PLUGIN_ENTRY: pathToFileURL(resolve(path, manifest.exports['.'])).href,
  })
  console.log('GIT_INSTALLED_API_OK ' + integration.stdout.trim())
} finally {
  const rel = relative(resolve(tmpdir()), temporary)
  assert.ok(rel !== '' && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel))
  await rm(temporary, { recursive: true, force: true })
}
