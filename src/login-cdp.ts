/**
 * Direct-CDP Overleaf login for dsh-overleaf. Launches a user-selected
 * Chromium-family browser with a dedicated (persistent by default) profile and
 * a freshly reserved loopback CDP port, waits for the user to log in on the
 * configured upstream origin, then reads its cookies with the browser-level
 * `Storage.getCookies` / `Network.getAllCookies` commands. No Playwright
 * download and no ChromeDriver.
 *
 * Adapted for dsh-overleaf from Hoemr/dsh-better-overleaf (MIT), with the
 * cookie-domain filter derived from the configured baseUrl instead of being
 * hard-coded to overleaf.com.
 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { OVERLEAF_WORKBENCH_COOKIE } from './credentials.ts'
import { isSessionishCookie, locationLooksLikeLogin, validateCookieHeader } from './cookie-validate.ts'
import type { WorkbenchLoginResult } from './types.ts'
import type { LoginProfileMode, OverleafBrowserChannel } from './config.ts'

/** Stable dedicated profile directory for persistent login sessions. */
export function persistentLoginProfileDir(): string {
  return join(homedir(), '.dsh', 'plugin-data', 'dsh-overleaf-workbench', 'browser-profile')
}

/** Login orchestration options resolved from plugin config. */
export interface LoginOptions {
  /** Absolute login page URL of the upstream origin. */
  loginUrl: string
  /** Origin whose cookies belong to this account (host suffix match). */
  targetHost: string
  /** Upstream origin (used for generic landing-page and validation checks). */
  baseUrl: string
  /** Project URL prefix proving the browser login reached a real session. */
  projectUrlPrefix: string
  browserChannel: OverleafBrowserChannel
  /** Explicit Chromium-family executable tried first when set. */
  browserPath?: string
  /** Chromium --proxy-server value for the login window (Google reCAPTCHA access); empty = system. */
  loginProxyServer?: string
  timeoutMs: number
  profileMode?: LoginProfileMode | undefined
}

/** One browser executable launch candidate. */
interface BrowserCandidate {
  label: string
  executablePath: string
}

/** One CDP cookie record from the browser-level cookie APIs. */
interface CdpCookie {
  name: string
  value: string
  domain: string
}

/** Minimal promise-based CDP client over the Node global WebSocket. */
class CdpClient {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  private constructor(readonly ws: WebSocket) {
    ws.onmessage = event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } }
      const id = message.id
      if (id === undefined) return
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      if (message.error !== undefined) pending.reject(new Error(message.error.message ?? 'CDP error'))
      else pending.resolve(message.result)
    }
  }

  static async connect(url: string, timeoutMs = 5_000): Promise<CdpClient> {
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error(`dsh-overleaf: CDP WebSocket timed out for ${url}`))
      }, timeoutMs)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error(`dsh-overleaf: CDP WebSocket failed for ${url}`))
      }
    })
    return new CdpClient(ws)
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 5_000): Promise<unknown> {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`dsh-overleaf: CDP ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* already closed */
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Locate the Windows default-browser executable through shell association. */
function windowsDefaultBrowserExecutable(): string | undefined {
  if (process.platform !== 'win32') return undefined
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    "$prog=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice').ProgId;",
    "if(-not $prog){$prog=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice').ProgId};",
    "if(-not $prog){exit 1};",
    "$cmd=(Get-ItemProperty \"Registry::HKEY_CLASSES_ROOT\\$prog\\shell\\open\\command\").'(default)';",
    "if($cmd -match '^\"([^\"]+)\"'){$exe=$matches[1]}elseif($cmd -match '^\\S+'){$exe=$matches[0]};",
    'if($exe){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($exe))}',
  ].join(' ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const encoded = result.stdout?.trim()
  if (encoded === undefined || encoded === '') return undefined
  const executable = Buffer.from(encoded, 'base64').toString('utf8')
  if (executable === '' || !existsSync(executable)) return undefined
  return executable
}

/** Common Chromium-family executable paths across platforms. */
function commonChromiumExecutables(): string[] {
  const roots = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA,
    process.env.HOME,
    '/Applications',
    '/usr/bin',
  ].filter((root): root is string => root !== undefined)
  const names = process.platform === 'win32'
    ? [
        'Microsoft\\Edge\\Application\\msedge.exe',
        'Google\\Chrome\\Application\\chrome.exe',
        'Chromium\\Application\\chrome.exe',
        'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'Vivaldi\\Application\\vivaldi.exe',
      ]
    : process.platform === 'darwin'
      ? [
          'Google Chrome.app/Contents/MacOS/Google Chrome',
          'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          'Chromium.app/Contents/MacOS/Chromium',
          'Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : ['google-chrome', 'chromium', 'microsoft-edge', 'brave-browser']
  const candidates: string[] = []
  for (const root of roots) {
    for (const name of names) candidates.push(join(root, name))
  }
  return candidates.filter(candidate => existsSync(candidate) && !/firefox/i.test(candidate))
}

/** Build ordered launch candidates for one browser selection. */
function candidatesFor(channel: OverleafBrowserChannel, browserPath?: string): BrowserCandidate[] {
  const candidates: BrowserCandidate[] = []
  if (browserPath !== undefined && browserPath.trim() !== '' && existsSync(browserPath.trim())) {
    candidates.push({ label: browserPath.trim(), executablePath: browserPath.trim() })
  }
  if (channel === 'msedge') {
    const executablePath = commonChromiumExecutables().find(path => /msedge/i.test(path))
    if (executablePath !== undefined) candidates.push({ label: 'Microsoft Edge', executablePath })
    return candidates
  }
  if (channel === 'chrome') {
    const executablePath = commonChromiumExecutables().find(path => /chrome|chromium/i.test(path))
    if (executablePath !== undefined) candidates.push({ label: 'Chrome/Chromium', executablePath })
    return candidates
  }
  const defaultBrowser = windowsDefaultBrowserExecutable()
  if (channel === 'default') {
    if (defaultBrowser !== undefined) candidates.push({ label: 'Default browser', executablePath: defaultBrowser })
    return candidates
  }
  if (channel === 'real') {
    // The user's real profile: their default/known browser launched WITHOUT a
    // user-data-dir override so saved accounts and passwords apply.
    if (defaultBrowser !== undefined) candidates.push({ label: 'Default browser (real profile)', executablePath: defaultBrowser })
    for (const executablePath of commonChromiumExecutables()) {
      if (!candidates.some(candidate => candidate.executablePath === executablePath)) {
        candidates.push({ label: `${executablePath} (real profile)`, executablePath })
      }
    }
    return candidates
  }
  if (defaultBrowser !== undefined) candidates.push({ label: 'Default browser', executablePath: defaultBrowser })
  for (const executablePath of commonChromiumExecutables()) {
    if (!candidates.some(candidate => candidate.executablePath === executablePath)) {
      candidates.push({ label: executablePath, executablePath })
    }
  }
  return candidates
}

/** Reserve one loopback TCP port for the browser CDP endpoint. */
async function findFreeCdpPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  const port = typeof address === 'object' && address !== null ? address.port : undefined
  if (port === undefined || !Number.isInteger(port) || port <= 0) {
    throw new Error('dsh-overleaf: could not reserve a local CDP port')
  }
  return port
}

/** Reject as soon as the launched browser process errors or exits. */
function browserProcessFailure(child: ChildProcess): Promise<never> {
  return new Promise<never>((_, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      reject(new Error(`dsh-overleaf: browser exited before CDP was ready (code=${String(code)}, signal=${String(signal)})`))
    })
  })
}

/** Poll one local CDP endpoint until the browser has bound it. */
async function connectCdpWithRetry(port: number, timeoutMs: number): Promise<CdpClient> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await connectCdp(port)
    } catch {
      await sleep(300)
    }
  }
  throw new Error(`dsh-overleaf: browser did not expose CDP on 127.0.0.1:${port} within ${timeoutMs}ms`)
}

/** Connect to one browser-level CDP endpoint. */
async function connectCdp(port: number): Promise<CdpClient> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) })
  if (!response.ok) throw new Error(`dsh-overleaf: CDP endpoint returned HTTP ${response.status} on 127.0.0.1:${port}`)
  const version = await response.json() as { webSocketDebuggerUrl?: string }
  if (version.webSocketDebuggerUrl === undefined) throw new Error('dsh-overleaf: CDP endpoint has no webSocketDebuggerUrl')
  return await CdpClient.connect(version.webSocketDebuggerUrl)
}

/** Read all cookies from one CDP connection via browser-level cookie APIs. */
async function readCookiesFrom(cdp: CdpClient): Promise<CdpCookie[]> {
  let lastError: unknown
  for (const method of ['Storage.getCookies', 'Network.getAllCookies'] as const) {
    try {
      const result = await cdp.call(method) as { cookies?: unknown }
      if (!Array.isArray(result.cookies)) throw new Error(`dsh-overleaf: CDP ${method} returned no cookie array`)
      return result.cookies as CdpCookie[]
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** Connect to the first page target when the browser target lacks a cookie API. */
async function connectFirstPageCdp(port: number, timeoutMs: number): Promise<CdpClient> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) throw new Error(`dsh-overleaf: CDP target list returned HTTP ${response.status}`)
      const targets = await response.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>
      const page = targets.find(target => target.type === 'page')
      const pageUrl = page?.webSocketDebuggerUrl
      if (pageUrl === undefined) throw new Error('dsh-overleaf: CDP target list has no page WebSocket')
      return await CdpClient.connect(pageUrl)
    } catch {
      /* keep polling briefly; the login tab appears right after startup */
    }
    await sleep(300)
  }
  throw new Error(`dsh-overleaf: browser exposed no page CDP target on 127.0.0.1:${port} within ${timeoutMs}ms`)
}

/** List URLs of page targets currently exposed by the browser. */
async function pageTargetUrls(port: number): Promise<string[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) })
  if (!response.ok) throw new Error(`dsh-overleaf: CDP target list returned HTTP ${response.status}`)
  const targets = await response.json() as Array<{ type?: string; url?: string }>
  return targets
    .filter((target): target is { type: string; url: string } =>
      target.type === 'page' && typeof target.url === 'string')
    .map(target => target.url)
}

/**
 * Read target-origin cookies through CDP once the user has logged in.
 *
 * Detection is product-agnostic: the upstream may be standard Overleaf (where
 * the session cookie is `overleaf_session2`) or a TeXPage-based deployment
 * (self-hosted NJU and others) whose session cookie uses an entirely
 * different name and whose dashboard may live at any path. Success therefore
 * requires ALL of:
 *  1. at least one non-preference cookie scoped to the target host,
 *  2. a browser tab sitting on the target origin OUTSIDE its login/SSO pages,
 *  3. server-side validation of the assembled header against /project
 *     (tolerant: 200, 3xx-away-from-login, or 404 all count as authenticated).
 */
async function captureCookies(
  browserCdp: CdpClient,
  cdpPort: number,
  options: Pick<LoginOptions, 'targetHost' | 'baseUrl'>,
  timeoutMs: number,
): Promise<string> {
  const bareHost = options.targetHost.replace(/^www\./, '')
  const origin = options.baseUrl.replace(/\/+$/, '')
  const deadline = Date.now() + timeoutMs
  let cookieCdp = browserCdp
  let pageCdp: CdpClient | undefined
  try {
    while (Date.now() < deadline) {
      try {
        const cookies = await readCookiesFrom(cookieCdp)
        const siteCookies = cookies.filter(cookie =>
          cookie.domain === bareHost || cookie.domain.endsWith(`.${bareHost}`))
        const sessionish = siteCookies.filter(cookie => isSessionishCookie(cookie.name, cookie.value))
        if (sessionish.length > 0) {
          const header = siteCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
          let onLoggedInPage = false
          try {
            onLoggedInPage = (await pageTargetUrls(cdpPort)).some(url => {
              if (!url.startsWith(`${origin}/`)) return false
              const path = url.slice(origin.length)
              return !locationLooksLikeLogin(path)
            })
          } catch {
            onLoggedInPage = false
          }
          if (onLoggedInPage) {
            try {
              await validateCookieHeader(header, options.baseUrl)
              return header
            } catch {
              // Not authenticated yet (or the probe page bounced to /login):
              // keep polling until the user finishes the login flow.
            }
          }
        }
      } catch (error) {
        pageCdp?.close()
        pageCdp = undefined
        cookieCdp = browserCdp
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw error
        pageCdp = await connectFirstPageCdp(cdpPort, Math.min(12_000, remaining))
        cookieCdp = pageCdp
        continue
      }
      await sleep(2_000)
    }
    throw new Error('dsh-overleaf: did not detect a logged-in session before timeout — complete the sign-in inside the opened browser window and keep it open until the workbench reports success')
  } finally {
    pageCdp?.close()
  }
}

/** Stop one browser process tree. */
function stopBrowser(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    child.kill('SIGTERM')
  }
}

/** Run one CDP login attempt against one browser executable. */
async function loginWithExecutable(executablePath: string, options: LoginOptions): Promise<string> {
  const cdpPort = await findFreeCdpPort()
  const realProfile = options.browserChannel === 'real'
  let tempProfileDir: string | undefined
  let profileDir: string
  if (realProfile) {
    profileDir = '(real profile)'
  } else if ((options.profileMode ?? 'persistent') === 'persistent') {
    profileDir = persistentLoginProfileDir()
    await mkdir(profileDir, { recursive: true })
  } else {
    profileDir = await mkdtemp(join(tmpdir(), 'dsh-overleaf-workbench-cdp-'))
    tempProfileDir = profileDir
  }
  const child = spawn(executablePath, [
    ...(realProfile ? [] : [`--user-data-dir=${profileDir}`]),
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    ...(options.loginProxyServer !== undefined && options.loginProxyServer !== ''
      ? [`--proxy-server=${options.loginProxyServer}`]
      : []),
    options.loginUrl,
  ], { stdio: 'ignore', windowsHide: true })
  let cdp: CdpClient | undefined
  try {
    cdp = await Promise.race([
      connectCdpWithRetry(cdpPort, 12_000),
      browserProcessFailure(child),
    ])
    // Abandon capture the moment the user closes the login window instead of
    // polling a dead CDP endpoint until the full timeout elapses.
    const browserExited = new Promise<never>((_, reject) => {
      child.once('exit', (code, signal) => {
        reject(new Error(`dsh-overleaf: the login browser was closed before the session was captured (code=${String(code)}, signal=${String(signal)}); keep the window open until the workbench reports success, or paste the cookie manually`))
      })
    })
    return await Promise.race([
      captureCookies(cdp, cdpPort, options, options.timeoutMs),
      browserExited,
    ])
  } catch (error) {
    if (realProfile) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} — real-profile mode needs the browser fully closed first`
        + ' (a running instance swallows the debug-port flag), and newer Chrome builds refuse CDP on the default profile',
      )
    }
    throw error
  } finally {
    cdp?.close()
    if (!realProfile) stopBrowser(child)
    if (tempProfileDir !== undefined) {
      try {
        await rm(tempProfileDir, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/** Open a URL in the computer's default browser. */
function openDefaultBrowser(url: string): Promise<void> {
  const command = process.platform === 'win32'
    ? { file: 'cmd.exe', args: ['/c', 'start', '', url] }
    : process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : { file: 'xdg-open', args: [url] }
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { stdio: 'ignore', shell: process.platform === 'win32' })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`dsh-overleaf: default-browser launcher exited ${String(code)}`))
    })
  })
}

/**
 * Run the CDP login flow. Returns automatic when cookies were captured,
 * otherwise opens the default browser and returns manual-paste instructions.
 * @param credentials - host credential service.
 * @param options - login orchestration options.
 */
export async function loginViaCdp(
  credentials: Pick<CredentialProvider, 'set'>,
  options: LoginOptions,
): Promise<WorkbenchLoginResult> {
  const failures: string[] = []
  for (const candidate of candidatesFor(options.browserChannel, options.browserPath)) {
    try {
      const cookie = await loginWithExecutable(candidate.executablePath, options)
      await credentials.set(OVERLEAF_WORKBENCH_COOKIE, cookie)
      return { kind: 'automatic' }
    } catch (error) {
      failures.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await openDefaultBrowser(options.loginUrl).catch(() => undefined)
  return {
    kind: 'manual',
    loginUrl: options.loginUrl,
    instructions: failures.length === 0
      ? `Log in to ${options.targetHost} in your default browser, then copy the full Cookie request-header line (DevTools > Network > any request to ${options.targetHost} > Request Headers > Cookie; it must include the httpOnly session cookie such as overleaf_session2). Paste it through the workbench cookie dialog.`
      : `Automatic cookie capture failed for: ${failures.join(' | ')}. Log in in the opened browser, then copy the full Cookie request-header line from DevTools > Network (must include the httpOnly session cookie) and paste it through the workbench cookie dialog.`,
  }
}
