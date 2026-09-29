import { useState, useEffect, useRef } from 'react'
import type { RoomData } from '../lib/crypto'
import {
  normalizeInviteCode, deriveInviteKeys, encryptJson, decryptJson, isValidZcashAddress,
  generateEphemeral, deriveSessionKey, inviteCheckCode,
} from '../lib/crypto'
import { publish, subscribe } from '../lib/transport'
import type { InviteRequest, InviteReply, RoomPayload } from './ChatRoom'

interface Props {
  myAddress: string
  onJoined: (room: RoomData) => void
  onBack: () => void
}

const REQUEST_INTERVAL_MS = 3000
const JOIN_TIMEOUT_MS = 5 * 60 * 1000

function validPayload(r: RoomPayload): boolean {
  return typeof r.id === 'string' && /^[0-9a-f]{32}$/.test(r.id)
    && typeof r.chain === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(r.chain)
    && Number.isInteger(r.epoch) && r.epoch > 0
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
      const eph = await generateEphemeral()
      const nonce = crypto.randomUUID()
      let done = false
      let interval: ReturnType<typeof setInterval> | undefined
      let timeout: ReturnType<typeof setTimeout> | undefined

      const finish = () => {
        done = true
        clearInterval(interval)
        clearTimeout(timeout)
        unsub()
        cleanup.current = null
      }

      const unsub = subscribe(tag, async content => {
        if (done) return
        let reply: InviteReply
        try { reply = await decryptJson<InviteReply>(content, key) } catch { return }
        if (reply.t !== 'room' || reply.n !== nonce || typeof reply.pk !== 'string' || typeof reply.d !== 'string') return
        try {
          const sessionKey = await deriveSessionKey(eph.privateKey, reply.pk, eph.publicKey, reply.pk, tag)
          const room = await decryptJson<RoomPayload>(reply.d, sessionKey)
          if (!validPayload(room)) throw new Error('malformed')
          finish()
          const participants = room.participants.includes(myAddress) ? room.participants : [...room.participants, myAddress]
          onJoined({
            id: room.id,
            name: room.name.slice(0, 50) || 'CipherChat',
            participants,
            createdAt: Date.now(),
            version: 1,
            chain: room.chain,
            chainEpoch: room.epoch,
          })
        } catch {
          finish()
          setJoining(false)
          setStatus('')
          setError('the invite reply could not be verified.')
        }
      })

      const request: InviteRequest = { t: 'req', n: nonce, pk: eph.publicKey }
      const sendRequest = async () => { if (!done) publish(tag, await encryptJson(request, key, true)) }
      const check = await inviteCheckCode(tag)
      setStatus(`check code ${check} for wallet ${myAddress.slice(0, 10)}...${myAddress.slice(-8)} — waiting for approval. the inviter's screen must show the same check code; if it differs, the wallet address or code does not match the invite.`)
      interval = setInterval(sendRequest, REQUEST_INTERVAL_MS)
      setTimeout(sendRequest, 500)

      timeout = setTimeout(() => {
        if (done) return
        finish()
        setJoining(false)
        setStatus('')
        setError('no answer. either this code was not sent to this wallet address, or the person who invited you has closed cipherchat or has not approved. ask them to open the chat and try again.')
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
      <h2>join cipherchat</h2>

      <div className="card">
        <label className="label">invite code</label>
        <p className="hint">
          enter the 20-digit code from the cipherchat memo in your wallet.
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
