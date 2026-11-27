import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { cloneLandingHosts, storeLandingFile } from '../scripts/engine/static-landing-storage.mjs'

test('unchanged pages share storage; changing a staged page preserves the published bytes', async () => {
  const root = await mkdtemp(`${tmpdir()}/lawfirm-storage-`)
  await mkdir(`${root}/published`)
  await writeFile(`${root}/published/case.html`, 'published')
  await cloneLandingHosts(`${root}/published`, `${root}/staged`)
  const old = await stat(`${root}/published/case.html`)
  assert.equal((await stat(`${root}/staged/case.html`)).ino, old.ino)
  assert.equal(await storeLandingFile(`${root}/published/case.html`, `${root}/staged/case.html`, Buffer.from('changed')), false)
  assert.equal(await readFile(`${root}/published/case.html`, 'utf8'), 'published')
  assert.equal(await readFile(`${root}/staged/case.html`, 'utf8'), 'changed')
  assert.notEqual((await stat(`${root}/staged/case.html`)).ino, old.ino)
  assert.equal(await storeLandingFile(`${root}/published/case.html`, `${root}/staged/case.html`, Buffer.from('published')), true)
  assert.equal((await stat(`${root}/staged/case.html`)).ino, old.ino)
})

test('first publication works without a previous file', async () => {
  const root = await mkdtemp(`${tmpdir()}/lawfirm-storage-`)
  await storeLandingFile(`${root}/missing.html`, `${root}/new.html`, Buffer.from('first'))
  assert.equal(await readFile(`${root}/new.html`, 'utf8'), 'first')
})
