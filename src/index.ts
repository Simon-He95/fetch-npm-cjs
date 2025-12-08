import { Buffer } from 'node:buffer'
import process from 'node:process'
import { latestVersion } from '@simon_he/latest-version'
import { ofetch } from 'ofetch'
import { runFromOther } from './npm'

const CLI_FALLBACK_ENV = typeof process !== 'undefined' ? process.env.FETCH_NPM_ALLOW_CLI_FALLBACK : undefined
const REMOTE_IMPORT_ENV = typeof process !== 'undefined' ? process.env.FETCH_NPM_ALLOW_REMOTE_ESM : undefined
const hasNativeNetworkImportSupport = typeof window !== 'undefined'
  || typeof (globalThis as any).Deno !== 'undefined'
  || typeof (globalThis as any).Bun !== 'undefined'
  || Boolean((process as any)?.features?.networkImport)
const latestVersionCache = new Map<string, Promise<string>>()

function resolveCliFallbackFlag(option?: boolean) {
  if (typeof option === 'boolean')
    return option
  if (CLI_FALLBACK_ENV === 'true')
    return true
  if (CLI_FALLBACK_ENV === 'false')
    return false
  return true
}

function resolveRemoteImportFlag(option?: boolean) {
  if (typeof option === 'boolean')
    return option
  if (REMOTE_IMPORT_ENV === 'true')
    return true
  if (REMOTE_IMPORT_ENV === 'false')
    return false
  return hasNativeNetworkImportSupport
}

function resolveLatestVersionWithCache(name: string) {
  let pending = latestVersionCache.get(name)
  if (!pending) {
    pending = latestVersion(name, { concurrency: 3 }).catch((error) => {
      latestVersionCache.delete(name)
      throw error
    })
    latestVersionCache.set(name, pending)
  }
  return pending
}

type AbortableTextFactory = () => { promise: Promise<string>, abort: () => void }

function createTextFetchFactory(url: string, retry: number, timeout?: number): AbortableTextFactory {
  return () => {
    const controller = new AbortController()
    const promise = ofetch(url, {
      responseType: 'text',
      retry,
      timeout,
      signal: controller.signal,
    })
    return {
      promise,
      abort: () => controller.abort(),
    }
  }
}

async function importWithBackOff(urls: string[], delay: number) {
  const remaining = [...urls]
  const errors: any[] = []

  while (remaining.length) {
    const url = remaining.shift()
    if (!url)
      break

    try {
      return await import(url)
    }
    catch (error) {
      errors.push(error)
      if (remaining.length)
        await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  throw new AggregateError(errors, 'All ESM sources failed')
}

function createAbortError(reason?: unknown) {
  if (reason instanceof Error)
    return reason
  return new Error('Aborted')
}

async function raceTextFactories(factories: AbortableTextFactory[], externalSignal?: AbortSignal) {
  if (!factories.length)
    throw new Error('No sources provided')

  return await new Promise<string>((resolve, reject) => {
    let settled = false
    let remaining = factories.length
    const aborts: Array<() => void> = []
    const errors: any[] = []
    function cleanup() {
      settled = true
      if (externalSignal)
        externalSignal.removeEventListener('abort', onAbort)
    }
    function rejectWithErrors() {
      cleanup()
      reject(new AggregateError(errors.filter(Boolean), 'All sources failed'))
    }
    function onAbort() {
      if (settled)
        return
      aborts.forEach(abort => abort?.())
      cleanup()
      reject(createAbortError(externalSignal?.reason))
    }
    if (externalSignal) {
      if (externalSignal.aborted) {
        onAbort()
        return
      }
      externalSignal.addEventListener('abort', onAbort, { once: true })
    }

    factories.forEach((factory, index) => {
      let instance: { promise: Promise<string>, abort: () => void }
      try {
        instance = factory()
      }
      catch (error) {
        errors[index] = error
        remaining -= 1
        if (!remaining && !settled)
          reject(new AggregateError(errors.filter(Boolean), 'All sources failed'))
        return
      }

      aborts[index] = instance.abort
      instance.promise.then((value) => {
        if (settled)
          return
        settled = true
        aborts.forEach((abort, abortIndex) => {
          if (abortIndex !== index)
            abort?.()
        })
        resolve(value)
      }).catch((error) => {
        errors[index] = error
        remaining -= 1
        if (!remaining && !settled)
          rejectWithErrors()
      })
    })
  })
}

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
      allowCliFallback?: boolean
      signal?: AbortSignal
    } | {
      name?: string
      retry?: number
      timeout?: number
      remoteUri: string
      output?: string
      version?: string
      privateResource?: string
      allowCliFallback?: boolean
      signal?: AbortSignal
    }) {
      let { name, retry = 3, timeout = 5000, remoteUri, output = 'index.cjs', version, privateResource, allowCliFallback, signal } = options
      let scriptContent
      if (remoteUri) {
        const key = remoteUri
        scriptContent = cacheFetch.has(key)
          ? cacheFetch.get(key)
          : await ofetch(remoteUri, { responseType: 'text', retry, timeout, signal })
        cacheFetch.set(key, scriptContent)
      }
      else if (name) {
        if (!version) {
          try {
            version = await resolveLatestVersionWithCache(name)
          }
          catch (error: any) {
            throw new Error(`Failed to get the latest version of ${name}: ${error.message}`)
          }
        }
        const key = `${name}@${version}`
        const enableCliFallback = resolveCliFallbackFlag(allowCliFallback)
        const execRunFromOther = () => runFromOther(key, retry, output, console, { enableCliFallback })
        if (cacheFetch.has(key)) {
          scriptContent = cacheFetch.get(key)
        }
        else {
          const cdnFactories = [
            createTextFetchFactory(`https://cdn.jsdelivr.net/npm/${key}/dist/${output}`, retry, timeout),
            createTextFetchFactory(`https://unpkg.com/${key}/dist/${output}`, retry, timeout),
            createTextFetchFactory(`https://registry.npmmirror.com/${key}/dist/${output}`, retry, timeout),
            createTextFetchFactory(`https://registry.npmjs.org/${key}/dist/${output}`, retry, timeout),
            createTextFetchFactory(`https://r.cnpmjs.org/${key}/dist/${output}`, retry, timeout),
            privateResource && createTextFetchFactory(`${privateResource}/${key}/dist/${output}`, retry, timeout),
          ].filter((factory): factory is AbortableTextFactory => Boolean(factory))

          try {
            scriptContent = cdnFactories.length
              ? await raceTextFactories(cdnFactories, signal)
              : await execRunFromOther()
          }
          catch (error) {
            if (signal?.aborted)
              throw error
            scriptContent = await execRunFromOther()
          }
          cacheFetch.set(key, scriptContent)
        }
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
  allowCliFallback?: boolean
  signal?: AbortSignal
} | {
  name?: string
  retry?: number
  timeout?: number
  remoteUri: string
  output?: string
  version?: string
  privateResource?: string
  allowCliFallback?: boolean
  signal?: AbortSignal
}) {
  const { name, retry = 3, timeout = 5000, remoteUri, output = 'index.cjs', version, privateResource, allowCliFallback, signal } = options

  if (remoteUri)
    return await ofetch(remoteUri, { responseType: 'text', retry, timeout, signal })

  const key = `${name}@${version}`
  const enableCliFallback = resolveCliFallbackFlag(allowCliFallback)
  const execRunFromOther = () => runFromOther(key, retry, output, console, { enableCliFallback })
  const cdnFactories = [
    createTextFetchFactory(`https://cdn.jsdelivr.net/npm/${key}/dist/${output}`, retry, timeout),
    createTextFetchFactory(`https://unpkg.com/${key}/dist/${output}`, retry, timeout),
    createTextFetchFactory(`https://registry.npmmirror.com/${key}/dist/${output}`, retry, timeout),
    createTextFetchFactory(`https://registry.npmjs.org/${key}/dist/${output}`, retry, timeout),
    createTextFetchFactory(`https://r.cnpmjs.org/${key}/dist/${output}`, retry, timeout),
    privateResource && createTextFetchFactory(`${privateResource}/${key}/dist/${output}`, retry, timeout),
  ].filter((factory): factory is AbortableTextFactory => Boolean(factory))

  try {
    if (!cdnFactories.length)
      return await execRunFromOther()
    return await raceTextFactories(cdnFactories, signal)
  }
  catch (error) {
    if (signal?.aborted)
      throw error
    return await execRunFromOther()
  }
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
      allowRemoteImport?: boolean
    } | {
      name?: string
      retry?: number
      timeout?: number
      remoteUri: string
      output?: string
      version?: string
      privateResource?: string
      allowRemoteImport?: boolean
    }) {
      let { name, retry = 3, timeout = 5000, remoteUri, output = 'index.mjs', version, privateResource, allowRemoteImport } = options
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
            version = await resolveLatestVersionWithCache(name)
          }
          catch (error: any) {
            throw new Error(`Failed to get the latest version of ${name}: ${error.message}`)
          }
        }

        const key = `${name}@${version}`
        const enableRemoteImport = resolveRemoteImportFlag(allowRemoteImport)
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

          const loadFromCjsFallback = async () => {
            try {
              const cjsContent = await fetchFromCjsForCommonIntellisense({
                name,
                version,
                retry,
                timeout,
                output: output.replace('.mjs', '.cjs'), // 转换输出格式
                privateResource,
              })

              const esmWrapper = `
                const module = { exports: {} };
                ${cjsContent}
                export default module.exports;
                if (module.exports && typeof module.exports === 'object') {
                  for (const key in module.exports) {
                    if (key !== 'default') {
                      globalThis[key] = module.exports[key];
                    }
                  }
                }
              `

              const dataUrl = `data:text/javascript;base64,${Buffer.from(esmWrapper).toString('base64')}`
              return await import(dataUrl)
            }
            catch (fallbackError: any) {
              throw new Error(`Failed to load ${name}@${version} as ESM. All sources failed. Last error: ${fallbackError.message}`)
            }
          }

          moduleExports = enableRemoteImport
            ? await importWithBackOff(esmSources, 1500).catch(loadFromCjsFallback)
            : await loadFromCjsFallback()

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
