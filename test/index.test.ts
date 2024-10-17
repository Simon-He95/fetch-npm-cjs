import { describe, expect, it } from 'vitest'
import { fetchFromCjs } from '../src'

describe('should', () => {
  it('exported', async () => {
    const { fetch } = fetchFromCjs()
    expect(await fetch({
      name: '@common-intellisense/element-ui2',
      version: '0.0.3',
    })).toMatchInlineSnapshot(`
      {
        "elementUi2": [Function],
        "elementUi2Components": [Function],
      }
    `)
  })
})
