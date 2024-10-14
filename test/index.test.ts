import { describe, expect, it } from 'vitest'
import { fetchFromCjs } from '../src'

describe('should', () => {
  it('exported', async () => {
    const { fetch } = fetchFromCjs()
    expect(await fetch({
      name: '@common-intellisense/element-plus2',
    })).toMatchInlineSnapshot(`
      {
        "elementPlus2": [Function],
        "elementPlus2Components": [Function],
      }
    `)
  })
})
