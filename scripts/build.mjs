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

// DSH shares React with client modules through the shell's lazy module loader.
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const client = await readFile(new URL('client.cjs', source), 'utf8')
await writeFile(new URL('client.js', output), [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: require => {`,
  'const exports = {}',
  client,
  'return exports',
  '} })',
].join('\n'))
