import { useState, useEffect, useRef } from 'react'
import type { RoomData } from '../lib/crypto'
import { normalizeInviteCode, deriveInviteKeys, encryptJson, decryptJson, isValidZcashAddress } from '../lib/crypto'
import { publish, subscribe } from '../lib/transport'
import type { InviteRequest, InviteReply } from './ChatRoom'

interface Props {
  myAddress: string
  onJoined: (room: RoomData) => void
  onBack: () => void
}

const REQUEST_INTERVAL_MS = 3000
const JOIN_TIMEOUT_MS = 90000

function validReply(r: InviteReply): boolean {
  return r.t === 'room'
    && typeof r.id === 'string' && /^[0-9a-f]{32}$/.test(r.id)
    && typeof r.secret === 'string' && /^[0-9a-f]{128}$/.test(r.secret)
    && typeof r.name === 'string'
    && Array.isArray(r.participants) && r.participants.length <= 50
    && r.participants.every(p => typeof p === 'string' && isValidZcashAddress(p))
}

export function JoinRoom({ myAddress, onJoined, onBack }: Props) {
  const [codeInput, setCodeInput] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [joining, setJoining] = useState(false)
  const cleanup = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanup.current?.(), [])

  async function handleJoin() {
    const digits = normalizeInviteCode(codeInput)
    setError('')
    if (!digits) {
      setError('the invite code is 20 digits. check you copied all of it from the memo.')
      return
    }
    setCodeInput('')
    setJoining(true)
    setStatus('deriving wallet-locked key...')

    try {
      const { key, tag } = await deriveInviteKeys(digits, myAddress)
      const nonce = crypto.randomUUID()
      let done = false

      const finish = () => {
        done = true
        clearInterval(interval)
        clearTimeout(timeout)
        unsub()
        cleanup.current = null
      }

      const unsub = subscribe(tag, async content => {
        if (done) return
        try {
          const reply = await decryptJson<InviteReply>(content, key)
          if (reply.t !== 'room' || reply.n !== nonce) return
          if (!validReply(reply)) { finish(); setError('invite reply was malformed.'); setJoining(false); setStatus(''); return }
          finish()
          const participants = reply.participants.includes(myAddress) ? reply.participants : [...reply.participants, myAddress]
          onJoined({
            id: reply.id,
            name: reply.name.slice(0, 50) || 'ZeChat',
            participants,
            createdAt: Date.now(),
            version: 1,
            roomSecret: reply.secret,
          })
        } catch { /* our own request echoed back, or unrelated */ }
      })

      const request: InviteRequest = { t: 'req', n: nonce }
      const sendRequest = async () => { if (!done) publish(tag, await encryptJson(request, key, true)) }
      setStatus('waiting for the person who invited you...')
      const interval = setInterval(sendRequest, REQUEST_INTERVAL_MS)
      setTimeout(sendRequest, 500)

      const timeout = setTimeout(() => {
        if (done) return
        finish()
        setJoining(false)
        setStatus('')
        setError('no answer. either this code was not sent to this wallet address, or the person who invited you has closed zechat. ask them to open the chat and try again.')
      }, JOIN_TIMEOUT_MS)

      cleanup.current = finish
    } catch {
      setJoining(false)
      setStatus('')
      setError('could not start join.')
    }
  }

  function handleCancel() {
    cleanup.current?.()
    setJoining(false)
    setStatus('')
  }

  return (
    <div className="view join-view">
      <button onClick={onBack} className="btn-back">back</button>
      <h2>join zechat</h2>

      <div className="card">
        <label className="label">invite code</label>
        <p className="hint">
          enter the 20-digit code from the zechat memo in your wallet.
          it only works with the wallet address it was sent to.
        </p>
        <input
          type="password"
          value={codeInput}
          onChange={e => setCodeInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !joining && handleJoin()}
          placeholder="0000-0000-0000-0000-0000"
          className="input-full"
          inputMode="numeric"
          spellCheck={false}
          autoComplete="off"
          data-lpignore="true"
          data-1p-ignore="true"
          disabled={joining}
          autoFocus
        />
      </div>

      {error && <p className="error-text">{error}</p>}
      {status && <p className="hint">{status}</p>}

      <div className="actions">
        {joining ? (
          <button onClick={handleCancel} className="btn-secondary btn-large">[ cancel ]</button>
        ) : (
          <button onClick={handleJoin} disabled={!codeInput.trim()} className="btn-primary btn-large">
            [ join ]
          </button>
        )}
      </div>

      <div className="card info-card">
        <p className="hint">
          the code never leaves this page. it is combined with your wallet address
          to unlock the invite, so it is useless to anyone else.
        </p>
      </div>
    </div>
  )
}
