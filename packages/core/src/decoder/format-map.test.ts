import { describe, expect, it } from 'vitest'
import { ALL_FORMATS } from '../types'
import { fromZxingFormat, toNativeFormats, toZxingFormats } from './format-map'

describe('format map', () => {
  it('every BarcodeFormat maps to a zxing name and back', () => {
    for (const f of ALL_FORMATS) {
      const [z] = toZxingFormats([f])
      expect(z, f).toBeTruthy()
      expect(fromZxingFormat(z!), `${f} → ${z}`).toBe(f)
    }
  })

  it('collapses zxing variants', () => {
    expect(fromZxingFormat('Code39Ext')).toBe('code_39')
    expect(fromZxingFormat('ITF14')).toBe('itf')
    expect(fromZxingFormat('ISBN')).toBe('ean_13')
    expect(fromZxingFormat('RMQRCode')).toBe('micro_qr')
  })

  it('unknown zxing names yield undefined', () => {
    expect(fromZxingFormat('None')).toBeUndefined()
    expect(fromZxingFormat('DXFilmEdge')).toBeUndefined()
  })

  it('native filter keeps only supported names in request order', () => {
    expect(toNativeFormats(['qr_code', 'micro_qr', 'ean_13'], ['ean_13', 'qr_code'])).toEqual(['qr_code', 'ean_13'])
  })
})
