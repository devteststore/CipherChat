// Encrypted transport — all metadata is inside the encrypted payload.
// The channel only sees opaque blobs with random IDs.

const CHANNEL_NAME = 'zc-' + Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 24)

export interface TransportEnvelope {
  id: string      // random message ID
  ch: string      // hashed channel identifier (not the room ID)
  data: string    // encrypted payload — everything else is inside here
}

export interface ChatPayload {
  type: 'chat'
  from: string
  senderIndex: number
  payload: string   // encrypted message (base64)
  timestamp: number
}

type Listener = (envelope: TransportEnvelope) => void

let channel: BroadcastChannel | null = null
const listeners = new Set<Listener>()

function ensureChannel() {
  if (channel) return channel
  channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = (e: MessageEvent<TransportEnvelope>) => {
    listeners.forEach(fn => fn(e.data))
  }
  return channel
}

export function send(envelope: TransportEnvelope) {
  ensureChannel().postMessage(envelope)
  listeners.forEach(fn => fn(envelope))
}

export function subscribe(fn: Listener): () => void {
  ensureChannel()
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function destroy() {
  listeners.clear()
  channel?.close()
  channel = null
}

// Hash the room ID so the transport channel doesn't reveal it
export async function hashChannel(roomId: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-512', new TextEncoder().encode('zc-ch:' + roomId))
  return Array.from(new Uint8Array(hash).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')
}
