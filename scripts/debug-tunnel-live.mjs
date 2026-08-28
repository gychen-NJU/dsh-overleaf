/**
 * End-to-end verification against the REAL overleaf.com upstream:
 * boot the real webserver + plugin (v0.2.0, with companion WS tunnel),
 * then attempt a socket.io 0.9 WebSocket upgrade THROUGH the tunnel port
 * and report every frame received.
 *
 * Env: DSH_COOKIE = the pasted session cookie line.
 * Run: node scripts/debug-tunnel-live.mjs
 */
import http from 'node:http'
import net from 'node:net'
import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'

const COOKIE = process.env.DSH_COOKIE ?? ''
if (COOKIE === '') {
  console.error('set DSH_COOKIE first')
  process.exit(1)
}

function wsEcho(port, path, cookie) {
  return new Promise((resolvePromise, rejectPromise) => {
    const key = Buffer.from('dsh-overleaf-wstest!').toString('base64')
    const socket = net.connect({ host: '127.0.0.1', port })
    let received101 = false
    let buffer = Buffer.alloc(0)
    let settled = false
    const frames = []

    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error !== undefined) rejectPromise(error)
      else resolvePromise({ frames })
    }

    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\nOrigin: http://127.0.0.1:${port}\r\n\r\n`,
      )
    })
    let joinSent = false
    socket.on('error', error => finish(error))
    setTimeout(() => finish(new Error(`ws timeout (101=${received101}, frames=${JSON.stringify(frames.slice(0, 3))})`)), 60_000)

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (!received101) {
        const index = buffer.indexOf('\r\n\r\n')
        if (index < 0) return
        received101 = buffer.subarray(0, 12).toString().startsWith('HTTP/1.1 101')
        if (!received101) {
          const headEnd = buffer.indexOf('\r\n\r\n')
          const head = headEnd >= 0 ? buffer.subarray(0, headEnd).toString() : buffer.subarray(0, 400).toString()
          const bodyStart = headEnd >= 0 ? buffer.subarray(headEnd + 4) : Buffer.alloc(0)
          console.log('[tunnel] NON-101 RESPONSE HEAD:\n' + head)
          console.log('[tunnel] NON-101 BODY: ' + bodyStart.toString('utf8').slice(0, 600))
          finish(new Error('expected 101'))
          return
        }
        console.log('[tunnel] 101 OK')
        buffer = buffer.subarray(index + 4)
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
          frames.push(text)
          console.log('[frame <-]', JSON.stringify(text.slice(0, 200)))
          // socket.io 0.9: after the first heartbeat arrives, emit joinProject
          if (text.startsWith('7:::') && !joinSent) {
            joinSent = true
            const sendJoin = (packet) => {
              const mask = Buffer.from([11, 22, 33, 44])
              const data = Buffer.from(packet, 'utf8')
              let header
              if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length])
              else {
                header = Buffer.alloc(4)
                header[0] = 0x81
                header[1] = 0x80 | 126
                header.writeUInt16BE(data.length, 2)
              }
              const masked = Buffer.alloc(data.length)
              for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4]
              console.log('[frame ->]', packet.slice(0, 160))
              socket.write(Buffer.concat([header, mask, masked]))
            }
            sendJoin(`5:::${JSON.stringify({ name: 'joinProject', args: [{ project_id: '68581512cedcb3b9d2c0b785' }] })}`)
          }
          if (text.includes('joinProject') && text.includes('"name"')) {
            console.log('[TUNNEL-E2E OK] joinProject response received over the tunnel')
            clearTimeout(timer)
            finish(undefined)
            return
          }
          if (frames.length >= 8) {
            finish(undefined)
            return
          }
        } else if (opcode === 8) {
          finish(new Error('closed by remote; frames=' + JSON.stringify(frames.slice(0, 3))))
          return
        }
      }
    })
  })
}

const { default: OverleafWorkbenchService } = await import('../lib/index.js')
const { default: WebServer } = await import('@deepseek-ai/dsh-host-webserver')
const credentialsStore = new Map()
credentialsStore.set('OVERLEAF_WORKBENCH_COOKIE', COOKIE)

const ctx = new Context()
const server = new WebServer(ctx, { host: '127.0.0.1', port: 0 })
const { Service } = await import('@deepseek-ai/cordis')
const CredsStub = class extends Service {
  static inject = []
  constructor(innerCtx) {
    super(innerCtx, 'credentials')
    Object.assign(this, {
      resolve: async ref => credentialsStore.has(String(ref)) ? { value: credentialsStore.get(String(ref)), source: 'stub' } : undefined,
      describe: async ref => ({ configured: credentialsStore.has(String(ref)), writable: true }),
      set: async (ref, value) => { credentialsStore.set(String(ref), value) },
      unset: async ref => { credentialsStore.delete(String(ref)) },
    })
  }
}
new CredsStub(ctx)

const proto = Object.getPrototypeOf(server)
const initSym = Object.getOwnPropertySymbols(proto).find(sym => /init/i.test(String(sym)))
await server[initSym]()

const workbench = new OverleafWorkbenchService(ctx, { baseUrl: 'https://www.overleaf.com' })
for (let i = 0; i < 100 && workbench.wsTunnelPort === 0; i++) {
  await new Promise(resolve => setTimeout(resolve, 20))
}
console.log('WS tunnel port:', workbench.wsTunnelPort)

// Real socket.io 0.9 websocket upgrade path through the companion tunnel.
const result = await wsEcho(workbench.wsTunnelPort, `/socket.io/1/websocket/${Date.now()}`, COOKIE)
console.log('FRAMES RECEIVED:', JSON.stringify(result.frames))
console.log('TUNNEL-E2E OK — realtime channel reaches the real upstream')
process.exit(0)
