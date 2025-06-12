import { describe, expect, it } from 'vitest'
import { fetchFromCjs, fetchFromCjsForCommonIntellisense, fetchFromMjs } from '../src'

describe('should', () => {
  it('fetchFromCjsForCommonIntellisense', async () => {
    expect(await fetchFromCjsForCommonIntellisense({
      name: '@common-intellisense/element-ui2',
      version: '0.0.3',
    })).toBeTypeOf('string')
  })

  it('fetchFromCjs', async () => {
    const { fetch } = fetchFromCjs()
    expect(await fetch({
      name: '@common-intellisense/element-ui2',
    })).toMatchInlineSnapshot(`
      {
        "elementUi2": [Function],
        "elementUi2Components": [Function],
      }
    `)
  })

  it('fetchFromMjs', async () => {
    const { fetch } = fetchFromMjs()
    expect(await fetch({
      name: '@common-intellisense/element-ui2',
    })).toMatchInlineSnapshot(`
      {
        "elementUi2": [Function],
        "elementUi2Components": [Function],
      }
    `)
  })
})
