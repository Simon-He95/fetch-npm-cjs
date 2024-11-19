import { createWriteStream, promises as fsp } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSON5 from 'json5'
import { jsShell } from 'lazy-js-utils/dist/node'
import * as tar from 'tar'

export async function downloadWitchPack(name: string, tempDir: string, retry: number, logger: any = console) {
  await retryAsync(() => {
    return new Promise((resolve, reject) => {
      const { result, status } = jsShell(`npm pack ${name} --pack-destination ${tempDir}`)
      if (status !== 0) {
        logger.error(result)
        reject(result)
      }
      else {
        resolve(true)
      }
    })
  }, retry)
  if (name.startsWith('@'))
    name = name.slice(1)
  const tarballPattern = `${name.replace(/[/@]/g, '-')}.tgz`
  const [tarballPath] = await fsp.readdir(tempDir).then(files => files.filter(file => file.match(tarballPattern)))
  return path.join(tempDir, tarballPath)
}

export async function downloadWithNpmHttp(name: string, tempDir: string, tempFile: string, retry: number, logger: any = console) {
  const tarballUrl = await retryAsync(async () => {
    return new Promise((resolve, reject) => {
      const { result, status } = jsShell(`npm view ${name} dist.tarball`)
      if (status !== 0) {
        logger.error(result)
        reject(result)
      }
      else {
        resolve(result)
      }
    })
  }, retry)

  if (!tarballUrl)
    return ''
  const protocol = new URL(tarballUrl).protocol
  const lib = protocol === 'https:' ? https : http
  const tgzPath = path.join(tempDir, `${tempFile.replace(/@\d+\.\d+\.\d+/, '')}.tgz`)
  const tgzFile = createWriteStream(tgzPath)

  await retryAsync(() => new Promise<void>((resolve, reject) => {
    lib.get(tarballUrl, (response) => {
      response.pipe(tgzFile)
      tgzFile.on('finish', () => {
        tgzFile.close()
        resolve()
      })
    }).on('error', (error) => {
      fsp.unlink(tgzPath).catch((error) => {
        reject(error)
      })
      tgzFile.close()
      reject(error)
    })
  }), retry)

  return tgzPath
}

export async function downloadWithHttp(name: string, tempDir: string, tempFile: string, retry: number, logger: any = console) {
  const tarballUrl = await Promise.any([
    retryAsync(() => getTarballUrlFromRegistry(name), retry),
    retryAsync(() => getTarballUrlFromYarn(name), retry),
    retryAsync(() => getTarballUrlFromTencent(name), retry),
  ]).catch((error) => {
    logger.error(`[fetch-npm]: Failed to fetch tarball URL from all sources: ${error}`)
    throw error
  })

  if (!tarballUrl)
    return ''
  const protocol = new URL(tarballUrl).protocol
  const lib = protocol === 'https:' ? https : http
  const tgzPath = path.join(tempDir, `${tempFile}.tgz`)
  const tgzFile = createWriteStream(tgzPath)

  await retryAsync(() => new Promise<void>((resolve, reject) => {
    lib.get(tarballUrl, (response) => {
      response.pipe(tgzFile)
      tgzFile.on('finish', () => {
        tgzFile.close()
        resolve()
      })
    }).on('error', (error) => {
      fsp.unlink(tgzPath).catch((error) => {
        reject(error)
      })
      reject(error)
    })
  }), retry)

  return tgzPath
}

async function retryAsync<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  try {
    return await fn()
  }
  catch (error: any) {
    if (retries > 0) {
      return retryAsync(fn, retries - 1)
    }
    else {
      throw error
    }
  }
}
const url = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url)

export async function runFromOther(name: string, retry: number, dist?: string, logger: any = console) {
  requestAuth(url)
  // Create temporary directory
  let dirname = name
  if (dirname.startsWith('@'))
    dirname = dirname.slice(1)
  dirname = dirname.replace(/[/@]/g, '-')
  const tempDir = path.join(url, '..', dirname)
  await fsp.mkdir(tempDir, { recursive: true })

  // Get the package tarball URL
  const tgzPath = await Promise.any([
    downloadWithHttp(name, tempDir, dirname, retry, logger),
    downloadWithNpmHttp(name, tempDir, dirname, retry, logger),
    downloadWitchPack(name, tempDir, retry, logger),
  ])
  // Extract the tarball
  await tar.x({ file: tgzPath, cwd: tempDir })

  // Read package.json to get the main field
  const packageJsonPath = path.join(tempDir, 'package', 'package.json')
  const packageJson = JSON.parse(await fsp.readFile(packageJsonPath, 'utf-8'))
  let mainFile = packageJson.main || 'index.js'
  if (dist && !mainFile.includes(dist) && packageJson.exports) {
    for (const key in packageJson.exports) {
      const { import: importUri, require: requireUri } = packageJson.exports[key] || {}
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
  // Read the main file content
  const mainFilePath = path.join(tempDir, 'package', mainFile)

  const mainFileContent = await fsp.readFile(mainFilePath, 'utf-8')
  // Clean up: remove the temporary directory and tarball
  await fsp.rm(tempDir, { recursive: true, force: true })

  return mainFileContent
}

async function getTarballUrlFromRegistry(name: string): Promise<string> {
  const registryUrl = `https://registry.npmjs.org/${name.replace(/@(\d+\.\d+\.\d+)/, '/$1')}`
  const data: Uint8Array[] = []
  await new Promise((resolve, reject) => {
    https.get(registryUrl, (response) => {
      response.on('data', chunk => data.push(chunk))
      response.on('end', resolve)
      response.on('error', reject)
    })
  })

  const metadata = JSON.parse(data.toString())
  if (metadata['dist-tags']) {
    const version = metadata['dist-tags'].latest
    return metadata.versions[version].dist.tarball
  }
  else {
    return metadata.dist.tarball
  }
}

export async function getTarballUrlFromYarn(name: string): Promise<string> {
  const registryUrl = `https://registry.yarnpkg.com/${name.replace(/@(\d+\.\d+\.\d+)/, '/$1')}`
  const data: Uint8Array[] = []
  await new Promise((resolve, reject) => {
    https.get(registryUrl, (response) => {
      response.on('data', chunk => data.push(chunk))
      response.on('end', resolve)
      response.on('error', reject)
    })
  })

  const metadata = JSON5.parse(data.toString())
  if (metadata['dist-tags']) {
    const version = metadata['dist-tags'].latest
    return metadata.versions[version].dist.tarball
  }
  else {
    return metadata.dist.tarball
  }
}

async function getTarballUrlFromTencent(name: string): Promise<string> {
  const registryUrl = `https://mirrors.cloud.tencent.com/npm/${name.replace(/@(\d+\.\d+\.\d+)/, '/$1')}`
  const data: Uint8Array[] = []
  await new Promise((resolve, reject) => {
    https.get(registryUrl, (response) => {
      response.on('data', chunk => data.push(chunk))
      response.on('end', resolve)
      response.on('error', reject)
    })
  })

  const metadata = JSON5.parse(data.toString())
  if (metadata['dist-tags']) {
    const version = metadata['dist-tags'].latest
    return metadata.versions[version].dist.tarball
  }
  else {
    return metadata.dist.tarball
  }
}

function requestAuth(tempDir: string) {
  return fsp.chmod(tempDir, 0o777)
}
