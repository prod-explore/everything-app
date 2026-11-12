import { describe, expect, it } from 'vitest'
import html from '../index.html?raw'
import manifestJson from '../public/manifest.json?raw'
import sw from '../public/sw.js?raw'

interface ManifestIcon { src: string; sizes: string; type: string; purpose: string }
const manifest = JSON.parse(manifestJson) as { icons: ManifestIcon[] }

// Every file in public/, inlined as a data URL, keyed by its path relative to public/.
const published = Object.fromEntries(
  Object.entries(import.meta.glob<string>('../public/**/*.{png,ico}', { query: '?inline', import: 'default', eager: true }))
    .map(([path, url]) => [path.replace('../public/', '/'), url]),
)

function pngSize(path: string): string {
  const bytes = atob(published[path]!.split(',')[1]!)
  const u32 = (at: number) => [0, 1, 2, 3].reduce((n, i) => n * 256 + bytes.charCodeAt(at + i), 0)
  return `${u32(16)}x${u32(20)}`
}

describe('PWA assets', () => {
  it('every manifest icon exists and has the declared size', () => {
    for (const icon of manifest.icons) {
      expect(published[icon.src], icon.src).toBeDefined()
      expect(pngSize(icon.src), icon.src).toBe(icon.sizes)
    }
  })

  it('offers an "any" and a "maskable" icon of 512px', () => {
    for (const purpose of ['any', 'maskable']) {
      expect(manifest.icons.some(i => i.purpose === purpose && i.sizes === '512x512'), purpose).toBe(true)
    }
  })

  it('index.html links only icons that exist, and the service worker precaches them', () => {
    const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map(m => m[1]!)
    expect(hrefs.length).toBeGreaterThanOrEqual(3)
    for (const href of hrefs) {
      expect(published[href], href).toBeDefined()
      expect(sw, href).toContain(`'${href}'`)
    }
    expect(pngSize('/apple-touch-icon.png')).toBe('180x180')
  })
})
