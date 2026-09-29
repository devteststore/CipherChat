import { useState } from 'react'
import type { RoomData, InvitePayload } from '../lib/crypto'
import { decryptInviteBlob } from '../lib/crypto'

interface Props {
  myAddress: string
  onJoined: (room: RoomData, roomCode: string) => void
  onBack: () => void
}

function b64Decode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function stripNonBase64(s: string): string {
  return s.replace(/[^A-Za-z0-9\-_+/=]/g, '')
}

export function JoinRoom({ myAddress, onJoined, onBack }: Props) {
  const [memoInput, setMemoInput] = useState('')
  const [error, setError] = useState('')
  const [diag, setDiag] = useState('')
  const [joining, setJoining] = useState(false)

  function joinWithInvite(invite: InvitePayload) {
    if (
      typeof invite.roomId !== 'string' || invite.roomId.length < 16 ||
      typeof invite.roomSecret !== 'string' || invite.roomSecret.length < 64 ||
      typeof invite.roomCode !== 'string' || !invite.roomCode
    ) {
      setError('invalid invite payload. the data may be corrupted.')
      setJoining(false)
      return
    }

    const safeName = typeof invite.roomName === 'string'
      ? invite.roomName.slice(0, 50)
      : 'ZeChat'

    const room: RoomData = {
      id: invite.roomId,
      name: safeName,
      participants: [myAddress],
      createdAt: Date.now(),
      version: 1,
      roomSecret: invite.roomSecret,
    }

    onJoined(room, invite.roomCode)
  }

  async function handleDecryptInvite() {
    if (!memoInput.trim()) return
    setJoining(true)
    setError('')
    setDiag('')

    const dbg: string[] = []
    try {
      const raw = memoInput.trim()
      dbg.push(`pasted: ${raw.length} chars`)
      const cleaned = stripNonBase64(raw)
      dbg.push(`cleaned: ${cleaned.length} chars`)

      if (cleaned.length < 80) {
        setError('memo too short.')
        setDiag(dbg.join(' | '))
        setJoining(false)
        return
      }

      let firstBytes: Uint8Array
      try {
        firstBytes = b64Decode(cleaned)
        dbg.push(`decoded: ${firstBytes.length} bytes`)
      } catch {
        setError('base64 decode failed.')
        setDiag(dbg.join(' | '))
        setJoining(false)
        return
      }

      let firstErr = ''
      try {
        const invite = await decryptInviteBlob(firstBytes)
        joinWithInvite(invite)
        return
      } catch (e) { firstErr = (e as Error).message || 'aes-gcm fail' }
      dbg.push(`try1: ${firstErr}`)

      let secondErr = ''
      try {
        const innerText = new TextDecoder('utf-8', { fatal: false }).decode(firstBytes)
        const innerCleaned = stripNonBase64(innerText)
        dbg.push(`inner: ${innerCleaned.length} chars`)
        if (innerCleaned.length >= 80) {
          const innerBytes = b64Decode(innerCleaned)
          dbg.push(`inner-decoded: ${innerBytes.length} bytes`)
          const invite = await decryptInviteBlob(innerBytes)
          joinWithInvite(invite)
          return
        }
      } catch (e) { secondErr = (e as Error).message || 'aes-gcm fail' }
      dbg.push(`try2: ${secondErr || 'skipped'}`)

      setError('decrypt failed — see diagnostics below')
      setDiag(dbg.join(' | '))
      setJoining(false)
    } catch (e) {
      setError((e as Error).message || 'unknown error')
      setDiag(dbg.join(' | '))
      setJoining(false)
    }
  }

  return (
    <div className="view join-view">
      <button onClick={onBack} className="btn-back">back</button>
      <h2>join zechat</h2>

      <div className="card">
        <label className="label">paste invite memo</label>
        <p className="hint">
          open your zcash wallet, find the zechat invite memo, and paste it below.
          only your wallet can decrypt it.
        </p>
        <textarea
          value={memoInput}
          onChange={e => setMemoInput(e.target.value)}
          placeholder="paste your invite memo here..."
          className="input-memo-paste"
          rows={6}
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />
      </div>

      {error && <p className="error-text">{error}</p>}
      {diag && <p className="hint" style={{ fontFamily: 'monospace', fontSize: '11px', wordBreak: 'break-all' }}>{diag}</p>}

      <div className="actions">
        <button
          onClick={handleDecryptInvite}
          disabled={joining || !memoInput.trim()}
          className="btn-primary btn-large"
        >
          {joining ? '[ decrypting... ]' : '[ decrypt & join ]'}
        </button>
      </div>

      <div className="card info-card">
        <p className="hint">
          invites are encrypted and delivered via shielded memo.
          paste the full memo to join.
        </p>
      </div>
    </div>
  )
}
