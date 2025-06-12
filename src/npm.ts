import { Buffer } from 'node:buffer'
import { createWriteStream, promises as fsp } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import JSON5 from 'json5'
import { retryAsync } from 'lazy-js-utils'
import { jsShell } from 'lazy-js-utils/node'
import * as tar from 'tar'

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
  const { result, status } = await jsShell(`npm view ${name} dist.tarball`, {
    errorExit: false,
  })
  if (status !== 0) {
    logger.error(result)
    return Promise.reject(result)
  }
  const tarballUrl = result.trim()

  if (!tarballUrl)
    return ''

  const protocol = new URL(tarballUrl).protocol
  const lib = protocol === 'https:' ? https : http
  const tgzPath = path.join(tempDir, `${tempFile.replace(/@\d+\.\d+\.\d+/, '')}.tgz`)
  const tgzFile = createWriteStream(tgzPath)

  return new Promise<string>((resolve, reject) => {
    tgzFile.on('error', reject)
    lib.get(tarballUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
        return
      }
      response.pipe(tgzFile)
      tgzFile.on('finish', () => {
        tgzFile.close()
        resolve(tgzPath)
      })
    }).on('error', (error) => {
      tgzFile.close()
      reject(error)
    })
  })
}

export async function downloadWithHttp(name: string, tempDir: string, tempFile: string, logger: any = console) {
  await fsp.mkdir(tempDir, { recursive: true })
  let tarballUrl: string
  try {
    tarballUrl = await Promise.any([
      getTarballUrlFromRegistry(name),
      getTarballUrlFromYarn(name),
      getTarballUrlFromTencent(name),
    ])
  }
  catch (error) {
    logger.error(`[fetch-npm]: Failed to fetch tarball URL from all sources: ${error}`)
    return Promise.reject(error)
  }

  const protocol = new URL(tarballUrl).protocol
  const lib = protocol === 'https:' ? https : http
  const tgzPath = path.join(tempDir, `${tempFile}.tgz`)
  const tgzFile = createWriteStream(tgzPath)

  return new Promise<string>((resolve, reject) => {
    tgzFile.on('error', reject)
    lib.get(tarballUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
        return
      }
      response.pipe(tgzFile)
      tgzFile.on('finish', () => {
        tgzFile.close()
        resolve(tgzPath)
      })
    }).on('error', (error) => {
      reject(error)
    })
  })
}

export async function runFromOther(name: string, retry: number, dist?: string, logger: any = console) {
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

    // Get the package tarball URL
    const tgzPath = await retryAsync(async () => Promise.any([
      downloadWithHttp(name, path.join(tempDir, 'http'), dirname, logger),
      downloadWithNpmHttp(name, path.join(tempDir, 'npm'), dirname, logger),
      downloadWitchPack(name, path.join(tempDir, 'pack'), logger),
    ]), retry) as string

    await tar.x({ file: tgzPath, cwd: tempDir, sync: true })

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
}

async function getTarballUrlFromRegistry(name: string): Promise<string> {
  const registryUrl = `https://registry.npmjs.org/${name.replace(/@(\d+\.\d+\.\d+)/, '/$1')}`
  const data: Uint8Array[] = []
  await new Promise<void>((resolve, reject) => {
    https.get(registryUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
        return
      }
      response.on('data', chunk => data.push(chunk))
      response.on('end', () => resolve())
      response.on('error', reject)
    }).on('error', reject)
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
    https.get(registryUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
        return
      }
      response.on('data', chunk => data.push(chunk))
      response.on('end', () => resolve())
      response.on('error', reject)
    }).on('error', reject)
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
    https.get(registryUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
        return
      }
      response.on('data', chunk => data.push(chunk))
      response.on('end', () => resolve())
      response.on('error', reject)
    }).on('error', reject)
  })

  const metadata = JSON5.parse(Buffer.concat(data).toString())
  if (metadata['dist-tags']) {
    const version = metadata['dist-tags'].latest
    return metadata.versions[version].dist.tarball
  }
  return metadata.dist.tarball
}
