import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkMarketplaceScreenshots,
  readPngDimensions,
  validateScreenshotPaths,
} from '../scripts/check-marketplace.mjs'

test('keeps the public marketplace screenshot set complete and renderable', async () => {
  const screenshots = await checkMarketplaceScreenshots()
  assert.equal(screenshots.length, 4)
  for (const screenshot of screenshots) {
    assert.equal(screenshot.width, 1440)
    assert.equal(screenshot.height, 900)
    assert.ok(screenshot.bytes > 0)
  }
})

test('rejects screenshot paths that are unsafe, duplicated, or not PNG files', () => {
  assert.throws(() => validateScreenshotPaths([]), /1 to 8/)
  assert.throws(
    () => validateScreenshotPaths(Array.from({ length: 9 }, (_, index) => `assets/${index}.png`)),
    /1 to 8/,
  )
  assert.throws(() => validateScreenshotPaths(['/tmp/demo.png']), /must be relative/)
  assert.throws(() => validateScreenshotPaths(['../demo.png']), /must not leave/)
  assert.throws(() => validateScreenshotPaths(['assets/demo.svg']), /must be PNG/)
  assert.throws(() => validateScreenshotPaths(['assets/demo.png', 'assets/demo.png']), /duplicate/)
})

test('rejects files that only use a PNG filename without a PNG header', () => {
  assert.throws(() => readPngDimensions(Buffer.from('not a PNG'), 'fake.png'), /not a PNG/)
})
