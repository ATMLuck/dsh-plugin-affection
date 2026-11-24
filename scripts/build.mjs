import { stripTypeScriptTypes } from 'node:module'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'

const source = new URL('../src/', import.meta.url)
const output = new URL('../dist/', import.meta.url)
await mkdir(output, { recursive: true })
for (const file of await readdir(source)) {
  if (!file.endsWith('.ts')) continue
  const input = await readFile(new URL(file, source), 'utf8')
  const js = stripTypeScriptTypes(input).replace(/(from ['"]\.\/[^'"]+)\.ts(['"])/g, '$1.js$2')
  await writeFile(new URL(file.replace(/\.ts$/, '.js'), output), js)
}
