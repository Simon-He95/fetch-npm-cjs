import { Buffer } from 'node:buffer'
import { ofetch } from 'ofetch'
import { runFromOther } from './npm'

export function fetchFromCjs(cacheFetch = new Map<string, string | undefined>()) {
  return {
    async fetch(options: {
      name: string
      retry?: number
      timeout?: number
      remoteUri?: string
      output?: string
      version?: string
      privateResource?: string
    } | {
      name?: string
      retry?: number
      timeout?: number
      remoteUri: string
      output?: string
      version?: string
      privateResource?: string
    }) {
      let { name, retry = 3, timeout = 5000, remoteUri, output = 'index.cjs', version, privateResource } = options
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
            // eslint-disable-next-line ts/no-require-imports
            const { latestVersion } = require('@simon_he/latest-version')
            version = await latestVersion(name, { concurrency: 3 })
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
            runFromOther(key, retry, output),
            privateResource && ofetch(`${privateResource}/${key}/dist/${output}`, { responseType: 'text', retry, timeout }),
          ].filter(Boolean))
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

export async function fetchFromCjsForCommonIntellisense(options: {
  name: string
  retry?: number
  timeout?: number
  remoteUri?: string
  output?: string
  version?: string
  privateResource?: string
} | {
  name?: string
  retry?: number
  timeout?: number
  remoteUri: string
  output?: string
  version?: string
  privateResource?: string
}) {
  const { name, retry = 3, timeout = 5000, remoteUri, output = 'index.cjs', version, privateResource } = options

  if (remoteUri)
    return await ofetch(remoteUri, { responseType: 'text', retry, timeout })

  const key = `${name}@${version}`
  return await Promise.any([
    runFromOther(key, retry, output),
    ofetch(`https://cdn.jsdelivr.net/npm/${key}/dist/${output}`, { responseType: 'text', retry, timeout }),
    ofetch(`https://unpkg.com/${key}/dist/${output}`, { responseType: 'text', retry, timeout }),
    ofetch(`https://registry.npmmirror.com/${key}/dist/${output}`, { responseType: 'text', retry, timeout }),
    ofetch(`https://registry.npmjs.org/${key}/dist/${output}`, { responseType: 'text', retry, timeout }),
    ofetch(`https://r.cnpmjs.org/${key}/dist/${output}`, { responseType: 'text', retry }),
    privateResource && ofetch(`${privateResource}/${key}/dist/${output}`, { responseType: 'text', retry, timeout }),
  ].filter(Boolean))
}

export function fetchFromMjs(cacheFetch = new Map<string, any>()) {
  return {
    async fetch(options: {
      name: string
      retry?: number
      timeout?: number
      remoteUri?: string
      output?: string
      version?: string
      privateResource?: string
    } | {
      name?: string
      retry?: number
      timeout?: number
      remoteUri: string
      output?: string
      version?: string
      privateResource?: string
    }) {
      let { name, retry = 3, timeout = 5000, remoteUri, output = 'index.mjs', version, privateResource } = options
      let moduleExports!: any

      if (remoteUri) {
        const key = remoteUri
        if (cacheFetch.has(key)) {
          moduleExports = cacheFetch.get(key)
        }
        else {
          moduleExports = await import(remoteUri)
          cacheFetch.set(key, moduleExports)
        }
      }
      else if (name) {
        if (!version) {
          try {
            // eslint-disable-next-line ts/no-require-imports
            const { latestVersion } = require('@simon_he/latest-version')
            version = await latestVersion(name, { concurrency: 3 })
          }
          catch (error: any) {
            throw new Error(`Failed to get the latest version of ${name}: ${error.message}`)
          }
        }

        const key = `${name}@${version}`
        if (cacheFetch.has(key)) {
          moduleExports = cacheFetch.get(key)
        }
        else {
          // 尝试多种 ESM 格式和来源
          const esmSources = [
            // ESM.sh - 专门提供 ESM 格式的 CDN
            `https://esm.sh/${key}`,
            `https://esm.sh/${name}@${version}`,

            // Skypack - 另一个 ESM CDN
            `https://cdn.skypack.dev/${name}@${version}`,
            `https://cdn.skypack.dev/${key}`,

            // UNPKG 的 ESM 模式
            `https://unpkg.com/${key}?module`,
            `https://unpkg.com/${key}/dist/${output}`,
            `https://unpkg.com/${key}/dist/index.mjs`,
            `https://unpkg.com/${key}/dist/index.esm.js`,
            `https://unpkg.com/${key}/esm/index.js`,

            // JSDelivr 的 ESM 格式
            `https://cdn.jsdelivr.net/npm/${key}/+esm`,
            `https://cdn.jsdelivr.net/npm/${key}/dist/${output}`,
            `https://cdn.jsdelivr.net/npm/${key}/dist/index.mjs`,
            `https://cdn.jsdelivr.net/npm/${key}/dist/index.esm.js`,
            `https://cdn.jsdelivr.net/npm/${key}/esm/index.js`,

            // 私有资源
            privateResource && `${privateResource}/${key}/dist/${output}`,

            // 尝试主入口文件（有些包的 main 就是 ESM）
            `https://unpkg.com/${key}`,
            `https://cdn.jsdelivr.net/npm/${key}`,
          ].filter(Boolean)

          // 使用 Promise.any 但添加更好的错误处理
          try {
            moduleExports = await Promise.any(
              esmSources.map(async (url) => {
                if (!url)
                  return Promise.reject(new Error('Invalid URL'))
                try {
                  return await import(url)
                }
                catch (error) {
                  // 如果是网络错误或 404，快速失败
                  if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
                    throw error
                  }
                  // 对于其他错误，也快速失败
                  throw new Error(`Failed to import from ${url}: ${error}`)
                }
              }),
            )
          }
          // eslint-disable-next-line unused-imports/no-unused-vars
          catch (allErrors) {
            // 如果所有 ESM 来源都失败，尝试回退到动态转换 CJS
            try {
              // 获取 CJS 版本并尝试转换
              const cjsContent = await fetchFromCjsForCommonIntellisense({
                name,
                version,
                retry,
                timeout,
                output: output.replace('.mjs', '.cjs'), // 转换输出格式
                privateResource,
              })

              // 创建一个简单的 ESM 包装器
              const esmWrapper = `
                const module = { exports: {} };
                ${cjsContent}
                export default module.exports;
                // 动态导出所有属性
                if (module.exports && typeof module.exports === 'object') {
                  for (const key in module.exports) {
                    if (key !== 'default') {
                      globalThis[key] = module.exports[key];
                    }
                  }
                }
              `

              // 使用 data URL 动态导入
              const dataUrl = `data:text/javascript;base64,${Buffer.from(esmWrapper).toString('base64')}`
              moduleExports = await import(dataUrl)
            }
            catch (fallbackError: any) {
              throw new Error(`Failed to load ${name}@${version} as ESM. All sources failed. Last error: ${fallbackError.message}`)
            }
          }

          cacheFetch.set(key, moduleExports)
        }
      }

      return moduleExports
    },

    clear() {
      cacheFetch.clear()
    },
  }
}
