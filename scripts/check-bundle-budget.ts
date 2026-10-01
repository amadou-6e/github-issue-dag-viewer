import { readdir, readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

interface ManifestChunk {
  file: string
  css?: string[]
  dynamicImports?: string[]
  isDynamicEntry?: boolean
  isEntry?: boolean
}

const budgets = {
  entry: 215 * 1_024,
  graph: 165 * 1_024,
  markdown: 50 * 1_024,
  router: 30 * 1_024,
  routerWorker: 30 * 1_024,
  routerWasm: 200 * 1_024,
  totalJavaScript: 435 * 1_024,
  css: 52 * 1_024,
} as const

const manifest = JSON.parse(await readFile('dist/.vite/manifest.json', 'utf8')) as Record<
  string,
  ManifestChunk
>

const requiredChunk = (source: string): ManifestChunk => {
  const chunk = manifest[source]
  if (chunk === undefined) throw new Error(`Missing production chunk for ${source}`)
  return chunk
}

const compressedBytes = async (file: string): Promise<number> =>
  gzipSync(await readFile(`dist/${file}`)).byteLength

const entry = requiredChunk('index.html')
const graph = requiredChunk('src/components/GraphCanvas.tsx')
const markdown = requiredChunk('src/components/MarkdownBody.tsx')
const router = requiredChunk('src/components/libavoid-routing.ts')
const assets = await readdir('dist/assets')
const requiredAsset = (pattern: RegExp): string => {
  const file = assets.find((name) => pattern.test(name))
  if (file === undefined) throw new Error(`Missing production asset matching ${pattern}`)
  return `assets/${file}`
}
const routerWorker = requiredAsset(/^libavoid-worker-.*\.js$/u)
const routerWasm = requiredAsset(/^libavoid-.*\.wasm$/u)
const dynamicImports = new Set(entry.dynamicImports ?? [])
for (const [source, chunk] of [
  ['src/components/GraphCanvas.tsx', graph],
  ['src/components/MarkdownBody.tsx', markdown],
] as const) {
  if (!chunk.isDynamicEntry || !dynamicImports.has(source)) {
    throw new Error(`${source} must remain a dynamic production entry`)
  }
}
if (!(graph.dynamicImports ?? []).includes('src/components/libavoid-routing.ts')) {
  throw new Error('The obstacle router must remain a dynamic graph-only chunk')
}
const javascriptFiles = new Set(
  assets.filter((file) => file.endsWith('.js')).map((file) => `assets/${file}`),
)
const cssFiles = new Set(entry.css ?? [])

const measurements = {
  entry: await compressedBytes(entry.file),
  graph: await compressedBytes(graph.file),
  markdown: await compressedBytes(markdown.file),
  router: await compressedBytes(router.file),
  routerWorker: await compressedBytes(routerWorker),
  routerWasm: await compressedBytes(routerWasm),
  totalJavaScript: (
    await Promise.all([...javascriptFiles].map((file) => compressedBytes(file)))
  ).reduce((total, bytes) => total + bytes, 0),
  css: (await Promise.all([...cssFiles].map((file) => compressedBytes(file)))).reduce(
    (total, bytes) => total + bytes,
    0,
  ),
}

const failures = Object.entries(measurements).flatMap(([name, bytes]) => {
  const budget = budgets[name as keyof typeof budgets]
  return bytes <= budget
    ? []
    : [`${name}: ${(bytes / 1_024).toFixed(1)} KiB exceeds ${(budget / 1_024).toFixed(0)} KiB`]
})

console.table(
  Object.fromEntries(
    Object.entries(measurements).map(([name, bytes]) => [
      name,
      {
        gzipKiB: (bytes / 1_024).toFixed(1),
        budgetKiB: (budgets[name as keyof typeof budgets] / 1_024).toFixed(0),
      },
    ]),
  ),
)

if (failures.length > 0) throw new Error(`Bundle budget exceeded\n${failures.join('\n')}`)
