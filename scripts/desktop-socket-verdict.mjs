// Shared by the real renderer tap and offline acceptance tests. Never retain
// packet payloads: project contents, authentication data and session IDs stay out.
export function observeSocketPacket(state, direction, data, now = Date.now()) {
  if (typeof data !== 'string') return
  if (direction === 'received' && data[0] === '0') {
    try {
      const hello = JSON.parse(data.slice(1))
      if (Number.isFinite(hello.pingInterval) && hello.pingInterval > 0) state.pingInterval = hello.pingInterval
    } catch {}
  }
  if (direction === 'received' && data === '2') state.pings = (state.pings || 0) + 1
  if (direction === 'sent' && data === '3') state.pongs = (state.pongs || 0) + 1
  if (!/^4[014]/.test(data)) return
  const type = data[1]
  const rest = data.slice(2)
  const namespace = rest.startsWith('/') ? rest.split(',', 1)[0].slice(0, 256) : '/'
  if (direction === 'sent' && type === '0') state.requestedNamespace = namespace
  if (direction === 'received' && type === '0') {
    state.confirmedNamespace = namespace
    state.connectedAt = now
  }
  if (direction === 'received' && type === '4') state.namespaceError = namespace
  if (direction === 'received' && type === '1') state.disconnected = true
}

export function evaluateSiteSockets(records, now = Date.now()) {
  const site = records.filter(r => !r.byProbe && !r.bridgeOnly)
  const healthy = site.filter(r => r.opened && !r.closed && !r.error && !r.namespaceError && !r.disconnected &&
    r.requestedNamespace !== undefined && r.requestedNamespace === r.confirmedNamespace &&
    r.pings >= 2 && r.pongs >= 2 && r.pingInterval > 0 && now - r.connectedAt >= 2 * r.pingInterval)
  return { pass: healthy.length > 0, siteCount: site.length, healthyCount: healthy.length,
    reason: healthy.length ? 'site namespace confirmed and open for two heartbeat intervals' :
      'no site connection has a confirmed namespace and two healthy heartbeat intervals' }
}
