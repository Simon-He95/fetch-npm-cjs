import { Buffer } from 'node:buffer'
import { createWriteStream, promises as fsp } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream/promises'
import JSON5 from 'json5'
import { retryAsync } from 'lazy-js-utils'
import { jsShell } from 'lazy-js-utils/node'
import * as tar from 'tar'

const keepAliveHttpAgent = new http.Agent({ keepAlive: true })
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true })
const TAR_DOWNLOAD_TIMEOUT = 15000
const CLI_FALLBACK_ENV = process.env.FETCH_NPM_ALLOW_CLI_FALLBACK

const tarballUrlCache = new Map<string, Promise<string>>()
const runFromOtherCache = new Map<string, Promise<string>>()

function resolveCliFallback(option?: boolean) {
  if (typeof option === 'boolean')
    return option
  if (CLI_FALLBACK_ENV === 'true')
    return true
  if (CLI_FALLBACK_ENV === 'false')
    return false
  return true
}

function getTarballUrlWithCache(name: string) {
  let pending = tarballUrlCache.get(name)
  if (!pending) {
    pending = resolveTarballUrl(name).catch((error) => {
      tarballUrlCache.delete(name)
      throw error
    })
    tarballUrlCache.set(name, pending)
  }
  return pending
}

async function resolveTarballUrl(name: string) {
  return await Promise.any([
    getTarballUrlFromRegistry(name),
    getTarballUrlFromYarn(name),
    getTarballUrlFromTencent(name),
  ])
}

async function fetchTarballStream(tarballUrl: string): Promise<NodeJS.ReadableStream> {
  return await new Promise((resolve, reject) => {
    const isHttps = tarballUrl.startsWith('https:')
    const lib = isHttps ? https : http
    const agent = isHttps ? keepAliveHttpsAgent : keepAliveHttpAgent
    const request = lib.get(tarballUrl, { agent }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
        return
      }
      resolve(response)
    })
    request.setTimeout(TAR_DOWNLOAD_TIMEOUT, () => {
      request.destroy(new Error(`Request timed out for ${tarballUrl}`))
    })
    request.on('error', reject)
  })
}

async function writeTarballToFile(tarballUrl: string, destination: string) {
  const tarballStream = await fetchTarballStream(tarballUrl)
  await pipeline(tarballStream, createWriteStream(destination))
  return destination
}

async function resolveTarballUrlFromNpmView(name: string, logger: any = console) {
  const { result, status } = await jsShell(`npm view ${name} dist.tarball`, {
    errorExit: false,
  })
  if (status !== 0) {
    logger.error(result)
    throw new Error(result)
  }
  const tarballUrl = result.trim()
  if (!tarballUrl)
    throw new Error(`No tarball url available for ${name}`)
  return tarballUrl
}

async function streamTarballFromRegistry(name: string) {
  const tarballUrl = await getTarballUrlWithCache(name)
  return await fetchTarballStream(tarballUrl)
}

async function streamTarballFromNpmView(name: string, logger: any = console) {
  const tarballUrl = await resolveTarballUrlFromNpmView(name, logger)
  return await fetchTarballStream(tarballUrl)
}

export async function downloadWitchPack(name: string, tempDir: string, logger: any = console) {
  await fsp.mkdir(tempDir, { recursive: true })

  // 确保 npm pack 使用指定的临时目录
  const { result, status } = await jsShell(`npm pack ${name}`, {
    errorExit: false,
    cwd: tempDir, // 在临时目录中执行命令
  })

  if (status !== 0) {
    logger.error(result)
    return Promise.reject(result)
  }

  let cleanName = name
  if (cleanName.startsWith('@'))
    cleanName = cleanName.slice(1)
  const tarballPattern = `${cleanName.replace(/[/@]/g, '-')}`
  const files = await fsp.readdir(tempDir)
  const [tarballPath] = files.filter(file => file.includes(tarballPattern) && file.endsWith('.tgz'))

  if (!tarballPath) {
    throw new Error(`No tarball found for ${name} in ${tempDir}`)
  }

  return path.join(tempDir, tarballPath)
}

export async function downloadWithNpmHttp(name: string, tempDir: string, tempFile: string, logger: any = console) {
  await fsp.mkdir(tempDir, { recursive: true })
  const tarballUrl = await resolveTarballUrlFromNpmView(name, logger)
  const tgzPath = path.join(tempDir, `${tempFile.replace(/@\d+\.\d+\.\d+/, '')}.tgz`)
  return await writeTarballToFile(tarballUrl, tgzPath)
}

export async function downloadWithHttp(name: string, tempDir: string, tempFile: string, logger: any = console) {
  await fsp.mkdir(tempDir, { recursive: true })
  let tarballUrl: string
  try {
    tarballUrl = await getTarballUrlWithCache(name)
  }
  catch (error) {
    logger.error(`[fetch-npm]: Failed to resolve tarball URL for ${name}: ${error}`)
    return Promise.reject(error)
  }

  const tgzPath = path.join(tempDir, `${tempFile}.tgz`)
  return await writeTarballToFile(tarballUrl, tgzPath)
}

export async function runFromOther(name: string, retry: number, dist?: string, logger: any = console, options?: { enableCliFallback?: boolean }) {
  const enableCliFallback = resolveCliFallback(options?.enableCliFallback)
  const cacheKey = `${name}|${dist || ''}|${enableCliFallback ? 'cli' : 'nocli'}`
  const cached = runFromOtherCache.get(cacheKey)
  if (cached)
    return await cached

  const task = (async () => {
    // 完全使用系统临时目录，避免任何项目目录操作
    let dirname = name
    if (dirname.startsWith('@'))
      dirname = dirname.slice(1)
    dirname = dirname.replace(/[/@]/g, '-')

    // 使用更深层的系统临时目录路径，确保完全隔离
    const tempDir = path.join(
      os.tmpdir(),
      'fetch-npm-cjs-isolated',
      process.pid.toString(), // 使用进程 ID 确保唯一性
      dirname,
      Date.now().toString(),
    )

    try {
      await fsp.mkdir(tempDir, { recursive: true })

      const streamExtractor = (factory: () => Promise<NodeJS.ReadableStream>) => {
        return async () => {
          const tarballStream = await factory()
          await pipeline(tarballStream, tar.x({ cwd: tempDir, gzip: true, strict: true }))
        }
      }
      const fileExtractor = (factory: () => Promise<string>) => {
        return async () => {
          const filePath = await factory()
          await tar.x({ file: filePath, cwd: tempDir, gzip: true, strict: true })
        }
      }

      const strategies = [
        streamExtractor(() => streamTarballFromRegistry(name)),
        streamExtractor(() => streamTarballFromNpmView(name, logger)),
        enableCliFallback && fileExtractor(() => downloadWitchPack(name, path.join(tempDir, 'pack'), logger)),
      ].filter((fn): fn is () => Promise<void> => Boolean(fn))

      let extracted = false
      const strategyErrors: any[] = []
      for (const strategy of strategies) {
        try {
          await retryAsync(strategy, retry)
          extracted = true
          break
        }
        catch (error) {
          strategyErrors.push(error)
          logger.error(`[fetch-npm]: Tarball strategy failed for ${name}:`, error)
        }
      }

      if (!extracted) {
        if (strategyErrors.length === 1)
          throw strategyErrors[0]
        throw new AggregateError(strategyErrors, `Failed to extract tarball for ${name}`)
      }

      // Read package.json to get the main field
      const packageJsonPath = path.join(tempDir, 'package', 'package.json')
      const packageJson = JSON.parse(await fsp.readFile(packageJsonPath, 'utf-8'))
      let mainFile = packageJson.main || 'index.js'

      if (dist && !mainFile.includes(dist) && packageJson.exports) {
        for (const key in packageJson.exports) {
          const exportEntry = packageJson.exports[key]
          if (typeof exportEntry === 'object' && exportEntry !== null) {
            const { import: importUri, require: requireUri } = exportEntry
            if (importUri?.includes(dist)) {
              mainFile = importUri
              break
            }
            else if (requireUri?.includes(dist)) {
              mainFile = requireUri
              break
            }
          }
        }
      }

      // Read the main file content
      const mainFilePath = path.join(tempDir, 'package', mainFile)
      const mainFileContent = await fsp.readFile(mainFilePath, 'utf-8')

      return mainFileContent
    }
    catch (error) {
      logger.error(`[fetch-npm]: Error in runFromOther for ${name}:`, error)
      throw error
    }
    finally {
      // 异步清理，不阻塞返回，使用 setTimeout 确保完全异步
      setTimeout(async () => {
        try {
          await fsp.rm(tempDir, { recursive: true, force: true })
        }
        // eslint-disable-next-line unused-imports/no-unused-vars
        catch (cleanupError) {
          // 静默忽略清理错误
        }
      }, 100)
    }
  })()

  runFromOtherCache.set(cacheKey, task)
  try {
    return await task
  }
  catch (error) {
    runFromOtherCache.delete(cacheKey)
    throw error
  }
}

async function getTarballUrlFromRegistry(name: string): Promise<string> {
  const registryUrl = `https://registry.npmjs.org/${name.replace(/@(\d+\.\d+\.\d+)/, '/$1')}`
  const data: Uint8Array[] = []
  await new Promise<void>((resolve, reject) => {
    const request = https.get(registryUrl, { agent: keepAliveHttpsAgent }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
        return
      }
      response.on('data', chunk => data.push(chunk))
      response.on('end', () => resolve())
      response.on('error', reject)
    })
    request.setTimeout(TAR_DOWNLOAD_TIMEOUT, () => {
      request.destroy(new Error(`Request timed out for ${registryUrl}`))
    })
    request.on('error', reject)
  })

  const metadata = JSON.parse(Buffer.concat(data).toString())
  if (metadata['dist-tags']) {
    const version = metadata['dist-tags'].latest
    return metadata.versions[version].dist.tarball
  }
  return metadata.dist.tarball
}

export async function getTarballUrlFromYarn(name: string): Promise<string> {
  const registryUrl = `https://registry.yarnpkg.com/${name.replace(/@(\d+\.\d+\.\d+)/, '/$1')}`
  const data: Uint8Array[] = []
  await new Promise<void>((resolve, reject) => {
    const request = https.get(registryUrl, { agent: keepAliveHttpsAgent }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
        return
      }
      response.on('data', chunk => data.push(chunk))
      response.on('end', () => resolve())
      response.on('error', reject)
    })
    request.setTimeout(TAR_DOWNLOAD_TIMEOUT, () => {
      request.destroy(new Error(`Request timed out for ${registryUrl}`))
    })
    request.on('error', reject)
  })

  const metadata = JSON5.parse(Buffer.concat(data).toString())
  if (metadata['dist-tags']) {
    const version = metadata['dist-tags'].latest
    return metadata.versions[version].dist.tarball
  }
  return metadata.dist.tarball
}

async function getTarballUrlFromTencent(name: string): Promise<string> {
  const registryUrl = `https://mirrors.cloud.tencent.com/npm/${name.replace(/@(\d+\.\d+\.\d+)/, '/$1')}`
  const data: Uint8Array[] = []
  await new Promise<void>((resolve, reject) => {
    const request = https.get(registryUrl, { agent: keepAliveHttpsAgent }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
        return
      }
      response.on('data', chunk => data.push(chunk))
      response.on('end', () => resolve())
      response.on('error', reject)
    })
    request.setTimeout(TAR_DOWNLOAD_TIMEOUT, () => {
      request.destroy(new Error(`Request timed out for ${registryUrl}`))
    })
    request.on('error', reject)
  })

  const metadata = JSON5.parse(Buffer.concat(data).toString())
  if (metadata['dist-tags']) {
    const version = metadata['dist-tags'].latest
    return metadata.versions[version].dist.tarball
  }
  return metadata.dist.tarball
}
