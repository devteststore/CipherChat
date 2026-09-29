import { useState, useEffect, useRef, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import type { RoomData } from '../lib/crypto'
import {
  KeyRing, currentEpoch, isValidZcashAddress, normalizeAddress,
  generateInviteCode, deriveInviteKeys, encryptJson, decryptJson,
  generateEphemeral, deriveSessionKey,
} from '../lib/crypto'
import { publish, subscribe, hashChannel } from '../lib/transport'

const QR_PREFIX = '\x00QR:'
const INVITE_TTL_MS = 30 * 60 * 1000
const QR_VISIBLE_MS = 45 * 1000
const RING_TICK_MS = 15 * 1000

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

export interface InviteRequest {
  t: 'req'
  n: string
  pk: string
}

export interface InviteReply {
  t: 'room'
  n: string
  pk: string
  d: string
}

export interface RoomPayload {
  id: string
  name: string
  participants: string[]
  chain: string
  epoch: number
}

interface Invite {
  tag: string
  key: CryptoKey
  unsub: () => void
  timer: ReturnType<typeof setTimeout>
  request?: { n: string; pk: string }
  reply?: string
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
  const [qrVisible, setQrVisible] = useState(false)
  const [joinRequests, setJoinRequests] = useState<string[]>([])
  const [channelHash, setChannelHash] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const [sendZecStep, setSendZecStep] = useState<'closed' | 'amount' | 'recipient' | 'qr'>('closed')
  const [zecAmount, setZecAmount] = useState('')
  const [zecRecipient, setZecRecipient] = useState('')

  const roomRef = useRef(room)
  roomRef.current = room
  const onRoomUpdatedRef = useRef(onRoomUpdated)
  onRoomUpdatedRef.current = onRoomUpdated
  const ringRef = useRef<KeyRing | null>(null)
  if (!ringRef.current && room.chain) ringRef.current = KeyRing.fromExport(room.chain, room.chainEpoch)
  const pendingDestroy = useRef<ReturnType<typeof setTimeout> | null>(null)
  const invites = useRef(new Map<string, Invite>())

  const myIndex = room.participants.indexOf(myAddress)

  // Drop the exported chain from app state once it lives only inside the ring.
  useEffect(() => {
    if (roomRef.current.chain) {
      const cleared = { ...roomRef.current, chain: '' }
      roomRef.current = cleared
      onRoomUpdatedRef.current(cleared)
    }
  }, [])

  useEffect(() => {
    if (pendingDestroy.current) { clearTimeout(pendingDestroy.current); pendingDestroy.current = null }
    const ring = ringRef.current
    const tick = setInterval(() => { ring?.advance(currentEpoch() - 1) }, RING_TICK_MS)
    return () => {
      clearInterval(tick)
      pendingDestroy.current = setTimeout(() => ring?.destroy(), 0)
    }
  }, [])

  const addParticipant = useCallback((addr: string) => {
    const current = roomRef.current
    if (current.participants.includes(addr)) return
    const updated: RoomData = { ...current, participants: [...current.participants, addr], version: current.version + 1 }
    roomRef.current = updated
    onRoomUpdatedRef.current(updated)
  }, [])

  const retireInvite = useCallback((addr: string) => {
    const inv = invites.current.get(addr)
    if (!inv) return
    inv.unsub()
    clearTimeout(inv.timer)
    invites.current.delete(addr)
    setJoinRequests(r => r.filter(a => a !== addr))
    setPendingInvite(p => (p?.recipient === addr ? null : p))
  }, [])

  useEffect(() => {
    hashChannel(room.id).then(setChannelHash)
  }, [room.id])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!qrVisible) return
    const t = setTimeout(() => setQrVisible(false), QR_VISIBLE_MS)
    return () => clearTimeout(t)
  }, [qrVisible])

  const sendPayload = useCallback(async (payload: WirePayload) => {
    const ring = ringRef.current
    if (!ring || !channelHash) return
    const now = currentEpoch()
    await ring.advance(now - 1)
    const key = ring.keyFor(Math.max(now, ring.oldestEpoch))
    if (!key) return
    publish(channelHash, await encryptJson(payload, await key, true))
  }, [channelHash])

  useEffect(() => {
    if (!channelHash) return
    const unsub = subscribe(channelHash, async content => {
      const ring = ringRef.current
      if (!ring) return
      let payload: WirePayload | null = null
      for (const e of ring.epochs()) {
        const key = ring.keyFor(e)
        if (!key) continue
        try { payload = await decryptJson<WirePayload>(content, await key); break } catch { /* try next epoch */ }
      }
      if (!payload) return
      if (typeof payload.from !== 'string' || !isValidZcashAddress(payload.from)) return
      if (typeof payload.id !== 'string' || typeof payload.ts !== 'number') return
      if (payload.from === myAddress) return
      const p = payload

      if (p.t === 'join') {
        addParticipant(p.from)
        retireInvite(p.from)
        setMessages(prev => prev.some(m => m.id === p.id) ? prev : [...prev, {
          id: p.id, senderAddress: '', text: `${truncate(p.from)} joined`, timestamp: p.ts, system: true,
        }])
        return
      }

      if (p.t === 'chat' && typeof p.text === 'string') {
        addParticipant(p.from)
        const text = p.text.slice(0, 2000)
        setMessages(prev => prev.some(m => m.id === p.id) ? prev : [...prev, {
          id: p.id, senderAddress: p.from, text, timestamp: p.ts,
        }])
      }
    })
    return unsub
  }, [channelHash, myAddress, addParticipant, retireInvite])

  useEffect(() => {
    if (!channelHash || !announceJoin) return
    sendPayload({ t: 'join', id: crypto.randomUUID(), from: myAddress, ts: Math.floor(Date.now() / 1000) }).catch(() => {})
  }, [channelHash, announceJoin, myAddress, sendPayload])

  useEffect(() => {
    const active = invites.current
    return () => {
      active.forEach(inv => { inv.unsub(); clearTimeout(inv.timer) })
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
        const inv = invites.current.get(addr)
        if (!inv) return
        try {
          const req = await decryptJson<InviteRequest>(content, key)
          if (req.t !== 'req' || typeof req.n !== 'string' || typeof req.pk !== 'string') return
          if (inv.reply) {
            if (req.n === inv.request?.n) publish(tag, inv.reply)
            return
          }
          inv.request = { n: req.n, pk: req.pk }
          setJoinRequests(r => r.includes(addr) ? r : [...r, addr])
        } catch { /* not a request for this invite */ }
      })
      const timer = setTimeout(() => {
        retireInvite(addr)
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(), senderAddress: '', text: `invite for ${truncate(addr)} expired`,
          timestamp: Math.floor(Date.now() / 1000), system: true,
        }])
      }, INVITE_TTL_MS)
      invites.current.set(addr, { tag, key, unsub, timer })

      setPendingInvite({ recipient: addr, code })
      setQrVisible(false)
      setAddingMember('')
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), senderAddress: '', text: `invite ready for ${truncate(addr)} — keep this chat open until they join (expires in 30 min)`,
        timestamp: Math.floor(Date.now() / 1000), system: true,
      }])
    } catch {
      setInviteError('could not create invite.')
    } finally {
      setInviteSending(false)
    }
  }

  async function approveJoin(addr: string) {
    const inv = invites.current.get(addr)
    const ring = ringRef.current
    if (!inv?.request || inv.reply || !ring) return
    setJoinRequests(r => r.filter(a => a !== addr))
    try {
      await ring.advance(currentEpoch() - 1)
      const eph = await generateEphemeral()
      const sessionKey = await deriveSessionKey(eph.privateKey, inv.request.pk, inv.request.pk, eph.publicKey, inv.tag)
      const current = roomRef.current
      const snapshot = ring.export()
      const payload: RoomPayload = {
        id: current.id, name: current.name, participants: current.participants,
        chain: snapshot.chain, epoch: snapshot.epoch,
      }
      const reply: InviteReply = { t: 'room', n: inv.request.n, pk: eph.publicKey, d: await encryptJson(payload, sessionKey, true) }
      inv.reply = await encryptJson(reply, inv.key, true)
      publish(inv.tag, inv.reply)
      setPendingInvite(p => (p?.recipient === addr ? null : p))
    } catch {
      setInviteError('could not answer join request.')
    }
  }

  function rejectJoin(addr: string) {
    retireInvite(addr)
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(), senderAddress: '', text: `join request for ${truncate(addr)} rejected — invite cancelled`,
      timestamp: Math.floor(Date.now() / 1000), system: true,
    }])
  }

  function handleEndChat() {
    setMessages([])
    setInput('')
    setPendingInvite(null)
    ringRef.current?.destroy()
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

      {joinRequests.map(addr => (
        <div key={addr} className="join-request">
          <strong>join request</strong> for the invite sent to <code>{truncate(addr)}</code>.
          <p className="hint" style={{ margin: '6px 0 0' }}>
            only approve if you sent that invite and are expecting them now.
          </p>
          <div className="actions two-buttons">
            <button onClick={() => approveJoin(addr)} className="btn-primary btn-small">approve</button>
            <button onClick={() => rejectJoin(addr)} className="btn-danger btn-small">reject</button>
          </div>
        </div>
      ))}

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
              <div className={qrVisible ? '' : 'qr-hidden'} aria-hidden={!qrVisible}>
                <QRCodeSVG
                  value={qrVisible ? buildZcashUri(pendingInvite.recipient, pendingInvite.code) : 'zcash:'}
                  size={160}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="M"
                />
              </div>
              {!qrVisible && (
                <button onClick={() => setQrVisible(true)} className="btn-secondary btn-small qr-reveal">
                  tap to show qr
                </button>
              )}
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
            make sure nobody can see or photograph your screen. the qr hides again after 45 seconds.
            scan with your zcash wallet and send, then keep this chat open to approve them.
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
              keys change every 2 minutes and old keys are erased.
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
