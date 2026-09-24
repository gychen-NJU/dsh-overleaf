// Source-only smoke: no build artifacts, credentials, network or DSH runtime.
import assert from 'node:assert/strict'
import { SOCKET_PROXY_PATH, extractTexpageSocketOrigin, resolveTexpageSocketTarget } from '../src/texpage-socket.ts'

const page = 'https://tex.nju.edu.cn'
const host = 'socket.tex.nju.edu.cn'
const html = value => `<html><head><script>window._domainConf = ${JSON.stringify({ socket: value })};</script></head></html>`
const extract = (value, origin = page) => extractTexpageSocketOrigin(html(value), origin)
assert.equal(SOCKET_PROXY_PATH, '/__dsh_socket__')
assert.equal(extract(host)?.href, `https://${host}/`)
assert.equal(extract(`${host}:443`)?.href, `https://${host}/`)
assert.equal(extract(host, new URL(`${page}/project/example`))?.href, `https://${host}/`)
assert.equal(extract(host, 'https://www.tex.nju.edu.cn')?.href, `https://${host}/`)
assert.equal(extract('socket.texpage.com', 'https://www.texpage.com')?.href, 'https://socket.texpage.com/')
assert.equal(extract(host, 'http://tex.nju.edu.cn')?.href, `http://${host}/`)
assert.equal(extract(`${host}:80`, 'http://tex.nju.edu.cn')?.href, `http://${host}/`)

for (const value of [
  undefined, null, 1, true, [], {}, `https://${host}`, `wss://${host}`, `//${host}`,
  `${host}/`, `${host}/socket.io`, `${host}?x=1`, `${host}#hash`,
  `user@${host}`, `user:password@${host}`, `${host}@evil.test`,
  `${host}.evil.test`, `evil.${host}`, 'socket.nju.edu.cn', 'tex.nju.edu.cn',
  `${host}:80`, `${host}:444`, `${host}:0443`, `${host}:`, `${host}.`,
  host.toUpperCase(), ` ${host}`, `${host} `, `${host}\n`, `socket\t.tex.nju.edu.cn`,
  `${host}\\evil.test`, 'socket%2etex.nju.edu.cn', '127.0.0.1', '[::1]',
]) assert.equal(extract(value), undefined, `reject socket authority ${JSON.stringify(value)}`)
for (const origin of ['invalid', '//tex.nju.edu.cn', 'wss://tex.nju.edu.cn', 'file:///example',
  'https://user@tex.nju.edu.cn', 'https://tex.nju.edu.cn:8443', 'https://evil.test']) {
  assert.equal(extract(host, origin), undefined, `reject page origin ${origin}`)
}
assert.equal(extract(`${host}:443`, 'http://tex.nju.edu.cn'), undefined)

const valid = `window._domainConf={"socket":"${host}"};`
for (const body of [
  '', 'window._domainConf={};', 'window._domainConf=null;', 'window._domainConf=[];',
  `window._domainConf={socket:"${host}"};`, `window._domainConf={'socket':'${host}'};`,
  `window._domainConf={"socket":"${host}",};`, `window._domainConf={"socket":"${host}"`,
  `window._domainConf=JSON.parse('{"socket":"${host}"}');`,
  `window._domainConf={"socket":"${host}"} || evil();`,
  `window._domainConf={"socket":"${host}","run":evil()};`,
  valid + valid, valid + 'window._domainConf={};',
  `/* ${valid} */`, `// ${valid}`, JSON.stringify(valid), '`' + valid + '`',
  `otherwindow._domainConf={"socket":"${host}"};`,
  `other.window._domainConf={"socket":"${host}"};`,
]) assert.equal(extractTexpageSocketOrigin(`<script>${body}</script>`, page), undefined, `reject nonliteral/ambiguous ${body}`)
assert.equal(extractTexpageSocketOrigin(valid, page), undefined, 'not a script')
assert.equal(extractTexpageSocketOrigin(`<!-- <script>${valid}</script> -->`, page), undefined)
assert.equal(extractTexpageSocketOrigin(`<script src="https://static.texpage.com/dist/project.js">${valid}</script>`, page), undefined)
assert.equal(extractTexpageSocketOrigin(`<script>/* comment */\n// comment\n${valid}</script>`, page)?.origin, `https://${host}`)
assert.equal(extractTexpageSocketOrigin(`<script>window . _domainConf = {"socket":"${host}","nested":{"array":[1,{"text":"} \\\" {"}]}}</script>`, page)?.origin, `https://${host}`)
assert.equal(extractTexpageSocketOrigin(html(host) + html(host), page), undefined, 'ambiguous assignments across scripts')
assert.equal(extractTexpageSocketOrigin(' '.repeat(4 * 1024 * 1024 + 1) + html(host), page), undefined)
assert.equal(extractTexpageSocketOrigin(`<script>window._domainConf={"socket":"${host}","large":"${'x'.repeat(65536)}"};</script>`, page), undefined)
assert.equal(extractTexpageSocketOrigin(`<script>window._domainConf={"socket":"${host}","deep":${'['.repeat(65)}0${']'.repeat(65)}};</script>`, page), undefined)

const socketOrigin = extract(host)
assert.ok(socketOrigin instanceof URL)
const before = socketOrigin.href
for (const path of ['/socket.io', '/socket.io/', '/heartbeat']) {
  for (const query of ['', '?', '?EIO=4&transport=websocket', '?sid=synthetic&x=%2f%2F&x=two+words', '?next=https://example.test/a/../b']) {
    const target = resolveTexpageSocketTarget(SOCKET_PROXY_PATH + path + query, socketOrigin)
    assert.equal(target?.href, `https://${host}${path}${query}`, 'literal path and query preserved')
  }
}
assert.equal(socketOrigin.href, before, 'caller URL is not mutated')
assert.equal(resolveTexpageSocketTarget(`${SOCKET_PROXY_PATH}/heartbeat`, extract(host, 'http://tex.nju.edu.cn'))?.href, `http://${host}/heartbeat`)
assert.equal(resolveTexpageSocketTarget(`${SOCKET_PROXY_PATH}/socket.io/`, undefined), undefined)
for (const path of [
  '', '/', SOCKET_PROXY_PATH, '/socket.io/', '/overleaf-proxy/__dsh_socket__/socket.io/',
  '/__dsh_socket__evil/socket.io/', `${SOCKET_PROXY_PATH}/heartbeat/`,
  `${SOCKET_PROXY_PATH}/socket.io/extra`, `${SOCKET_PROXY_PATH}//socket.io/`,
  `/${SOCKET_PROXY_PATH}/socket.io/`, `${SOCKET_PROXY_PATH}/https://evil.test/socket.io/`,
  `${SOCKET_PROXY_PATH}//evil.test/socket.io/`, `https://evil.test${SOCKET_PROXY_PATH}/socket.io/`,
  `${SOCKET_PROXY_PATH}/../socket.io/`, `${SOCKET_PROXY_PATH}/socket.io/../heartbeat`,
  `${SOCKET_PROXY_PATH}/%2e%2e/socket.io/`, `${SOCKET_PROXY_PATH}/%73ocket.io/`,
  `${SOCKET_PROXY_PATH}/socket.io%2f`, `${SOCKET_PROXY_PATH}/socket.io\\`,
  `${SOCKET_PROXY_PATH}/socket.io/#fragment`, `${SOCKET_PROXY_PATH}/socket.io/?x=#fragment`,
  `${SOCKET_PROXY_PATH}/socket.io/?x=\r\nHeader: injected`,
  `${SOCKET_PROXY_PATH}/socket.io/?x=has space`, `${SOCKET_PROXY_PATH}/socket.io/?x=\u007f`,
  `${SOCKET_PROXY_PATH}/socket.io/?x=${'x'.repeat(65536)}`,
]) assert.equal(resolveTexpageSocketTarget(path, socketOrigin), undefined, `reject path ${JSON.stringify(path.slice(0,150))}`)
for (const origin of [
  'https://tex.nju.edu.cn', 'wss://socket.tex.nju.edu.cn', 'https://socket.tex.nju.edu.cn:444',
  'https://user:password@socket.tex.nju.edu.cn', 'https://socket.tex.nju.edu.cn/base',
  'https://socket.tex.nju.edu.cn/?query=1', 'https://socket.tex.nju.edu.cn/#hash',
]) assert.equal(resolveTexpageSocketTarget(`${SOCKET_PROXY_PATH}/socket.io/`, new URL(origin)), undefined, `reject malformed socket origin ${origin}`)

console.log('TeXPage socket smoke passed: bounded JSON-only extraction, exact sibling/default-port authority, literal marker paths and preserved queries; no network or credentials')
