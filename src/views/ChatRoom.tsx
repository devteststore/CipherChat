import { useState, useEffect, useRef, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import type { RoomData } from '../lib/crypto'
import {
  deriveMemoKey, deriveTransportKey, getEpoch, isValidZcashAddress, normalizeAddress,
  generateInviteCode, deriveInviteKeys, encryptJson, decryptJson,
} from '../lib/crypto'
import { publish, subscribe, hashChannel } from '../lib/transport'

const QR_PREFIX = '\x00QR:'
const MAX_EPOCH = 100000

interface Message {
  id: string
  senderAddress: string
  text: string
  timestamp: number
  system?: boolean
}

interface WirePayload {
  t: 'chat' | 'join'
  id: string
  from: string
  text?: string
  ts: number
}

interface WireEnvelope {
  e: number
  d: string
}

export interface InviteRequest {
  t: 'req'
  n: string
}

export interface InviteReply {
  t: 'room'
  n: string
  id: string
  name: string
  secret: string
  participants: string[]
}

interface Props {
  room: RoomData
  myAddress: string
  announceJoin: boolean
  onLeave: () => void
  onRoomUpdated: (room: RoomData) => void
}

function getRole(senderIndex: number, isMe: boolean): { label: string; cls: string } {
  if (isMe) return { label: 'you', cls: 'role-you' }
  if (senderIndex === 0) return { label: 'creator', cls: 'role-creator' }
  return { label: 'guest', cls: 'role-guest' }
}

function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ZIP-321: memo param is base64url of the memo bytes; the memo text is the invite code.
function buildZcashUri(address: string, memo?: string, amount?: string): string {
  const amt = amount || '0.00001'
  if (!memo) return `zcash:${address}?amount=${amt}`
  return `zcash:${address}?amount=${amt}&memo=${toBase64Url(memo)}`
}

export function ChatRoom({ room, myAddress, announceJoin, onLeave, onRoomUpdated }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [addingMember, setAddingMember] = useState('')
  const [inviteSending, setInviteSending] = useState(false)
  const [inviteError, setInviteError] = useState('')
  const [pendingInvite, setPendingInvite] = useState<{ recipient: string; code: string } | null>(null)
  const [channelHash, setChannelHash] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const [sendZecStep, setSendZecStep] = useState<'closed' | 'amount' | 'recipient' | 'qr'>('closed')
  const [zecAmount, setZecAmount] = useState('')
  const [zecRecipient, setZecRecipient] = useState('')

  const roomRef = useRef(room)
  roomRef.current = room
  const onRoomUpdatedRef = useRef(onRoomUpdated)
  onRoomUpdatedRef.current = onRoomUpdated
  const keyCache = useRef(new Map<number, Promise<CryptoKey>>())
  const transportKey = useRef<Promise<CryptoKey> | null>(null)
  if (!transportKey.current) transportKey.current = deriveTransportKey(room.roomSecret)
  const sentCount = useRef(0)
  const invites = useRef(new Map<string, () => void>())

  const myIndex = room.participants.indexOf(myAddress)

  const keyFor = useCallback((epoch: number) => {
    let p = keyCache.current.get(epoch)
    if (!p) {
      p = deriveMemoKey(roomRef.current.roomSecret, epoch)
      keyCache.current.set(epoch, p)
    }
    return p
  }, [])

  const addParticipant = useCallback((addr: string) => {
    const current = roomRef.current
    if (current.participants.includes(addr)) return
    const updated: RoomData = { ...current, participants: [...current.participants, addr], version: current.version + 1 }
    roomRef.current = updated
    onRoomUpdatedRef.current(updated)
  }, [])

  const retireInvite = useCallback((addr: string) => {
    const unsub = invites.current.get(addr)
    if (!unsub) return
    unsub()
    invites.current.delete(addr)
    setPendingInvite(p => (p?.recipient === addr ? null : p))
  }, [])

  useEffect(() => {
    hashChannel(room.id).then(setChannelHash)
  }, [room.id])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendPayload = useCallback(async (payload: WirePayload) => {
    const epoch = getEpoch(sentCount.current++)
    const key = await keyFor(epoch)
    const envelope: WireEnvelope = { e: epoch, d: await encryptJson(payload, key) }
    publish(channelHash, await encryptJson(envelope, await transportKey.current!, true))
  }, [channelHash, keyFor])

  useEffect(() => {
    if (!channelHash) return
    const unsub = subscribe(channelHash, async content => {
      try {
        const env = await decryptJson<WireEnvelope>(content, await transportKey.current!)
        if (!Number.isInteger(env.e) || env.e < 0 || env.e > MAX_EPOCH || typeof env.d !== 'string') return
        const payload = await decryptJson<WirePayload>(env.d, await keyFor(env.e))
        if (typeof payload.from !== 'string' || !isValidZcashAddress(payload.from)) return
        if (typeof payload.id !== 'string' || typeof payload.ts !== 'number') return
        if (payload.from === myAddress) return

        if (payload.t === 'join') {
          addParticipant(payload.from)
          retireInvite(payload.from)
          setMessages(prev => prev.some(m => m.id === payload.id) ? prev : [...prev, {
            id: payload.id, senderAddress: '', text: `${truncate(payload.from)} joined`, timestamp: payload.ts, system: true,
          }])
          return
        }

        if (payload.t === 'chat' && typeof payload.text === 'string') {
          addParticipant(payload.from)
          const text = payload.text.slice(0, 2000)
          setMessages(prev => prev.some(m => m.id === payload.id) ? prev : [...prev, {
            id: payload.id, senderAddress: payload.from, text, timestamp: payload.ts,
          }])
        }
      } catch { /* not decryptable with this room's keys */ }
    })
    return unsub
  }, [channelHash, myAddress, keyFor, addParticipant, retireInvite])

  useEffect(() => {
    if (!channelHash || !announceJoin) return
    sendPayload({ t: 'join', id: crypto.randomUUID(), from: myAddress, ts: Math.floor(Date.now() / 1000) }).catch(() => {})
  }, [channelHash, announceJoin, myAddress, sendPayload])

  useEffect(() => {
    const active = invites.current
    return () => {
      active.forEach(unsub => unsub())
      active.clear()
    }
  }, [])

  const postMessage = useCallback(async (text: string) => {
    if (!channelHash || myIndex === -1) return
    const payload: WirePayload = { t: 'chat', id: crypto.randomUUID(), from: myAddress, text, ts: Math.floor(Date.now() / 1000) }
    await sendPayload(payload)
    setMessages(prev => [...prev, { id: payload.id, senderAddress: myAddress, text, timestamp: payload.ts }])
  }, [channelHash, myIndex, myAddress, sendPayload])

  async function handleSend() {
    const text = input.trim()
    if (!text) return
    setSending(true)
    try {
      await postMessage(text)
      setInput('')
    } catch { /* send failed */ } finally {
      setSending(false)
    }
  }

  async function handleGiveQR() {
    setSending(true)
    try { await postMessage(QR_PREFIX + myAddress) } catch { /* send failed */ } finally { setSending(false) }
  }

  async function handleInvite() {
    const addr = normalizeAddress(addingMember)
    setInviteError('')
    if (!isValidZcashAddress(addr)) { setInviteError('not a valid u1 shielded address.'); return }
    if (addr === myAddress || room.participants.includes(addr)) { setInviteError('this address is already in the chat.'); return }

    setInviteSending(true)
    try {
      retireInvite(addr)
      const code = generateInviteCode()
      const { key, tag } = await deriveInviteKeys(code, addr)

      const unsub = subscribe(tag, async content => {
        try {
          const req = await decryptJson<InviteRequest>(content, key)
          if (req.t !== 'req' || typeof req.n !== 'string') return
          const current = roomRef.current
          const reply: InviteReply = {
            t: 'room', n: req.n, id: current.id, name: current.name,
            secret: current.roomSecret, participants: current.participants,
          }
          publish(tag, await encryptJson(reply, key, true))
        } catch { /* not a request for this invite */ }
      })
      invites.current.set(addr, unsub)

      setPendingInvite({ recipient: addr, code })
      setAddingMember('')
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), senderAddress: '', text: `invite ready for ${truncate(addr)} — keep this chat open until they join`,
        timestamp: Math.floor(Date.now() / 1000), system: true,
      }])
    } catch {
      setInviteError('could not create invite.')
    } finally {
      setInviteSending(false)
    }
  }

  function handleEndChat() {
    setMessages([])
    setInput('')
    setPendingInvite(null)
    onLeave()
  }

  function startSendZec() {
    setSendZecStep('amount')
    setZecAmount('')
    setZecRecipient('')
  }

  function confirmZecAmount() {
    const amt = parseFloat(zecAmount)
    if (!amt || amt <= 0) return
    setSendZecStep('recipient')
  }

  function selectZecRecipient(addr: string) {
    setZecRecipient(addr)
    setSendZecStep('qr')
  }

  function closeSendZec() {
    setSendZecStep('closed')
    setZecAmount('')
    setZecRecipient('')
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 10000)
    }).catch(() => {})
  }

  return (
    <div className="view chat-view chat-active">
      <div className="sealed-bar">
        <span className="sealed-icon" />
        encrypted &middot; ephemeral &middot; zero persistence
      </div>

      <div className="chat-header">
        <div className="chat-header-left">
          <div>
            <h2>{room.name}</h2>
            <button className="member-toggle" onClick={() => setShowMembers(!showMembers)}>
              {room.participants.length} member{room.participants.length !== 1 ? 's' : ''} {showMembers ? '[-]' : '[+]'}
            </button>
          </div>
        </div>
        <div className="chat-header-right">
          <span className="badge badge-mainnet">mainnet</span>
          <button onClick={handleEndChat} className="btn-danger btn-small">
            end chat
          </button>
        </div>
      </div>

      {showMembers && (
        <div className="members-panel">
          <h3>Members</h3>
          <ul className="member-list">
            {room.participants.map((addr, i) => (
              <li key={addr} className="member-item">
                <span className={`member-dot color-${i % 6}`} />
                <code className="address-small">{truncate(addr)}</code>
                {addr === myAddress && <span className="badge">you</span>}
                {i === 0 && <span className="badge" style={{ borderColor: 'rgba(0,255,136,0.3)', color: 'var(--primary)' }}>creator</span>}
                {i > 0 && addr !== myAddress && <span className="badge badge-dim">guest</span>}
              </li>
            ))}
          </ul>

          <div className="invite-section">
            <h4>invite via shielded memo</h4>
            <p className="hint">
              enter their shielded address. the invite only works for that wallet.
            </p>
            <div className="input-group input-group-small">
              <input
                type="text"
                value={addingMember}
                onChange={e => setAddingMember(e.target.value)}
                placeholder="shielded address to invite..."
                className="input-address"
                spellCheck={false}
                autoComplete="off"
                onKeyDown={e => e.key === 'Enter' && handleInvite()}
              />
              <button
                onClick={handleInvite}
                disabled={!addingMember.trim() || inviteSending}
                className="btn-primary btn-small"
              >
                {inviteSending ? '...' : 'invite'}
              </button>
            </div>
            {inviteError && <p className="error-text">{inviteError}</p>}
          </div>
        </div>
      )}

      {pendingInvite && (
        <div className="outgoing-memo-panel">
          <div className="outgoing-memo-header">
            <h4>send invite from your wallet</h4>
            <button onClick={() => setPendingInvite(null)} className="btn-icon">x</button>
          </div>
          <div className="outgoing-recipient">
            <div className="outgoing-qr">
              <QRCodeSVG
                value={buildZcashUri(pendingInvite.recipient, pendingInvite.code)}
                size={160}
                bgColor="#ffffff"
                fgColor="#000000"
                level="M"
              />
            </div>
            <div className="outgoing-details">
              <div className="outgoing-field">
                <span className="step-label">to</span>
                <code className="address-truncated">{truncate(pendingInvite.recipient)}</code>
              </div>
              <div className="outgoing-field">
                <span className="step-label">amount</span>
                <code className="outgoing-amount">0.00001 ZEC</code>
              </div>
            </div>
          </div>
          <p className="outgoing-hint">
            scan with your zcash wallet and send. keep this chat open — they can only join while you are here.
          </p>
        </div>
      )}

      {sendZecStep !== 'closed' && (
        <div className="send-zec-panel">
          <div className="outgoing-memo-header">
            <h4>
              {sendZecStep === 'amount' && 'enter amount'}
              {sendZecStep === 'recipient' && 'select recipient'}
              {sendZecStep === 'qr' && 'scan to send'}
            </h4>
            <button onClick={closeSendZec} className="btn-icon">x</button>
          </div>

          {sendZecStep === 'amount' && (
            <div className="send-zec-amount">
              <div className="input-group">
                <input
                  type="number"
                  value={zecAmount}
                  onChange={e => setZecAmount(e.target.value)}
                  placeholder="0.001"
                  className="input-address"
                  step="0.0001"
                  min="0.0001"
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && confirmZecAmount()}
                />
                <span className="zec-unit">ZEC</span>
              </div>
              <button
                onClick={confirmZecAmount}
                disabled={!zecAmount || parseFloat(zecAmount) <= 0}
                className="btn-primary btn-small"
                style={{ marginTop: 8, width: '100%' }}
              >
                [ next ]
              </button>
            </div>
          )}

          {sendZecStep === 'recipient' && (
            <div className="send-zec-recipients">
              <p className="hint">select who to send {zecAmount} ZEC to:</p>
              {room.participants
                .filter(addr => addr !== myAddress)
                .map(addr => {
                  const realIdx = room.participants.indexOf(addr)
                  return (
                    <button
                      key={addr}
                      onClick={() => selectZecRecipient(addr)}
                      className="send-zec-member-btn"
                    >
                      <span className={`member-dot color-${realIdx % 6}`} />
                      <code>{truncate(addr)}</code>
                      <span className={`message-role ${realIdx === 0 ? 'role-creator' : 'role-guest'}`}>
                        {realIdx === 0 ? 'creator' : 'guest'}
                      </span>
                    </button>
                  )
                })}
              {room.participants.filter(a => a !== myAddress).length === 0 && (
                <p className="hint">no other members in this chat yet.</p>
              )}
            </div>
          )}

          {sendZecStep === 'qr' && zecRecipient && (
            <div className="send-zec-qr">
              <div className="outgoing-qr" style={{ margin: '0 auto' }}>
                <QRCodeSVG
                  value={buildZcashUri(zecRecipient, undefined, zecAmount)}
                  size={180}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="L"
                />
              </div>
              <div className="send-zec-details">
                <div className="outgoing-field">
                  <span className="step-label">to</span>
                  <div className="outgoing-value-row">
                    <code className="address-truncated">{truncate(zecRecipient)}</code>
                    <button onClick={() => copyToClipboard(zecRecipient)} className="btn-copy">copy</button>
                  </div>
                </div>
                <div className="outgoing-field">
                  <span className="step-label">amount</span>
                  <code className="outgoing-amount">{zecAmount} ZEC</code>
                </div>
                <button
                  onClick={() => copyToClipboard(buildZcashUri(zecRecipient, undefined, zecAmount))}
                  className="btn-copy-memo"
                >
                  copy payment uri
                </button>
              </div>
              <p className="outgoing-hint">
                scan this qr with your zcash wallet or copy the payment uri. shielded only.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="messages-container">
        {messages.length === 0 && (
          <div className="empty-chat">
            <p>end-to-end encrypted chat active.</p>
            <p className="hint">
              messages are encrypted with rotating keys.
              nothing is stored — when you leave, everything is gone.
            </p>
            <span className="cursor-blink" />
          </div>
        )}
        {messages.map(msg => {
          if (msg.system) {
            return (
              <div key={msg.id} className="message-system">
                <p>{msg.text}</p>
              </div>
            )
          }
          const senderIndex = room.participants.indexOf(msg.senderAddress)
          const isMe = msg.senderAddress === myAddress
          const role = getRole(senderIndex, isMe)
          const isQR = msg.text.startsWith(QR_PREFIX)
          const qrAddr = isQR ? msg.text.slice(QR_PREFIX.length) : ''
          return (
            <div key={msg.id} className={`message ${isMe ? 'message-mine' : 'message-other'}`}>
              <div className="message-sender-row">
                <span className={`message-sender color-${Math.max(senderIndex, 0) % 6}`}>
                  {isMe ? 'you' : truncate(msg.senderAddress)}
                </span>
                <span className={`message-role ${role.cls}`}>{role.label}</span>
              </div>
              <div className={`message-bubble ${isQR ? 'message-bubble-qr' : ''}`}>
                {isQR ? (
                  <div className="inline-qr">
                    <div className="inline-qr-code">
                      <QRCodeSVG
                        value={`zcash:${qrAddr}`}
                        size={120}
                        bgColor="#ffffff"
                        fgColor="#000000"
                        level="L"
                      />
                    </div>
                    <div className="inline-qr-info">
                      <span className="inline-qr-label">my wallet</span>
                      <code className="inline-qr-addr">{truncate(qrAddr)}</code>
                      <button onClick={() => copyToClipboard(qrAddr)} className="btn-copy" style={{ marginTop: 4 }}>copy address</button>
                    </div>
                  </div>
                ) : (
                  <p>{msg.text}</p>
                )}
                <span className="message-time">
                  {new Date(msg.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          )
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-bar">
        <button
          onClick={startSendZec}
          className="btn-send-zec"
          title="send zec"
          disabled={sendZecStep !== 'closed'}
        >
          Z
        </button>
        <button
          onClick={handleGiveQR}
          className="btn-give-qr"
          title="share your wallet qr"
          disabled={sending}
        >
          QR
        </button>
        <div className="chat-input-wrapper">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            placeholder="type a message..."
            className="chat-input"
            maxLength={2000}
            disabled={sending}
            autoComplete="off"
            autoFocus
          />
          {input.length > 0 && (
            <div className="typing-indicator">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          )}
        </div>
        <button onClick={handleSend} disabled={!input.trim() || sending} className="btn-send">
          {sending ? (
            <span className="spinner-small" />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}

function truncate(addr: string): string {
  if (addr.length <= 20) return addr
  return `${addr.slice(0, 10)}...${addr.slice(-8)}`
}
