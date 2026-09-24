#!/usr/bin/env node
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
  TEX_PROXY_PATH, resolveTexpageTexRedirect, resolveTexpageTexTarget, serveTexpageTex,
} from '../src/texpage-tex-proxy.ts'

const site = new URL('https://tex.nju.edu.cn')
const objectOrigin = new URL('https://latex-file.texpageusercontent.com')
const ids = { ownerKey: 'owner_1', projectKey: 'project_2', versionNo: 'version_3', fileKey: 'file_4' }
const requestPath = TEX_PROXY_PATH + '?' + new URLSearchParams(ids)
const target = resolveTexpageTexTarget(requestPath, site, objectOrigin)
assert.ok(target)
const signed = objectOrigin.origin + target.objectPath + '?X-Amz-Signature=synthetic'

test('TeX readback binds the configured site and exact fixed object origin', () => {
  assert.equal(target.download.href, 'https://tex.nju.edu.cn/api/project/file?projectKey=project_2&versionNo=version_3&fileKey=file_4')
  assert.equal(target.objectPath, '/owner_1/file_4_version_3')
  assert.equal(resolveTexpageTexRedirect(signed, target)?.href, signed)
})

test('TeX readback rejects arbitrary origins, paths and duplicate identity fields', () => {
  assert.equal(resolveTexpageTexTarget(requestPath, site, new URL('https://evil.test')), undefined)
  assert.equal(resolveTexpageTexTarget('/overleaf-proxy' + requestPath, site, objectOrigin), undefined)
  assert.equal(resolveTexpageTexTarget(requestPath + '&fileKey=other', site, objectOrigin), undefined)
  assert.equal(resolveTexpageTexTarget(requestPath + '&url=https%3A%2F%2Fevil.test', site, objectOrigin), undefined)
  assert.equal(resolveTexpageTexRedirect(signed.replace(objectOrigin.origin, 'https://evil.test'), target), undefined)
  assert.equal(resolveTexpageTexRedirect(signed.replace(ids.fileKey, 'other'), target), undefined)
})

class Sink extends EventEmitter {
  statusCode = 0
  destroyed = false
  writableEnded = false
  headers = {}
  body = ''
  writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this }
  end(text) { this.body += text ?? ''; this.writableEnded = true; return this }
}

function request(method = 'GET') {
  return Object.assign(new EventEmitter(), { method, aborted: false })
}

test('TeX readback keeps credentials on the site hop and returns UTF-8 source', async () => {
  const res = new Sink()
  const calls = []
  await serveTexpageTex(request(), res, target, {
    cookie: 'SESSION=synthetic', authorization: 'Bearer synthetic', 'user-agent': 'agent', referer: 'secret',
  }, async (url, init) => {
    calls.push({ url: String(url), init })
    if (calls.length === 1) return new Response('', { status: 302, headers: { location: signed } })
    return new Response('\\documentclass{article}\n', { headers: { 'content-type': 'text/plain' } })
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, '\\documentclass{article}\n')
  assert.deepEqual(calls[0].init.headers, {
    accept: 'text/plain, application/octet-stream', 'cache-control': 'no-cache',
    cookie: 'SESSION=synthetic', authorization: 'Bearer synthetic', 'user-agent': 'agent',
  })
  assert.equal(calls[1].init.credentials, 'omit')
  assert.equal('cookie' in calls[1].init.headers, false)
})

test('TeX readback refuses HTML and non-GET requests', async () => {
  const html = new Sink()
  await serveTexpageTex(request(), html, target, {}, async (_url, _init) => new Response('<html>login</html>', {
    headers: { 'content-type': 'text/plain' },
  }))
  assert.equal(html.statusCode, 502)
  assert.equal(html.headers['x-dsh-tex-error'], 'body-mime')

  const post = new Sink()
  await serveTexpageTex(request('POST'), post, target, {}, async () => { throw new Error('must not fetch') })
  assert.equal(post.statusCode, 405)
  assert.equal(post.headers.allow, 'GET')
})

test('TeX readback enforces the 4 MiB limit', async () => {
  const res = new Sink()
  await serveTexpageTex(request(), res, target, {}, async () => new Response('x', {
    headers: { 'content-type': 'text/plain', 'content-length': String(4 * 1024 * 1024 + 1) },
  }))
  assert.equal(res.statusCode, 502)
  assert.equal(res.headers['x-dsh-tex-error'], 'body-size')
})
