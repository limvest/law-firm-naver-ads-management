import { randomUUID } from 'node:crypto'
import { copyFile, link, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'

async function linkOrCopy(source, destination) {
  try {
    await link(source, destination)
  } catch (error) {
    // Older root-owned publications cannot be hard-linked by the agent.
    if (!['EPERM', 'EACCES', 'EXDEV', 'EMLINK', 'ENOTSUP'].includes(error.code)) throw error
    await copyFile(source, destination)
  }
}

export async function cloneLandingHosts(source, destination) {
  await mkdir(destination, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  let cursor = 0
  await Promise.all(Array.from({ length: 25 }, async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++]
      if (!entry.isFile() || !/\.html(?:\.gz)?$/.test(entry.name)) {
        throw new Error(`unexpected landing entry: ${entry.name}`)
      }
      await linkOrCopy(`${source}/${entry.name}`, `${destination}/${entry.name}`)
    }
  }))
}

// Published files are immutable. Always replace a staging path atomically:
// writing through an existing hard link would also change the live version.
export async function storeLandingFile(previous, destination, body) {
  const temporary = `${destination}.${randomUUID()}.tmp`
  let unchanged = false
  try {
    if (previous) {
      try { unchanged = (await readFile(previous)).equals(body) } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    if (unchanged) await linkOrCopy(previous, temporary)
    else await writeFile(temporary, body, { mode: 0o644, flag: 'wx' })
    await rename(temporary, destination)
    return unchanged
  } finally {
    await rm(temporary, { force: true })
  }
}
