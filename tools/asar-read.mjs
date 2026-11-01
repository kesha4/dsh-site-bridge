/**
 * Dev-only: read files out of the packed DeepSeek Harness app.asar.
 * Usage: node tools/asar-read.mjs list <substring>
 *        node tools/asar-read.mjs read <path-in-asar>
 */
import { openSync, readSync, closeSync } from 'node:fs'

const ASAR = process.env.DSH_ASAR ?? 'C:\\Users\\k4\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'

function loadHeader() {
  const fd = openSync(ASAR, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const jsonSize = head.readUInt32LE(12)
  const json = Buffer.alloc(jsonSize)
  readSync(fd, json, 0, jsonSize, 16)
  return { fd, headerOffset: 16 + jsonSize, tree: JSON.parse(json.toString('utf8')) }
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = `${prefix}/${name}`
    if (entry.files) walk(entry, path, out)
    else out.push({ path, size: entry.size, offset: entry.offset })
  }
}

const { fd, headerOffset, tree } = loadHeader()
const all = []
walk(tree, '', all)

const [command, argument] = process.argv.slice(2)
if (command === 'list') {
  const needle = String(argument ?? '').toLowerCase()
  const matches = all.filter((item) => item.path.toLowerCase().includes(needle))
  for (const item of matches.slice(0, 200)) console.log(`${item.size}\t${item.path}`)
  console.log(`-- ${matches.length} matches`)
} else if (command === 'read') {
  const found = all.find((item) => item.path === argument) ?? all.find((item) => item.path.endsWith(argument))
  if (!found) {
    console.error('not found')
    process.exit(1)
  }
  const buffer = Buffer.alloc(found.size)
  readSync(fd, buffer, 0, found.size, headerOffset + Number(found.offset))
  process.stdout.write(buffer)
} else {
  console.error('usage: asar-read.mjs list <substring> | read <path>')
  process.exit(1)
}
closeSync(fd)
