import assert from 'node:assert/strict'
import vm from 'node:vm'
import tls from 'node:tls'
import { syncBuiltinESMExports } from 'node:module'
import { Duplex } from 'node:stream'
import { renderBridgeScript } from '../lib/types/inject-script.js'
import { ReverseProxy, rewriteHtml } from '../lib/types/proxy.js'

const bridge = renderBridgeScript()
const start = bridge.indexOf('  function routeSocketUrl(raw) {')
const end = bridge.indexOf('\n  try {', start)
const location = {origin:'http://127.0.0.1:3080',host:'127.0.0.1:3080',hostname:'127.0.0.1',protocol:'http:',href:'http://127.0.0.1:3080/overleaf-proxy/project/user/example'}
const window = {location,__DSH_OVERLEAF_WS_PORT__:50999,__DSH_OVERLEAF_UPSTREAM_ORIGIN__:'https://tex.nju.edu.cn',__DSH_OVERLEAF_SOCKET_ORIGIN__:'https://socket.tex.nju.edu.cn'}
const context = vm.createContext({URL,location,window,PREFIX:'/overleaf-proxy'})
vm.runInContext(bridge.slice(start,end),context)
const route = context.routeSocketUrl
assert.equal(route('ws://socket.tex.nju.edu.cn/socket.io/?EIO=4&transport=websocket'), 'ws://127.0.0.1:50999/__dsh_socket__/socket.io/?EIO=4&transport=websocket')
assert.equal(route('wss://socket.tex.nju.edu.cn/socket.io/?EIO=4'), 'ws://127.0.0.1:50999/__dsh_socket__/socket.io/?EIO=4')
assert.equal(route('ws://127.0.0.1:3080/socket.io/?EIO=3'), 'ws://127.0.0.1:50999/socket.io/?EIO=3')
assert.equal(route('wss://tex.nju.edu.cn/socket.io/?EIO=3'), 'ws://127.0.0.1:50999/socket.io/?EIO=3')
assert.equal(route('wss://evil.test/?x=127.0.0.1:3080'), 'wss://evil.test/?x=127.0.0.1:3080')
assert.equal(route('wss://socket.tex.nju.edu.cn.evil.test/socket.io/'), 'wss://socket.tex.nju.edu.cn.evil.test/socket.io/')
assert.equal(route('wss://socket.tex.nju.edu.cn/private'), 'wss://socket.tex.nju.edu.cn/private')
window.__DSH_OVERLEAF_WS_PORT__ = 0
assert.equal(route('ws://socket.tex.nju.edu.cn/socket.io/'), 'ws://127.0.0.1:3080/overleaf-proxy/__dsh_socket__/socket.io/')

const html = '<html><head><script>window._domainConf={"socket":"socket.tex.nju.edu.cn"}</script><script src="https://static.texpage.com/dist/project.0123456789abcdef.js"></script></head></html>'
assert.ok(rewriteHtml(html,'/overleaf-proxy','/overleaf/workbench/bridge.js','https://tex.nju.edu.cn',undefined,50999).includes('__DSH_OVERLEAF_SOCKET_ORIGIN__="https://socket.tex.nju.edu.cn"'))

// Stub only the TLS transport. Verify target, Host, page Origin, cookie and bytes.
class Socket extends Duplex {
  writes=[];timeouts=[]
  _read() {}
  _write(chunk, _encoding, callback) { this.writes.push(Buffer.from(chunk)); callback() }
  setTimeout(ms) { this.timeouts.push(ms); return this }
}
const originalConnect = tls.connect
const connections = []
tls.connect = (options, connected) => {
  const socket = new Socket()
  connections.push({options,socket})
  setImmediate(connected)
  return socket
}
syncBuiltinESMExports()
try {
  const proxy = new ReverseProxy('https://tex.nju.edu.cn')
  proxy.learnTexpageSocket(html)
  proxy.extraCookie = 'SESSIONID=synthetic-stored'
  const client = new Socket()
  proxy.tunnelUpgrade({url:'/__dsh_socket__/socket.io/?EIO=4&transport=websocket',headers:{origin:'http://127.0.0.1:3080',connection:'Upgrade',upgrade:'websocket',cookie:'SESSIONID=synthetic-old'}},client,Buffer.alloc(0))
  await new Promise(setImmediate)
  const {options,socket} = connections[0]
  assert.equal(options.host, 'socket.tex.nju.edu.cn')
  assert.equal(options.servername, 'socket.tex.nju.edu.cn')
  assert.equal(options.port, 443)
  const request = Buffer.concat(socket.writes).toString()
  assert.ok(request.startsWith('GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\n'))
  assert.ok(request.includes('Host: socket.tex.nju.edu.cn\r\n'))
  assert.ok(request.includes('Origin: https://tex.nju.edu.cn\r\n'))
  assert.ok(request.includes('Cookie: SESSIONID=synthetic-stored\r\n'))
  assert.deepEqual(socket.timeouts,[10000,0], 'idle connections must not be killed before a 25-second heartbeat')
  socket.push(Buffer.from('socket-fixture-frame'))
  await new Promise(setImmediate)
  assert.ok(Buffer.concat(client.writes).includes(Buffer.from('socket-fixture-frame')))
  client.destroy();socket.destroy()
  for (const path of ['/__dsh_socket__/heartbeat','/__dsh_socket__/admin','//evil.test/socket.io/']) {
    const rejected = new Socket()
    proxy.tunnelUpgrade({url:path,headers:{}},rejected,Buffer.alloc(0))
    assert.equal(rejected.destroyed,true)
  }
  const unregistered = new ReverseProxy('https://tex.nju.edu.cn')
  const rejected = new Socket()
  unregistered.tunnelUpgrade({url:'/__dsh_socket__/socket.io/',headers:{}},rejected,Buffer.alloc(0))
  assert.equal(rejected.destroyed,true)
  assert.equal(connections.length,1)
} finally { tls.connect=originalConnect; syncBuiltinESMExports() }
console.log('socket routing smoke passed: exact browser routing, TLS target, page Origin, credentials, idle timeout, closed unknown targets')
