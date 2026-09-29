import { useState, useEffect, useRef, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import type { RoomData } from '../lib/crypto'
import {
  deriveMemoKey, encryptMessage, decryptMessage,
  uint8ToBase64, base64ToUint8,
  encryptInviteBlob, getEpoch, isValidZcashAddress,
} from '../lib/crypto'
import { send as transportSend, subscribe as transportSubscribe, hashChannel } from '../lib/transport'
import type { TransportEnvelope, ChatPayload } from '../lib/transport'

const QR_PREFIX = '\x00QR:'

interface Message {
  id: string
  senderIndex: number
  senderAddress: string
  text: string
  timestamp: number
  system?: boolean
}

interface Props {
  room: RoomData
  roomCode: string
  myAddress: string
  onLeave: () => void
  onRoomUpdated: (room: RoomData) => void
}

function getRole(senderIndex: number, isMe: boolean): { label: string; cls: string } {
  if (isMe) return { label: 'you', cls: 'role-you' }
  if (senderIndex === 0) return { label: 'creator', cls: 'role-creator' }
  return { label: 'guest', cls: 'role-guest' }
}

export function ChatRoom({ room, roomCode, myAddress, onLeave, onRoomUpdated }: Props) {
  const [memoKey, setMemoKey] = useState<CryptoKey | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [msgCount, setMsgCount] = useState(0)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [addingMember, setAddingMember] = useState('')
  const [inviteSending, setInviteSending] = useState(false)
  const [inviteSent, setInviteSent] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const [pendingInvite, setPendingInvite] = useState<{
    recipient: string
    memoText: string
  } | null>(null)

  // Send ZEC flow
  const [sendZecStep, setSendZecStep] = useState<'closed' | 'amount' | 'recipient' | 'qr'>('closed')
  const [zecAmount, setZecAmount] = useState('')
  const [zecRecipient, setZecRecipient] = useState('')

  const [channelHash, setChannelHash] = useState('')
  const myIndex = room.participants.indexOf(myAddress)

  useEffect(() => {
    hashChannel(room.id).then(setChannelHash)
  }, [room.id])

  useEffect(() => {
    const epoch = getEpoch(msgCount)
    deriveMemoKey(room.roomSecret, epoch).then(setMemoKey)
  }, [room.roomSecret, msgCount])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!channelHash || !memoKey) return
    const unsub = transportSubscribe(async (envelope: TransportEnvelope) => {
      if (envelope.ch !== channelHash) return

      try {
        const outerEncrypted = base64ToUint8(envelope.data)
        const outerPlain = await decryptMessage(outerEncrypted, memoKey)
        const chatPayload: ChatPayload = JSON.parse(outerPlain)

        if (chatPayload.from === myAddress) return

        const msgEncrypted = base64ToUint8(chatPayload.payload)
        const plaintext = await decryptMessage(msgEncrypted, memoKey)

        const senderIdx = room.participants.indexOf(chatPayload.from)
        setMessages(prev => {
          if (prev.some(m => m.id === envelope.id)) return prev
          return [...prev, {
            id: envelope.id,
            senderIndex: senderIdx >= 0 ? senderIdx : -1,
            senderAddress: chatPayload.from,
            text: plaintext,
            timestamp: chatPayload.timestamp,
          }]
        })
        setMsgCount(c => c + 1)
      } catch { /* wrong key or not for this room */ }
    })
    return unsub
  }, [channelHash, room.participants, myAddress, memoKey])

  const handleSend = useCallback(async () => {
    if (!input.trim() || !memoKey || myIndex === -1 || !channelHash) return
    setSending(true)

    const text = input.trim()

    try {
      const encrypted = await encryptMessage(text, memoKey)
      const encryptedB64 = uint8ToBase64(encrypted)
      const now = Math.floor(Date.now() / 1000)
      const msgId = crypto.randomUUID()

      const chatPayload: ChatPayload = {
        type: 'chat',
        from: myAddress,
        senderIndex: myIndex,
        payload: encryptedB64,
        timestamp: now,
      }

      const outerPlain = JSON.stringify(chatPayload)
      const outerEncrypted = await encryptMessage(outerPlain, memoKey)
      const outerB64 = uint8ToBase64(outerEncrypted)

      transportSend({
        id: msgId,
        ch: channelHash,
        data: outerB64,
      })

      setMessages(prev => [...prev, {
        id: msgId,
        senderIndex: myIndex,
        senderAddress: myAddress,
        text,
        timestamp: now,
      }])

      setMsgCount(c => c + 1)
      setInput('')
    } catch {
      // fail silently
    } finally {
      setSending(false)
    }
  }, [input, memoKey, myIndex, myAddress, channelHash])

  function bytesToBase64(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  function buildZcashUri(address: string, memo?: string, amount?: string): string {
    const amt = amount || '0.00001'
    if (!memo) return `zcash:${address}?amount=${amt}`
    return `zcash:${address}?amount=${amt}&memo=${memo}`
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

  const handleGiveQR = useCallback(async () => {
    if (!memoKey || myIndex === -1 || !channelHash) return
    setSending(true)

    try {
      const qrText = QR_PREFIX + myAddress
      const encrypted = await encryptMessage(qrText, memoKey)
      const encryptedB64 = uint8ToBase64(encrypted)
      const now = Math.floor(Date.now() / 1000)
      const msgId = crypto.randomUUID()

      const chatPayload: ChatPayload = {
        type: 'chat',
        from: myAddress,
        senderIndex: myIndex,
        payload: encryptedB64,
        timestamp: now,
      }

      const outerPlain = JSON.stringify(chatPayload)
      const outerEncrypted = await encryptMessage(outerPlain, memoKey)
      const outerB64 = uint8ToBase64(outerEncrypted)

      transportSend({
        id: msgId,
        ch: channelHash,
        data: outerB64,
      })

      setMessages(prev => [...prev, {
        id: msgId,
        senderIndex: myIndex,
        senderAddress: myAddress,
        text: qrText,
        timestamp: now,
      }])

      setMsgCount(c => c + 1)
    } catch {
      // fail silently
    } finally {
      setSending(false)
    }
  }, [memoKey, myIndex, myAddress, channelHash])

  async function handleInvite() {
    if (!addingMember.trim()) return
    const addr = addingMember.trim()
    if (!isValidZcashAddress(addr)) return
    if (room.participants.includes(addr)) return

    setInviteSending(true)

    try {
      const invite = {
        roomId: room.id,
        roomName: room.name,
        roomCode: roomCode,
        roomSecret: room.roomSecret,
      }
      const memoBytes = await encryptInviteBlob(invite)
      const memoText = bytesToBase64(memoBytes)

      setPendingInvite({
        recipient: addr,
        memoText,
      })

      const updated: RoomData = {
        ...room,
        participants: [...room.participants, addr],
        version: room.version + 1,
      }
      onRoomUpdated(updated)

      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        senderIndex: -1,
        senderAddress: '',
        text: `invite prepared for ${truncate(addr)}`,
        timestamp: Math.floor(Date.now() / 1000),
        system: true,
      }])

      setAddingMember('')
      setInviteSent(truncate(addr))
      setTimeout(() => setInviteSent(''), 3000)
    } catch {
      // invite failed
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

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 10000)
    }).catch(() => {})
  }

  return (
    <div className="view chat-view chat-active">
      {/* Sealed bar */}
      <div className="sealed-bar">
        <span className="sealed-icon" />
        encrypted &middot; ephemeral &middot; zero persistence
      </div>

      {/* Header */}
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

      {/* Members panel */}
      {showMembers && (
        <div className="members-panel">
          <h3>Members</h3>
          <ul className="member-list">
            {room.participants.map((addr, i) => (
              <li key={i} className="member-item">
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
              enter a shielded address. a wallet-locked invite will be generated.
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
            {inviteSent && <p className="success-text">invite ready for {inviteSent}</p>}
          </div>
        </div>
      )}

      {/* Invite memo panel */}
      {pendingInvite && (
        <div className="outgoing-memo-panel">
          <div className="outgoing-memo-header">
            <h4>send invite from your wallet</h4>
            <button onClick={() => setPendingInvite(null)} className="btn-icon">x</button>
          </div>
          <div className="outgoing-recipient">
            <div className="outgoing-qr">
              <QRCodeSVG
                value={buildZcashUri(pendingInvite.recipient, pendingInvite.memoText)}
                size={140}
                bgColor="#ffffff"
                fgColor="#000000"
                level="L"
              />
            </div>
            <div className="outgoing-details">
              <div className="outgoing-field">
                <span className="step-label">to</span>
                <div className="outgoing-value-row">
                  <code className="address-truncated">{truncate(pendingInvite.recipient)}</code>
                  <button onClick={() => copyToClipboard(pendingInvite.recipient)} className="btn-copy">copy</button>
                </div>
              </div>
              <div className="outgoing-field">
                <span className="step-label">amount</span>
                <code className="outgoing-amount">0.00001 ZEC</code>
              </div>
              <div className="outgoing-field">
                <span className="step-label">encrypted invite</span>
                <button onClick={() => copyToClipboard(pendingInvite.memoText)} className="btn-copy-memo">
                  copy invite data
                </button>
              </div>
            </div>
          </div>
          <p className="outgoing-hint">
            scan this qr with your zcash wallet to send the invite. shielded only.
          </p>
        </div>
      )}

      {/* Send ZEC panel */}
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
                .map((addr, i) => {
                  const realIdx = room.participants.indexOf(addr)
                  return (
                    <button
                      key={i}
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

      {/* Messages */}
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
          const isMe = msg.senderIndex === myIndex
          const role = getRole(msg.senderIndex, isMe)
          const isQR = msg.text.startsWith(QR_PREFIX)
          const qrAddr = isQR ? msg.text.slice(QR_PREFIX.length) : ''
          return (
            <div key={msg.id} className={`message ${isMe ? 'message-mine' : 'message-other'}`}>
              <div className="message-sender-row">
                <span className={`message-sender color-${msg.senderIndex % 6}`}>
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

      {/* Input */}
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
            maxLength={380}
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
