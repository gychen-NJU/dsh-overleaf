/**
 * Full-network smoke test: boots the REAL @deepseek-ai/dsh-host-webserver
 * service plus the built dsh-overleaf service inside one plain cordis Context
 * on an OS-assigned loopback port, aims the proxy at a local fixture upstream,
 * and verifies:
 *   1. HTML rebase + bridge injection over real HTTP,
 *   2. Set-Cookie host-scoping + X-Frame-Options removal,
 *   3. binary streaming untouched,
 *   4. compile JSON + ranged PDF retrieval through the proxy,
 *   5. JSON workbench routes,
 *   6. a genuine WebSocket upgrade tunneled end-to-end (echo round trip),
 *   7. bridge.js asset route serving the injected script.
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
  const fixturePdf = Buffer.from('%PDF-1.7\nfixture-pdf-body\n%%EOF')
  const upstream = http.createServer((req, res) => {
    if (req.url === '/big.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([0, 1, 2, 3, 250, 251]))
      return
    }
    if (req.url === '/socket.io/socket.io.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end('/* socket.io client fixture */')
      return
    }
    if (req.url?.startsWith('/socket.io/1/?')) {
      // Real Socket.IO 0.9 ordering: the HTTP handshake chooses a worker and
      // rotates its affinity cookie; the following WebSocket upgrade must echo
      // that exact value or the sid is unknown on the selected backend.
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'set-cookie': ['GCLB=fresh-worker; Path=/; HttpOnly'],
      })
      res.end('fixture-sid:60:60:websocket,xhr-polling')
      return
    }
    if (req.url?.startsWith('/socket.io/')) {
      // Classic socket.io polling endpoint: echo path + cookie so the test
      // can assert prefix-less pass-through and credential injection.
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`poll-ok url=${req.url} cookie=${String(req.headers.cookie ?? '')}`)
      return
    }
    if (req.method === 'POST' && req.url?.startsWith('/project/demo/compile?')) {
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        status: 'success',
        outputFiles: [{
          path: 'output.pdf',
          url: '/project/demo/build/build-123/output/output.pdf',
          type: 'pdf',
          build: 'build-123',
        }],
        clsiServerId: 'clsi-fixture',
        compileGroup: 'group-fixture',
      }))
      return
    }
    if (req.url?.startsWith('/project/demo/build/build-123/output/output.pdf')) {
      if (req.headers.range === 'bytes=0-7') {
        res.writeHead(206, {
          'content-type': 'application/pdf',
          'accept-ranges': 'bytes',
          'content-range': `bytes 0-7/${fixturePdf.length}`,
          'content-length': '8',
        })
        res.end(fixturePdf.subarray(0, 8))
      } else {
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'accept-ranges': 'bytes',
          'content-length': String(fixturePdf.length),
        })
        res.end(fixturePdf)
      }
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'set-cookie': ['overleaf_session2=tok456; Domain=.upstream.test; Path=/; HttpOnly; Secure'],
    })
    res.end(`<html><head><script>window.siteUrl = "http://127.0.0.1:${upstreamPort}"</script><script src="/js/app.js"></script></head><body>hi<!-- cookies: ${String(req.headers.cookie ?? '')} --></body></html>`)
  })
  upstream.on('upgrade', (req, socket) => {
    upgradesSeen += 1
    if (req.url?.startsWith('/socket.io/1/websocket/fixture-sid')
      && !String(req.headers.cookie ?? '').includes('GCLB=fresh-worker')) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
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

  // Simulate a stored credential (as if the user pasted a cookie). The saved
  // application session stays authoritative, while a fresher browser GCLB
  // value must survive so Socket.IO handshake/upgrade affinity is preserved.
  credentialsStore.set('OVERLEAF_WORKBENCH_COOKIE', 'overleaf_session2=stored-token; GCLB=stale-worker')
  const workbench = new OverleafWorkbenchService(ctxB, { baseUrl: `http://127.0.0.1:${upstreamPort}` })
  // Wait for the companion WS tunnel port to come up.
  for (let i = 0; i < 100 && workbench.wsTunnelPort === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (workbench.wsTunnelPort === 0) throw new Error('WS tunnel did not start')

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
  assert.ok(htmlBody.includes('gclb=affinity'), 'fresh browser affinity cookie must reach upstream')
  assert.ok(!htmlBody.includes('GCLB=stale-worker'), 'stale stored affinity cookie must not override the browser')
  // 7. siteUrl rebasing: the app's own origin string must become the proxy
  // prefix so SPA-built links never escape to the real site.
  assert.ok(htmlBody.includes('window.siteUrl = "/overleaf-proxy"'), `siteUrl rebased:\n${htmlBody.slice(0, 400)}`)
  assert.ok(!htmlBody.includes(`http://127.0.0.1:${upstreamPort}`), 'target origin string fully scrubbed from HTML')
  const cookieHeaders = htmlRes.headers.getSetCookie?.() ?? []
  assert.equal(cookieHeaders.length, 1, `set-cookie passthrough (${cookieHeaders.join(' | ')})`)
  assert.ok(!cookieHeaders[0].includes('Domain='), 'domain attr stripped')

  // 3. Binary streaming untouched.
  const binRes = await fetch(`${base}/overleaf-proxy/big.bin`)
  const binBuf = Buffer.from(await binRes.arrayBuffer())
  assert.deepStrictEqual([...binBuf], [0, 1, 2, 3, 250, 251])

  // 4. Compile completion JSON and the subsequent PDF.js range request both
  // stay under /overleaf-proxy. Preserve the range headers and exact bytes.
  const compileRes = await fetch(`${base}/overleaf-proxy/project/demo/compile?enable_pdf_caching=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'fixture-token' },
    body: JSON.stringify({ rootDoc_id: 'root-doc', draft: false, check: 'silent' }),
  })
  assert.equal(compileRes.status, 200, `compile proxy status ${compileRes.status}`)
  const compileBody = await compileRes.json()
  assert.equal(compileBody.status, 'success')
  assert.equal(compileBody.outputFiles[0].path, 'output.pdf')
  const pdfRes = await fetch(`${base}/overleaf-proxy${compileBody.outputFiles[0].url}`, {
    headers: { range: 'bytes=0-7' },
  })
  assert.equal(pdfRes.status, 206, `PDF range status ${pdfRes.status}`)
  assert.equal(pdfRes.headers.get('content-type'), 'application/pdf')
  assert.equal(pdfRes.headers.get('content-range'), `bytes 0-7/${fixturePdf.length}`)
  assert.equal(pdfRes.headers.get('content-length'), '8')
  assert.deepStrictEqual(Buffer.from(await pdfRes.arrayBuffer()), fixturePdf.subarray(0, 8))

  // 5. Status route through the REAL server.
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

  // 5b. Un-prefixed socket.io channels (classic clients connect at the
  // current origin without any prefix): polling HTTP + WebSocket upgrade
  // must both tunnel to the upstream with the ORIGINAL path and the
  // stored credential injected.
  const pollRes = await fetch(`${base}/socket.io/?EIO=4&transport=polling`, {
    headers: { cookie: 'overleaf_session2=conflicting-browser-value; GCLB=fresh-handshake-worker' },
  })
  assert.equal(pollRes.status, 200, `socket.io polling status ${pollRes.status}`)
  const pollBody = await pollRes.text()
  assert.ok(pollBody.startsWith('poll-ok url=/socket.io/?EIO=4&transport=polling'),
    `prefix-less polling pass-through: ${pollBody.slice(0, 200)}`)
  assert.ok(pollBody.includes('overleaf_session2=stored-token'), 'credential injected into socket.io polling')
  assert.ok(!pollBody.includes('conflicting-browser-value'), 'browser twin not leaked into socket.io polling')
  assert.ok(pollBody.includes('GCLB=fresh-handshake-worker'), 'fresh handshake affinity reaches socket.io polling')
  assert.ok(!pollBody.includes('GCLB=stale-worker'), 'stored affinity must not replace handshake affinity')
  const clientJsRes = await fetch(`${base}/overleaf-proxy/socket.io/socket.io.js`)
  assert.equal(clientJsRes.status, 200, 'socket.io client asset served through prefix')
  const unprefixedEcho = await wsEcho(PORT, '/socket.io/?EIO=4&transport=websocket')
  assert.equal(unprefixedEcho.received101, true, 'prefix-less WS upgrade reaches the tunnel')
  assert.equal(unprefixedEcho.echoedText, 'hello-tunnel', 'prefix-less tunnel echo works')

  // 5c. Companion WS tunnel port: the bootstrap global must be injected and
  // the tunnel must echo through it with an arbitrary dynamic path.
  assert.ok(htmlBody.includes('window.__DSH_OVERLEAF_WS_PORT__='), 'WS tunnel bootstrap injected into HTML')
  const tunnelEcho = await wsEcho(workbench.wsTunnelPort, '/socket.io/1/websocket/1700000000000')
  assert.equal(tunnelEcho.received101, true, 'tunnel-port upgrade accepted')
  assert.equal(tunnelEcho.echoedText, 'hello-tunnel', 'tunnel-port echo works')

  // 5d. Regression for the real production failure: the handshake response
  // rotates GCLB, then the browser sends that fresh value to the companion
  // tunnel. It must override a stale GCLB captured with the saved credential,
  // while the stored application session still replaces the browser's anon
  // twin. The fixture returns 502 when affinity is lost.
  const classicHandshake = await fetch(`${base}/socket.io/1/?projectId=demo&t=1`, {
    headers: { cookie: 'overleaf_session2=browser-anon; GCLB=older-browser-worker' },
  })
  assert.equal(classicHandshake.status, 200, 'classic socket.io handshake succeeds')
  assert.equal(await classicHandshake.text(), 'fixture-sid:60:60:websocket,xhr-polling')
  assert.ok((classicHandshake.headers.getSetCookie?.() ?? []).some(line => line.includes('GCLB=fresh-worker')),
    'handshake forwards the rotated affinity cookie')
  const affinityEcho = await wsEcho(
    workbench.wsTunnelPort,
    '/socket.io/1/websocket/fixture-sid?projectId=demo',
    'overleaf_session2=browser-anon; GCLB=fresh-worker',
  )
  assert.equal(affinityEcho.received101, true, 'fresh handshake affinity reaches websocket upgrade')
  assert.equal(affinityEcho.echoedText, 'hello-tunnel', 'affinity-preserving websocket tunnel works')

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
function wsEcho(port, path, cookie = '') {
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
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:${port}\r\n`
        + `${cookie === '' ? '' : `Cookie: ${cookie}\r\n`}\r\n`,
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
