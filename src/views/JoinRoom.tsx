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

    try {
      const raw = memoInput.trim()
      const cleaned = stripNonBase64(raw)

      if (cleaned.length < 80) {
        setError('memo too short. make sure you copied the complete memo from your wallet.')
        setJoining(false)
        return
      }

      let firstBytes: Uint8Array
      try {
        firstBytes = b64Decode(cleaned)
      } catch {
        setError('invalid invite data. paste the memo exactly as shown in your wallet.')
        setJoining(false)
        return
      }

      // Try direct: pasted text is base64url of the raw encrypted bytes
      try {
        const invite = await decryptInviteBlob(firstBytes)
        joinWithInvite(invite)
        return
      } catch {}

      // Try double-decode: pasted text may be base64url of base64url text
      // (wallet stored the URI memo param as-is without decoding)
      try {
        const innerText = new TextDecoder().decode(firstBytes)
        const innerCleaned = stripNonBase64(innerText)
        if (innerCleaned.length >= 80) {
          const innerBytes = b64Decode(innerCleaned)
          const invite = await decryptInviteBlob(innerBytes)
          joinWithInvite(invite)
          return
        }
      } catch {}

      setError('failed to decrypt invite. make sure you copied the complete memo and entered the correct wallet address.')
      setJoining(false)
    } catch {
      setError('failed to decrypt. this may not be a valid zechat invite.')
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
