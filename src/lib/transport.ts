// Relay transport. Every payload is AES-256-GCM ciphertext before it gets here.
// Events use an ephemeral kind (20000-29999), which relays forward live and do not store.
// Each event is signed by a fresh throwaway key, so relays cannot link events to a person.
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure'

// Only relays verified to accept, deliver live, and NOT store or replay ephemeral events.
export const RELAYS = [
  'wss://relay.snort.social',
  'wss://nostr-pub.wellorder.net',
]

const KIND = 20455
const MAX_CONTENT = 32768

type Listener = (content: string) => void

interface Sub { id: string; tag: string; listener: Listener }

interface Conn { url: string; ws: WebSocket | null; queue: string[]; retry: number; closed: boolean }

const subs = new Map<string, Sub>()
const conns = new Map<string, Conn>()
const seen = new Set<string>()

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')
}

function reqFrame(sub: Sub): string {
  return JSON.stringify(['REQ', sub.id, { kinds: [KIND], '#z': [sub.tag], since: Math.floor(Date.now() / 1000) }])
}

function sendRaw(conn: Conn, frame: string) {
  if (conn.ws && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(frame)
  else conn.queue.push(frame)
}

function connect(conn: Conn) {
  if (conn.closed) return
  let ws: WebSocket
  try { ws = new WebSocket(conn.url) } catch { scheduleReconnect(conn); return }
  conn.ws = ws
  ws.onopen = () => {
    conn.retry = 0
    subs.forEach(s => ws.send(reqFrame(s)))
    const pending = conn.queue.filter(f => !f.startsWith('["REQ"'))
    conn.queue = []
    pending.forEach(f => ws.send(f))
  }
  ws.onmessage = (e: MessageEvent) => {
    let msg: unknown
    try { msg = JSON.parse(e.data as string) } catch { return }
    if (!Array.isArray(msg) || msg[0] !== 'EVENT') return
    const sub = subs.get(msg[1] as string)
    const ev = msg[2] as { id?: string; kind?: number; content?: string; tags?: string[][] }
    if (!sub || !ev || ev.kind !== KIND || typeof ev.id !== 'string' || typeof ev.content !== 'string') return
    if (ev.content.length > MAX_CONTENT) return
    if (!ev.tags?.some(t => t[0] === 'z' && t[1] === sub.tag)) return
    const seenKey = sub.id + ':' + ev.id
    if (seen.has(seenKey)) return
    seen.add(seenKey)
    if (seen.size > 5000) seen.clear()
    sub.listener(ev.content)
  }
  ws.onclose = () => { conn.ws = null; scheduleReconnect(conn) }
  ws.onerror = () => { try { ws.close() } catch { /* already closed */ } }
}

function scheduleReconnect(conn: Conn) {
  if (conn.closed) return
  const delay = Math.min(30000, 1000 * 2 ** conn.retry++)
  setTimeout(() => connect(conn), delay)
}

// No relay connection is ever opened until Tor has been confirmed, so no IP leaks.
let networkAllowed = false

export function allowNetwork() {
  networkAllowed = true
}

function ensureConnected() {
  if (!networkAllowed) return
  for (const url of RELAYS) {
    if (conns.has(url)) continue
    const conn: Conn = { url, ws: null, queue: [], retry: 0, closed: false }
    conns.set(url, conn)
    connect(conn)
  }
}

export function publish(tag: string, content: string) {
  if (!networkAllowed) return
  ensureConnected()
  const event = finalizeEvent(
    { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [['z', tag]], content },
    generateSecretKey(),
  )
  const frame = JSON.stringify(['EVENT', event])
  conns.forEach(c => sendRaw(c, frame))
}

export function subscribe(tag: string, listener: Listener): () => void {
  ensureConnected()
  const sub: Sub = { id: 'z' + randomId(), tag, listener }
  subs.set(sub.id, sub)
  const frame = reqFrame(sub)
  conns.forEach(c => { if (c.ws?.readyState === WebSocket.OPEN) c.ws.send(frame) })
  return () => {
    subs.delete(sub.id)
    const close = JSON.stringify(['CLOSE', sub.id])
    conns.forEach(c => { if (c.ws?.readyState === WebSocket.OPEN) c.ws.send(close) })
  }
}

export function connectedRelayCount(): number {
  let n = 0
  conns.forEach(c => { if (c.ws?.readyState === WebSocket.OPEN) n++ })
  return n
}

export function warmUp() {
  ensureConnected()
}

export function destroy() {
  subs.clear()
  seen.clear()
  conns.forEach(c => { c.closed = true; c.queue = []; try { c.ws?.close() } catch { /* already closed */ } })
  conns.clear()
}

export async function hashChannel(roomId: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-512', new TextEncoder().encode('cc-ch:' + roomId))
  return Array.from(new Uint8Array(hash).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')
}
