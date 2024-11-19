import { describe, expect, it } from 'vitest'
import { fetchFromCjs, fetchFromCjsForCommonIntellisense } from '../src'

describe('should', () => {
  it('fetchFromCjs', async () => {
    const { fetch } = fetchFromCjs()
    const count = 1
    const result = await Promise.all(Array.from({ length: count }).map(() => fetch({
      name: '@simon_he/white-list',
      retry: 20
    })))
    expect(result).toBeTypeOf('object')
  })

  // it('fetchFromCjsForCommonIntellisense', async () => {
  //   expect(await fetchFromCjsForCommonIntellisense({
  //     name: '@common-intellisense/element-ui2',
  //     version: '0.0.3',
  //   })).toBeTypeOf('string')
  // })
})
