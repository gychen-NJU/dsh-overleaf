/**
 * Full-network smoke test: boots the REAL @deepseek-ai/dsh-host-webserver
 * service plus the built dsh-overleaf service inside one plain cordis Context
 * on an OS-assigned loopback port, aims the proxy at a local fixture upstream,
 * and verifies:
 *   1. HTML rebase + bridge injection over real HTTP,
 *   2. Set-Cookie host-scoping + X-Frame-Options removal,
 *   3. binary streaming untouched,
 *   4. JSON workbench routes,
 *   5. a genuine WebSocket upgrade tunneled end-to-end (echo round trip),
 *   6. bridge.js asset route serving the injected script.
 *
 * Run: node scripts/smoke-live.mjs
 */
import http from 'node:http'
import net from 'node:net'
import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'

/** Build one unmasked server->client text frame. */
function makeFrame(payload) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x81, length])
  } else {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(length, 2)
  }
  return Buffer.concat([header, payload])
}

/** Parse the first masked client->server frame payload. */
function parseClientFrame(chunk) {
  if (chunk.length < 6) return null
  const opcode = chunk[0] & 0x0f
  if (opcode !== 1 && opcode !== 2 && opcode !== 8) return null
  const masked = (chunk[1] & 0x80) !== 0
  let offset = 2
  let length = chunk[1] & 0x7f
  if (length === 126) {
    length = chunk.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    length = Number(chunk.readBigUInt64BE(2))
    offset = 10
  }
  if (!masked) return chunk.subarray(offset, offset + length)
  const mask = chunk.subarray(offset, offset + 4)
  offset += 4
  const payload = Buffer.alloc(length)
  for (let i = 0; i < length; i++) payload[i] = chunk[offset + i] ^ mask[i % 4]
  return payload
}

async function main() {
  const { default: OverleafWorkbenchService } = await import('../lib/index.js')
  const { default: WebServer } = await import('@deepseek-ai/dsh-host-webserver')

  /* ------------------------- fixture upstream ------------------------- */
  let upgradesSeen = 0
  const upstream = http.createServer((req, res) => {
    if (req.url === '/big.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([0, 1, 2, 3, 250, 251]))
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'set-cookie': ['overleaf_session2=tok456; Domain=.upstream.test; Path=/; HttpOnly; Secure'],
    })
    res.end(`<html><head><script src="/js/app.js"></script></head><body>hi<!-- cookies: ${String(req.headers.cookie ?? '')} --></body></html>`)
  })
  upstream.on('upgrade', (req, socket) => {
    upgradesSeen += 1
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.write(makeFrame(Buffer.from('pong-echo')))
    socket.on('data', chunk => {
      try {
        const payload = parseClientFrame(chunk)
        if (payload !== null) socket.write(makeFrame(payload))
      } catch {}
    })
    socket.on('error', () => socket.destroy())
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = upstream.address().port

  /* ------------- boot one real server + plugin row on it -------------- */
  const credentialsStore = new Map()
  const credsStub = {
    resolve: async ref => credentialsStore.has(String(ref)) ? { value: credentialsStore.get(String(ref)), source: 'stub' } : undefined,
    describe: async ref => ({ configured: credentialsStore.has(String(ref)), writable: true }),
    set: async (ref, value) => {
      credentialsStore.set(String(ref), value)
    },
    unset: async ref => {
      credentialsStore.delete(String(ref))
    },
  }

  const ctxB = new Context()
  // Instantiating the service registers it on the context under its own name;
  // an explicit provide() would collide, so none is needed.
  const serverB = new WebServer(ctxB, { host: '127.0.0.1', port: 0 })
  const { Service } = await import('@deepseek-ai/cordis')
  const CredsStubService = class extends Service {
    static inject = []
    constructor(innerCtx) {
      super(innerCtx, 'credentials')
      Object.assign(this, credsStub)
    }
  }
  new CredsStubService(ctxB)

  // Discover and invoke the [Service.init] symbol exactly as the loader would.
  const proto = Object.getPrototypeOf(serverB)
  const initSym = Object.getOwnPropertySymbols(proto).find(sym => /init/i.test(String(sym)))
  if (initSym === undefined) throw new Error('WebServer init symbol not found')
  await serverB[initSym]()

  // Simulate a stored credential (as if the user pasted a cookie): seeded
  // BEFORE construction so the boot-time credential probe picks it up, and
  // the proxy must send it VERBATIM upstream, ignoring any conflicting
  // browser-side jar.
  credentialsStore.set('OVERLEAF_WORKBENCH_COOKIE', 'overleaf_session2=stored-token')
  const workbench = new OverleafWorkbenchService(ctxB, { baseUrl: `http://127.0.0.1:${upstreamPort}` })
  void workbench

  const PORT = serverB.port
  if (!PORT) throw new Error('webserver did not report a bound port')
  const base = `http://127.0.0.1:${PORT}`

  /* ---------------------- exercise everything ------------------------ */

  // 1+2. HTML rebase, bridge injection, XFO removal, cookie scoping.
  const htmlRes = await fetch(`${base}/overleaf-proxy/project/demo`, {
    headers: { cookie: 'overleaf_session2=conflicting-browser-value; gclb=affinity' },
  })
  assert.equal(htmlRes.status, 200, `html proxy status ${htmlRes.status}`)
  const htmlBody = await htmlRes.text()
  assert.ok(htmlBody.includes('src="/overleaf-proxy/js/app.js"'), `rebased:\n${htmlBody.slice(0, 300)}`)
  assert.ok(htmlBody.includes('/overleaf/workbench/bridge.js'), 'bridge injected')
  assert.equal(htmlRes.headers.get('x-frame-options'), null, 'XFO removed')
  assert.ok(htmlBody.includes('overleaf_session2=stored-token'), 'stored credential rode upstream verbatim')
  assert.ok(!htmlBody.includes('conflicting-browser-value'), 'browser-side session cookie must not leak upstream')
  const cookieHeaders = htmlRes.headers.getSetCookie?.() ?? []
  assert.equal(cookieHeaders.length, 1, `set-cookie passthrough (${cookieHeaders.join(' | ')})`)
  assert.ok(!cookieHeaders[0].includes('Domain='), 'domain attr stripped')

  // 3. Binary streaming untouched.
  const binRes = await fetch(`${base}/overleaf-proxy/big.bin`)
  const binBuf = Buffer.from(await binRes.arrayBuffer())
  assert.deepStrictEqual([...binBuf], [0, 1, 2, 3, 250, 251])

  // 4. Status route through the REAL server.
  const statusRes = await fetch(`${base}/overleaf/workbench/status`, { method: 'POST' })
  const statusEnvelope = await statusRes.json()
  assert.equal(statusEnvelope.ok, true)
  assert.equal(statusEnvelope.value.baseUrl, `http://127.0.0.1:${upstreamPort}`)

  // 5. WebSocket tunnel echo (real handshake through both sockets).
  const echo = await wsEcho(PORT, '/overleaf-proxy/socket.io/?EIO=4&transport=websocket')
  assert.equal(echo.received101, true)
  assert.equal(echo.firstFrameText, 'pong-echo', 'initial push routed back')
  assert.equal(echo.echoedText, 'hello-tunnel', 'client frame echoed through tunnel')
  assert.ok(upgradesSeen >= 1, 'fixture saw the upgraded connection')

  // 6. Bridge asset route.
  const bridgeRes = await fetch(`${base}/overleaf/workbench/bridge.js`)
  assert.equal(bridgeRes.status, 200)
  const bridgeText = await bridgeRes.text()
  assert.ok(bridgeText.includes('__DSH_OVERLEAF_BRIDGE__'))

  console.log(`LIVE SMOKE OK — real webserver on :${PORT}, proxy + tunnel verified`)
  // Give libuv a beat to settle destroyed sockets on Windows before exiting;
  // otherwise an async-handle teardown assertion can smear the exit code.
  await new Promise(resolve => setTimeout(resolve, 150))
  upstream.close()
  upstream.closeAllConnections?.()
  process.exit(0)
}

/** Raw WebSocket client speaking just enough RFC6455 to test the tunnel. */
function wsEcho(port, path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const key = Buffer.from('dsh-overleaf-wstest!').toString('base64')
    const socket = net.connect({ host: '127.0.0.1', port })
    let received101 = false
    let buffer = Buffer.alloc(0)
    let firstFrameText = null
    let echoedText = null
    let settled = false

    const finish = error => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error !== undefined) rejectPromise(error)
      else resolvePromise({ received101, firstFrameText, echoedText })
    }

    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:${port}\r\n\r\n`,
      )
    })
    socket.on('error', error => finish(error))
    setTimeout(() => finish(new Error('ws echo timeout')), 8000)

    const pump = () => {
      if (!received101) {
        const index = buffer.indexOf('\r\n\r\n')
        if (index < 0) return
        received101 = buffer.subarray(0, 12).toString().startsWith('HTTP/1.1 101')
        if (!received101) {
          finish(new Error(`expected 101, got ${buffer.subarray(0, 48).toString()}`))
          return
        }
        buffer = buffer.subarray(index + 4)
        sendText('hello-tunnel')
      }
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f
        let length = buffer[1] & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        if (buffer.length < offset + length) return
        const payload = buffer.subarray(offset, offset + length)
        buffer = buffer.subarray(offset + length)
        if (opcode === 1) {
          const text = payload.toString('utf8')
          if (firstFrameText === null) {
            firstFrameText = text
          } else if (echoedText === null && text === 'hello-tunnel') {
            echoedText = text
            finish(undefined)
            return
          }
        } else if (opcode === 8) {
          finish(new Error('closed by remote'))
          return
        }
      }
    }
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      pump()
    })

    function sendText(text) {
      const payload = Buffer.from(text, 'utf8')
      const mask = Buffer.from([11, 22, 33, 44])
      let header
      if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length])
      else {
        header = Buffer.alloc(4)
        header[0] = 0x81
        header[1] = 0x80 | 126
        header.writeUInt16BE(payload.length, 2)
      }
      const masked = Buffer.alloc(payload.length)
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4]
      socket.write(Buffer.concat([header, mask, masked]))
    }
  })
}

main().catch(error => {
  console.error('LIVE SMOKE FAILED:', error)
  process.exit(1)
})
