import { latestVersion } from '@simon_he/latest-version'
import { ofetch } from 'ofetch'

export function fetchFromCjs(cacheFetch = new Map<string, string | undefined>()) {
  return {
    async fetch(options: {
      name: string
      retry?: number
      timeout?: number
      remoteUri?: string
      output?: string
      version?: string
    } | {
      name?: string
      retry?: number
      timeout?: number
      remoteUri: string
      output?: string
      version?: string
    }) {
      let { name, retry = 3, timeout = 5000, remoteUri, output = 'index.cjs', version } = options
      let scriptContent
      if (remoteUri) {
        const key = remoteUri
        scriptContent = cacheFetch.has(key)
          ? cacheFetch.get(key)
          : await ofetch(remoteUri, { responseType: 'text', retry, timeout })
        cacheFetch.set(key, scriptContent)
      }
      else if (name) {
        if (!version) {
          try {
            version = await latestVersion(name, { timeout: 5000, concurrency: 3 })
          }
          catch (error: any) {
            throw new Error(`Failed to get the latest version of ${name}: ${error.message}`)
          }
        }
        const key = `${name}@${version}`
        scriptContent = cacheFetch.has(key)
          ? cacheFetch.get(key)
          : await Promise.any([
            ofetch(`https://cdn.jsdelivr.net/npm/${key}/dist/${output}`, { responseType: 'text', retry, timeout }),
            ofetch(`https://unpkg.com/${key}/dist/${output}`, { responseType: 'text', retry, timeout }),
            ofetch(`https://registry.npmmirror.com/${key}/dist/${output}`, { responseType: 'text', retry, timeout }),
            ofetch(`https://registry.npmjs.org/${key}/dist/${output}`, { responseType: 'text', retry, timeout }),
            ofetch(`https://r.cnpmjs.org/${key}/dist/${output}`, { responseType: 'text', retry, timeout }),
          ])
        cacheFetch.set(key, scriptContent)
      }
      if (!scriptContent)
        return {}

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

export function fetchFromMjs(cacheFetch = new Map<string, any>()) {
  return {
    async fetch(options: {
      name: string
      remoteUri?: string
    } | {
      name?: string
      remoteUri: string
    }) {
      const { name, remoteUri } = options
      let moduleExports!: any
      if (remoteUri) {
        const key = remoteUri
        moduleExports = cacheFetch.has(key)
          ? cacheFetch.get(key)
          : await import(remoteUri)
        cacheFetch.set(key, moduleExports)
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
        moduleExports = cacheFetch.has(key)
          ? cacheFetch.get(key)
          : await Promise.any([
            import(`https://cdn.jsdelivr.net/npm/${key}/dist/index.mjs`),
            import(`https://unpkg.com/${key}/dist/index.mjs`),
            import(`https://registry.npmmirror.com/${key}/dist/index.mjs`),
            import(`https://registry.npmjs.org/${key}/dist/index.mjs`),
            import(`https://r.cnpmjs.org/${key}/dist/index.mjs`),
          ])
        // https://esm.sh/@common-intellisense/element-ui2
        cacheFetch.set(key, moduleExports)
      }

      return moduleExports
    },
  }
}
