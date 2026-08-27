import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootPath = fileURLToPath(new URL('../', import.meta.url))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function validateScreenshotPaths(value) {
  assert(Array.isArray(value), 'screenshots.json must contain an array')
  assert(value.length >= 1 && value.length <= 8, 'screenshots.json must contain 1 to 8 images')

  const seen = new Set()
  for (const entry of value) {
    assert(typeof entry === 'string' && entry.trim() === entry && entry.length > 0, 'screenshot path must be a non-empty string')
    assert(!isAbsolute(entry), `screenshot path must be relative: ${entry}`)
    assert(!entry.split(/[\\/]/u).includes('..'), `screenshot path must not leave the repository: ${entry}`)
    assert(normalize(entry) === entry.split('/').join(sep), `screenshot path must be normalized: ${entry}`)
    assert(extname(entry).toLowerCase() === '.png', `marketplace screenshot must be PNG: ${entry}`)
    assert(!seen.has(entry), `duplicate marketplace screenshot: ${entry}`)
    seen.add(entry)
  }
  return [...seen]
}

export function readPngDimensions(buffer, path = 'PNG') {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  assert(buffer.subarray(0, 8).equals(signature), `${path} is not a PNG file`)
  assert(buffer.toString('ascii', 12, 16) === 'IHDR', `${path} has no PNG IHDR header`)
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

export async function checkMarketplaceScreenshots(basePath = rootPath) {
  const manifest = JSON.parse(await readFile(resolve(basePath, 'screenshots.json'), 'utf8'))
  const paths = validateScreenshotPaths(manifest)
  const dimensions = []

  for (const path of paths) {
    const absolutePath = resolve(basePath, path)
    assert(absolutePath.startsWith(`${resolve(basePath)}${sep}`), `screenshot escaped repository: ${path}`)
    const metadata = await stat(absolutePath)
    assert(metadata.isFile(), `screenshot is not a file: ${path}`)
    assert(metadata.size > 0 && metadata.size <= 2_000_000, `screenshot size is outside the 1 byte to 2 MB range: ${path}`)
    const image = await readFile(absolutePath)
    const size = readPngDimensions(image, path)
    assert(size.width === 1440 && size.height === 900, `screenshot must be 1440x900: ${path}`)
    dimensions.push({ path, ...size, bytes: metadata.size })
  }

  const sourcePath = resolve(basePath, 'assets/screenshots/marketplace.html')
  const source = await readFile(sourcePath, 'utf8')
  assert(source.includes('示例数据'), 'marketplace source must identify demonstration data')
  assert(source.includes('独立社区插件'), 'marketplace source must identify the independent community plugin')

  return dimensions
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dimensions = await checkMarketplaceScreenshots()
  process.stdout.write(`marketplace screenshots: PASS (${dimensions.length})\n`)
}
