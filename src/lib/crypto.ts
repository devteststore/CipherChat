export interface RoomData {
  id: string
  name: string
  participants: string[]
  createdAt: number
  version: number
  chain: string       // base64 chain key for chainEpoch; cleared once loaded into a KeyRing
  chainEpoch: number
}

const INVITE_INFO = new TextEncoder().encode('cipherchat-invite')
const MEMO_INFO = new TextEncoder().encode('cipherchat-memo')
const SESSION_INFO = new TextEncoder().encode('cipherchat-session')
const CHAIN_NEXT = new TextEncoder().encode('cipherchat-chain-next')

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

async function sha512(...parts: Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const buf = new Uint8Array(total)
  let off = 0
  for (const p of parts) { buf.set(p, off); off += p.length }
  const out = new Uint8Array(await crypto.subtle.digest('SHA-512', buf))
  secureWipe(buf)
  return out
}

export function secureWipe(arr: Uint8Array) {
  crypto.getRandomValues(arr)
  arr.fill(0)
}

export function generateRoomId(): string {
  return uint8ToHex(crypto.getRandomValues(new Uint8Array(16)))
}

// --- Forward-secret message keys ---
// Time is split into epochs. Each epoch's chain key is SHA-512 of the previous one, and
// old chain keys are erased as time moves on, so past message keys cannot be rebuilt
// from anything still in memory. New members receive the chain from the current
// window only, so they cannot read anything sent before they joined.
export const EPOCH_MS = 120_000
const WINDOW = 3

export function currentEpoch(now = Date.now()): number {
  return Math.floor(now / EPOCH_MS)
}

export class KeyRing {
  private chain: Uint8Array
  private base: number
  private keys = new Map<number, Promise<CryptoKey>>()
  private destroyed = false

  constructor(chain: Uint8Array, base: number) {
    this.chain = chain.slice()
    this.base = base
  }

  static create(): KeyRing {
    const chain = crypto.getRandomValues(new Uint8Array(64))
    const ring = new KeyRing(chain, currentEpoch() - 1)
    secureWipe(chain)
    return ring
  }

  static fromExport(chain: string, epoch: number): KeyRing {
    const bytes = base64ToUint8(chain)
    const ring = new KeyRing(bytes, epoch)
    secureWipe(bytes)
    return ring
  }

  get oldestEpoch(): number {
    return this.base
  }

  epochs(): number[] {
    return Array.from({ length: WINDOW + 1 }, (_, i) => this.base + i)
  }

  keyFor(epoch: number): Promise<CryptoKey> | null {
    if (this.destroyed || epoch < this.base || epoch > this.base + WINDOW) return null
    let key = this.keys.get(epoch)
    if (!key) {
      const start = this.chain.slice()
      const from = this.base
      key = (async () => {
        let c = start
        for (let i = from; i < epoch; i++) {
          const n = await sha512(c, CHAIN_NEXT)
          secureWipe(c)
          c = n
        }
        const salt = await sha512(new TextEncoder().encode('cipherchat-epoch:' + epoch))
        const k = await hkdfDeriveKey(c, salt, MEMO_INFO)
        secureWipe(c)
        return k
      })()
      this.keys.set(epoch, key)
    }
    return key
  }

  async advance(toBase: number): Promise<void> {
    if (this.destroyed || toBase <= this.base) return
    let c = this.chain.slice()
    for (let i = this.base; i < toBase; i++) {
      const n = await sha512(c, CHAIN_NEXT)
      secureWipe(c)
      c = n
    }
    if (this.destroyed || toBase <= this.base) { secureWipe(c); return }
    secureWipe(this.chain)
    this.chain = c
    this.base = toBase
    for (const e of [...this.keys.keys()]) if (e < toBase) this.keys.delete(e)
  }

  export(): { chain: string; epoch: number } {
    return { chain: uint8ToBase64(this.chain), epoch: this.base }
  }

  destroy() {
    this.destroyed = true
    secureWipe(this.chain)
    this.keys.clear()
  }
}

// --- One-time key exchange for the invite handshake ---
// Private keys are non-extractable and dropped after use, so a recorded handshake
// cannot be decrypted later even by someone who obtains the invite code.
export interface Ephemeral {
  privateKey: CryptoKey
  publicKey: string
}

export async function generateEphemeral(): Promise<Ephemeral> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { privateKey: pair.privateKey, publicKey: uint8ToBase64(raw) }
}

export async function deriveSessionKey(own: CryptoKey, peerPublic: string, guestPublic: string, hostPublic: string, context: string): Promise<CryptoKey> {
  const peerRaw = base64ToUint8(peerPublic)
  if (peerRaw.length !== 65) throw new Error('bad public key')
  const peer = await crypto.subtle.importKey('raw', peerRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, own, 256))
  const salt = await sha512(new TextEncoder().encode(`cipherchat-session|${context}|${guestPublic}|${hostPublic}`))
  const key = await hkdfDeriveKey(shared, salt, SESSION_INFO)
  secureWipe(shared)
  return key
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
    'SHA-512', new TextEncoder().encode('cipherchat-invite-v1|' + normalizeAddress(address)),
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

// Short value both sides can compare on screen: equal only if code AND address match.
// Derived from the relay channel tag, which relays already see, so it reveals nothing new.
export async function inviteCheckCode(tag: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('cipherchat-check|' + tag)))
  return uint8ToHex(h.slice(0, 2)).toUpperCase()
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

export async function decryptJson<T>(data: string, key: CryptoKey): Promise<T> {
  const plaintext = await aesDecrypt(base64ToUint8(data), key)
  const value = JSON.parse(new TextDecoder().decode(plaintext)) as T
  secureWipe(plaintext)
  return value
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

export function base64ToUint8(str: string): Uint8Array<ArrayBuffer> {
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function uint8ToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
