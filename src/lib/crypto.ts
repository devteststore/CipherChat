export interface RoomData {
  id: string
  name: string
  participants: string[]
  createdAt: number
  version: number
  roomSecret: string // 512-bit hex — the actual encryption key material
}

const INVITE_INFO = new TextEncoder().encode('zechat-invite')
const MEMO_INFO = new TextEncoder().encode('zechat-memo')
const TRANSPORT_INFO = new TextEncoder().encode('zechat-transport')

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

export function generateRoomId(): string {
  return uint8ToHex(crypto.getRandomValues(new Uint8Array(16)))
}

// --- Invite code ---
// The memo carries only a 20-digit code: digits survive wallet font substitution.
// Key and relay channel are derived from code + recipient address, so the code is
// useless with any other wallet address. PBKDF2 makes guessing the code expensive.
const INVITE_CODE_DIGITS = 20
const INVITE_PBKDF2_ITERATIONS = 310000

export interface InviteKeys {
  key: CryptoKey
  tag: string
}

export function generateInviteCode(): string {
  const digits: number[] = []
  while (digits.length < INVITE_CODE_DIGITS) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < 250 && digits.length < INVITE_CODE_DIGITS) digits.push(b % 10)
    }
  }
  return formatInviteCode(digits.join(''))
}

export function formatInviteCode(digits: string): string {
  return digits.match(/.{1,4}/g)!.join('-')
}

// Wallet fonts can turn 0 into O and 1 into l/I; map those back, drop everything else.
export function normalizeInviteCode(input: string): string | null {
  const digits = input
    .replace(/[OoОоΟο]/g, '0')
    .replace(/[IlІ|]/g, '1')
    .replace(/[^0-9]/g, '')
  return digits.length === INVITE_CODE_DIGITS ? digits : null
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase()
}

export async function deriveInviteKeys(code: string, address: string): Promise<InviteKeys> {
  const digits = normalizeInviteCode(code)
  if (!digits) throw new Error('invalid invite code')
  const salt = new Uint8Array(await crypto.subtle.digest(
    'SHA-512', new TextEncoder().encode('zechat-invite-v1|' + normalizeAddress(address)),
  ))
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(digits), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: INVITE_PBKDF2_ITERATIONS, hash: 'SHA-512' }, material, 512,
  ))
  const key = await hkdfDeriveKey(bits.slice(0, 32), salt, INVITE_INFO)
  const tagHash = new Uint8Array(await crypto.subtle.digest('SHA-256', bits.slice(32)))
  const tag = uint8ToHex(tagHash.slice(0, 16))
  secureWipe(bits)
  secureWipe(tagHash)
  return { key, tag }
}

// Padding hides message length from relays. JSON.parse ignores trailing spaces.
const PAD_BUCKETS = [512, 2048, 8192, 16384]

function padToBucket(bytes: Uint8Array): Uint8Array {
  const size = PAD_BUCKETS.find(b => b >= bytes.length) ?? bytes.length
  if (size === bytes.length) return bytes
  const out = new Uint8Array(size).fill(0x20)
  out.set(bytes, 0)
  secureWipe(bytes)
  return out
}

export async function encryptJson(value: unknown, key: CryptoKey, pad = false): Promise<string> {
  let plaintext: Uint8Array = new TextEncoder().encode(JSON.stringify(value))
  if (pad) plaintext = padToBucket(plaintext)
  const encrypted = await aesEncrypt(plaintext, key)
  secureWipe(plaintext)
  return uint8ToBase64(encrypted)
}

// Outer layer for room traffic, so relays do not see the key epoch.
export async function deriveTransportKey(roomSecret: string): Promise<CryptoKey> {
  const secretBytes = hexToUint8(roomSecret)
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-512', new TextEncoder().encode('zechat-transport-salt')))
  const key = await hkdfDeriveKey(secretBytes, salt, TRANSPORT_INFO)
  secureWipe(secretBytes)
  return key
}

export async function decryptJson<T>(data: string, key: CryptoKey): Promise<T> {
  const plaintext = await aesDecrypt(base64ToUint8(data), key)
  const value = JSON.parse(new TextDecoder().decode(plaintext)) as T
  secureWipe(plaintext)
  return value
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
