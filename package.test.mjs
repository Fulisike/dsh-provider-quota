/** Verify the committed release entry without access to the package's node_modules. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = dirname(fileURLToPath(import.meta.url))

test('release entry runs all quota behavior tests without installed dependencies', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-quota-package-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.dependencies ?? {}, {})
  assert.deepEqual(pkg.optionalDependencies ?? {}, {})
  assert.deepEqual(pkg.peerDependencies ?? {}, {})
  for (const file of ['package.json', ...pkg.files]) await cp(join(root, file), join(home, file), { recursive: true })
  const entry = pathToFileURL(resolve(home, pkg.exports['.'])).href
  const env = { ...process.env, DSH_QUOTA_TEST_ENTRY: entry }
  // A nested --test process must start its own runner rather than inherit the parent's IPC mode.
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(root, 'test.mjs')], {
    cwd: home, windowsHide: true, encoding: 'utf8', timeout: 60_000,
    env,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# tests [1-9]\d*/)
  assert.match(result.stdout, /# fail 0/)
})
