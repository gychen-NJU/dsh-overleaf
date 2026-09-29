import test from 'node:test'
import assert from 'node:assert/strict'
import { observeSocketPacket, evaluateSiteSockets } from './desktop-socket-verdict.mjs'

function healthy(overrides = {}) {
  return { opened: true, requestedNamespace: '/', confirmedNamespace: '/', connectedAt: 1000,
    pings: 2, pongs: 2, pingInterval: 25000, ...overrides }
}
test('site failure cannot borrow successful probe handshake or heartbeats', () => {
  assert.equal(evaluateSiteSockets([healthy({ closed: true, namespaceError: '/bad' }), healthy({ byProbe: true })], 52000).pass, false)
})
test('construction and engine open alone are insufficient', () => {
  assert.equal(evaluateSiteSockets([{ opened: true }], 52000).pass, false)
})
test('same site namespace must remain open for two complete heartbeat intervals', () => {
  assert.equal(evaluateSiteSockets([healthy()], 52000).pass, true)
  for (const changes of [{ confirmedNamespace: '/other' }, { pongs: 1 }, { closed: true }, { error: 'failed' }]) {
    assert.equal(evaluateSiteSockets([healthy(changes)], 52000).pass, false)
  }
  assert.equal(evaluateSiteSockets([healthy()], 50000).pass, false)
})
test('packet recording retains metadata only, no sid, auth or document payload', () => {
  const state = { opened: true }
  for (const [direction, packet] of [['received', '0{"sid":"secret","pingInterval":25000}'],
    ['sent', '40/editor,{"token":"secret"}'], ['received', '40/editor,{"sid":"secret"}'],
    ['received', '2'], ['sent', '3'], ['received', '2'], ['sent', '3'], ['received', '42["update","private document"]']]) {
    observeSocketPacket(state, direction, packet, 1000)
  }
  assert.equal(evaluateSiteSockets([state], 52000).pass, true)
  assert.ok(!JSON.stringify(state).includes('secret'))
  assert.ok(!JSON.stringify(state).includes('private document'))
  observeSocketPacket(state, 'received', '44/editor,{"message":"Invalid namespace"}')
  assert.equal(evaluateSiteSockets([state], 52000).pass, false)
})
