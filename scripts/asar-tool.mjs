#!/usr/bin/env node
/**
 * Minimal Electron `app.asar` reader.
 *
 * The packaged target ships its packages inside an asar archive, and plain Node
 * cannot read one. This reads the archive's JSON header (whose file offsets are
 * absolute within the archive) and extracts only the paths asked for, so a
 * plugin can be built against the exact package versions the running app loads
 * instead of against a checkout that may be older.
 *
 * Usage:
 *   node asar-tool.mjs list <archive> [substring]
 *   node asar-tool.mjs extract <archive> <destDir> <pathPrefix>...
 */

import { createRequire } from 'node:module'
import { mkdirSync, openSync, readSync, writeFileSync, closeSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const HEADER_PREAMBLE_BYTES = 8

/**
 * Read an archive's header and the absolute offset of its data section.
 * @param {string} archive - path to the .asar file.
 * @returns {{ files: Record<string, unknown>, dataOffset: number, fd: number }}
 */
function readArchive(archive) {
  const fd = openSync(archive, 'r')
  const preamble = Buffer.alloc(HEADER_PREAMBLE_BYTES)
  readSync(fd, preamble, 0, HEADER_PREAMBLE_BYTES, 0)
  // Two little-endian UInt32s: the pickle's payload size, then the header size.
  const headerSize = preamble.readUInt32LE(4)
  const headerPickle = Buffer.alloc(headerSize)
  readSync(fd, headerPickle, 0, headerSize, HEADER_PREAMBLE_BYTES)
  // The pickle is [UInt32 string length][UTF-8 JSON]; the JSON starts at 4.
  const text = headerPickle.subarray(4).toString('utf8')
  const start = text.indexOf('{')
  if (start < 0) throw new Error('asar: header contained no JSON object')
  const end = text.lastIndexOf('}')
  const header = JSON.parse(text.slice(start, end + 1))
  return { files: header.files ?? {}, dataOffset: HEADER_PREAMBLE_BYTES + headerSize, fd }
}

/**
 * Walk the header tree, yielding every file entry with its archive offset.
 * @param {Record<string, unknown>} files - one header directory node.
 * @param {string} prefix - path accumulated so far.
 * @param {Array<{ path: string, offset: number, size: number, unpacked: boolean }>} out - collected entries.
 * @param {number} dataOffset - absolute offset of the archive's data section.
 */
function walk(files, prefix, out, dataOffset) {
  for (const [name, node] of Object.entries(files)) {
    if (node === null || typeof node !== 'object') continue
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (node.files !== undefined) {
      walk(node.files, path, out, dataOffset)
      continue
    }
    if (typeof node.offset !== 'string' && typeof node.offset !== 'number') continue
    out.push({
      path,
      // Header offsets are relative to the data section that follows the
      // header. Adding dataOffset is not optional: in a large archive the raw
      // offsets exceed the header size, so a "looks absolute" heuristic reads
      // arbitrary bytes out of some other file and silently returns garbage.
      offset: dataOffset + Number(node.offset),
      size: Number(node.size ?? 0),
      unpacked: node.unpacked === true,
    })
  }
}

const [command, archive, ...rest] = process.argv.slice(2)
if (command === undefined || archive === undefined) {
  process.stderr.write('usage: asar-tool.mjs list <archive> [substring] | extract <archive> <dest> <prefix>...\n')
  process.exit(2)
}

const { files, dataOffset, fd } = readArchive(archive)
const entries = []
walk(files, '', entries, dataOffset)

if (command === 'list') {
  const filter = rest[0]
  for (const entry of entries) {
    if (filter !== undefined && !entry.path.includes(filter)) continue
    process.stdout.write(`${String(entry.size).padStart(10)}  ${entry.path}\n`)
  }
  closeSync(fd)
  process.exit(0)
}

if (command === 'extract') {
  const dest = resolve(rest[0] ?? '')
  const prefixes = rest.slice(1)
  if (prefixes.length === 0) throw new Error('extract needs at least one path prefix')
  let count = 0
  let bytes = 0
  for (const entry of entries) {
    if (!prefixes.some(prefix => entry.path === prefix || entry.path.startsWith(`${prefix}/`))) continue
    if (entry.unpacked) continue // lives in app.asar.unpacked, not in the archive
    const target = join(dest, entry.path)
    if (!resolve(target).startsWith(dest + sep)) throw new Error(`refusing to write outside ${dest}`)
    mkdirSync(dirname(target), { recursive: true })
    const buffer = Buffer.alloc(entry.size)
    if (entry.size > 0) readSync(fd, buffer, 0, entry.size, entry.offset)
    writeFileSync(target, buffer)
    count += 1
    bytes += entry.size
  }
  process.stdout.write(`extracted ${count} files (${(bytes / 1024 / 1024).toFixed(1)} MiB) to ${dest}\n`)
  closeSync(fd)
  process.exit(0)
}

if (command === 'grep') {
  // Search entry contents in place: an asar stores raw bytes, so a marker can
  // be located without extracting a 100 MB tree first.
  const needle = Buffer.from(rest[0] ?? '', 'utf8')
  if (needle.length === 0) throw new Error('grep needs a needle')
  for (const entry of entries) {
    if (entry.unpacked || entry.size === 0 || entry.size > 8 * 1024 * 1024) continue
    const buffer = Buffer.alloc(entry.size)
    readSync(fd, buffer, 0, entry.size, entry.offset)
    const hits = buffer.toString('latin1').split(needle.toString('latin1')).length - 1
    if (hits > 0) process.stdout.write(`${String(hits).padStart(4)}  ${entry.path}\n`)
  }
  closeSync(fd)
  process.exit(0)
}

process.stderr.write(`unknown command: ${command}\n`)
process.exit(2)
