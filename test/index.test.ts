import { describe, expect, it } from 'vitest'
import { fetchFromCjs, fetchFromCjsForCommonIntellisense, fetchFromMjs } from '../src'

describe('should', () => {
  it('fetchFromCjsForCommonIntellisense', async () => {
    expect(await fetchFromCjsForCommonIntellisense({
      name: '@common-intellisense/element-ui2',
      version: '0.0.3',
    })).toBeTypeOf('string')
  })

  it('fetchFromCjs - @common-intellisense/element-ui2', async () => {
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

  it('fetchFromCjs - @simon_he/white-list', async () => {
    const { fetch } = fetchFromCjs()

    expect(await fetch({ name: '@simon_he/white-list' })).toMatchInlineSnapshot(`
      {
        "getBackKey": [Function],
        "getDeSecretKey": [Function],
        "getKey": [Function],
        "getSecretKey": [Function],
        "getWhiteList": [Function],
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
