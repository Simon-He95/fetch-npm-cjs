import { latestVersion } from '@simon_he/latest-version'
import { ofetch } from 'ofetch'

export function fetchFromCjs(cacheFetch = new Map()) {
  return {
    async fetch(options: {
      name: string
      retry?: number
      timeout?: number
      remoteUri?: string
    } | {
      name?: string
      retry?: number
      timeout?: number
      remoteUri: string
    }) {
      const { name, retry = 3, timeout = 5000, remoteUri } = options
      let scriptContent!: string
      if (remoteUri) {
        const key = remoteUri
        scriptContent = cacheFetch.has(key)
          ? cacheFetch.get(key)
          : await Promise.any([
            ofetch(remoteUri, { responseType: 'text', retry, timeout }),
            ofetch(remoteUri, { responseType: 'text', retry, timeout }),
            ofetch(remoteUri, { responseType: 'text', retry, timeout }),
            ofetch(remoteUri, { responseType: 'text', retry, timeout }),
            ofetch(remoteUri, { responseType: 'text', retry, timeout }),
            ofetch(remoteUri, { responseType: 'text', retry, timeout }),
          ])
        cacheFetch.set(key, scriptContent)
      }
      else if (name) {
        let version = ''
        try {
          version = await latestVersion(name, { timeout: 5000, concurrency: 3 })
        }
        catch (error: any) {
          throw new Error(`Failed to get the latest version of ${name}: ${error.message}`)
        }

        const key = `${name}@${version}`
        scriptContent = cacheFetch.has(key)
          ? cacheFetch.get(key)
          : await Promise.any([
            ofetch(`https://cdn.jsdelivr.net/npm/${key}/dist/index.cjs`, { responseType: 'text', retry, timeout }),
            ofetch(`https://unpkg.com/${key}/dist/index.cjs`, { responseType: 'text', retry, timeout }),
            ofetch(`https://registry.npmmirror.com/${key}/dist/index.cjs`, { responseType: 'text' }),
            ofetch(`https://registry.npmjs.org/${key}/dist/index.cjs`, { responseType: 'text' }),
            ofetch(`https://r.cnpmjs.org/${key}/dist/index.cjs`, { responseType: 'text' }),
            ofetch(`https://cdn.jsdelivr.net/npm/${key}/dist/index.cjs`, { responseType: 'text' }),
          ])
        cacheFetch.set(key, scriptContent)
      }

      const module: any = {}
      const runModule = new Function('module', scriptContent)
      runModule(module)
      const moduleExports = module.exports
      return moduleExports
    },
    clear() {
      cacheFetch.clear()
    },
  }
}
