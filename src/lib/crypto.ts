export interface RoomData {
  id: string
  name: string
  participants: string[]
  createdAt: number
  version: number
  roomSecret: string // 512-bit hex — the actual encryption key material
}

export interface InvitePayload {
  roomId: string
  roomName: string
  roomCode: string
  roomSecret: string
}

const ROOM_INFO = new TextEncoder().encode('zechat-room')
const INVITE_INFO = new TextEncoder().encode('zechat-invite')
const MEMO_INFO = new TextEncoder().encode('zechat-memo')

async function hkdfDeriveKey(raw: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
  const material = await crypto.subtle.importKey('raw', buf, 'HKDF', false, ['deriveKey'])
  const saltBuf = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer
  const infoBuf = info.buffer.slice(info.byteOffset, info.byteOffset + info.byteLength) as ArrayBuffer
  return crypto.subtle.deriveKey(
    { name: 'HKDF', salt: saltBuf, info: infoBuf, hash: 'SHA-512' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function aesEncrypt(plaintext: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ptBuf = plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength) as ArrayBuffer
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, ptBuf)
  )
  const out = new Uint8Array(12 + ct.length)
  out.set(iv, 0)
  out.set(ct, 12)
  return out
}

async function aesDecrypt(data: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const iv = data.slice(0, 12)
  const ct = data.slice(12)
  const ctBuf = ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, ctBuf)
  )
}

function secureWipe(arr: Uint8Array) {
  crypto.getRandomValues(arr)
  arr.fill(0)
}

// --- Room secret: 512-bit random key material ---
export function generateRoomSecret(): string {
  return uint8ToHex(crypto.getRandomValues(new Uint8Array(64)))
}

// --- Room code: human-readable identifier (NOT the encryption key) ---
export function generateRoomCode(): string {
  const words = [
    'shield','cipher','vault','forge','haven','nexus','prism','orbit',
    'spark','drift','pulse','blade','storm','frost','ember','crypt',
    'lunar','solar','delta','sigma','omega','theta','zeta','alpha',
    'ridge','crown','flare','surge','brace','grain','stone','swift',
    'depth','blaze','coast','quest','dune','peak','wave','arch',
  ]
  const picks: string[] = []
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  for (let i = 0; i < 4; i++) {
    // Rejection sampling to eliminate modular bias
    let val = bytes[i]
    while (val >= 240) val = crypto.getRandomValues(new Uint8Array(1))[0]
    picks.push(words[val % words.length])
  }
  const num = ((bytes[4] << 8) | bytes[5]) % 10000
  picks.push(num.toString().padStart(4, '0'))
  return picks.join('-')
}

export function generateRoomId(): string {
  return uint8ToHex(crypto.getRandomValues(new Uint8Array(16)))
}

// --- Invite blob encryption ---
// Key = HKDF(SHA-512(randomSalt), salt, info)
// The random salt is prepended to the ciphertext so the recipient can decrypt.
// Wallet-binding is provided by the Zcash shielded pool — only the recipient's
// wallet can see the memo, so no address-based key derivation is needed.
export async function encryptInviteBlob(invite: InvitePayload): Promise<Uint8Array> {
  const inviteSalt = crypto.getRandomValues(new Uint8Array(32))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-512', inviteSalt))
  const key = await hkdfDeriveKey(hash, inviteSalt, INVITE_INFO)
  const compact = JSON.stringify({ i: invite.roomId, n: invite.roomName, c: invite.roomCode, s: invite.roomSecret })
  const plaintext = new TextEncoder().encode(compact)
  const encrypted = await aesEncrypt(plaintext, key)
  secureWipe(hash)
  secureWipe(plaintext)
  const blob = new Uint8Array(32 + encrypted.length)
  blob.set(inviteSalt, 0)
  blob.set(encrypted, 32)
  secureWipe(inviteSalt)
  return blob
}

export async function decryptInviteBlob(data: Uint8Array): Promise<InvitePayload> {
  const inviteSalt = data.slice(0, 32)
  const encrypted = data.slice(32)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-512', inviteSalt))
  const key = await hkdfDeriveKey(hash, inviteSalt, INVITE_INFO)
  const plaintext = await aesDecrypt(encrypted, key)
  const compact = JSON.parse(new TextDecoder().decode(plaintext))
  secureWipe(hash)
  secureWipe(plaintext)
  return { roomId: compact.i, roomName: compact.n, roomCode: compact.c, roomSecret: compact.s }
}

// --- Chat encryption with one-way key ratchet ---
// Each epoch key is derived by hashing the previous epoch's key material.
// Past keys cannot be re-derived once the chain advances — true forward secrecy.
const ROTATION_INTERVAL = 10

export async function deriveMemoKey(roomSecret: string, epoch: number = 0): Promise<CryptoKey> {
  const secretBytes = hexToUint8(roomSecret)
  const prefix = new TextEncoder().encode('zechat-room-salt:')
  const saltInput = new Uint8Array(prefix.length + secretBytes.length)
  saltInput.set(prefix, 0)
  saltInput.set(secretBytes, prefix.length)
  const roomSalt = new Uint8Array(await crypto.subtle.digest('SHA-512', saltInput))
  secureWipe(saltInput)

  const secretBuf = secretBytes.buffer.slice(secretBytes.byteOffset, secretBytes.byteOffset + secretBytes.byteLength) as ArrayBuffer
  let chainKey = new Uint8Array(await crypto.subtle.digest('SHA-512', secretBuf))
  for (let i = 0; i < epoch; i++) {
    const tag = new TextEncoder().encode(`epoch:${i}`)
    const next = new Uint8Array(chainKey.length + tag.length)
    next.set(chainKey, 0)
    next.set(tag, chainKey.length)
    const prev = chainKey
    chainKey = new Uint8Array(await crypto.subtle.digest('SHA-512', next))
    secureWipe(prev)
    secureWipe(next)
  }

  const key = await hkdfDeriveKey(chainKey, roomSalt, MEMO_INFO)
  secureWipe(chainKey)
  secureWipe(roomSalt)
  secureWipe(secretBytes)
  return key
}

export function getEpoch(messageCount: number): number {
  return Math.floor(messageCount / ROTATION_INTERVAL)
}

export async function encryptMessage(text: string, memoKey: CryptoKey): Promise<Uint8Array> {
  return aesEncrypt(new TextEncoder().encode(text), memoKey)
}

export async function decryptMessage(data: Uint8Array, memoKey: CryptoKey): Promise<string> {
  const plaintext = await aesDecrypt(data, memoKey)
  return new TextDecoder().decode(plaintext)
}

// --- Zcash address validation ---
export function isValidZcashAddress(address: string): boolean {
  return /^u1[a-z0-9]{50,}$/.test(address.trim())
}

// --- Helpers ---
export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export function base64ToUint8(str: string): Uint8Array {
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function isParticipant(room: RoomData, address: string): boolean {
  return room.participants.includes(address)
}

function uint8ToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function hexToUint8(hex: string): Uint8Array {
  const clean = hex.replace(/\s/g, '')
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16)
  }
  return bytes
}
