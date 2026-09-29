import { useState } from 'react'
import type { RoomData } from '../lib/crypto'
import { decryptInviteBlob } from '../lib/crypto'

interface Props {
  myAddress: string
  onJoined: (room: RoomData, roomCode: string) => void
  onBack: () => void
}

export function JoinRoom({ myAddress, onJoined, onBack }: Props) {
  const [memoInput, setMemoInput] = useState('')
  const [error, setError] = useState('')
  const [joining, setJoining] = useState(false)

  async function handleDecryptInvite() {
    if (!memoInput.trim()) return
    setJoining(true)
    setError('')

    try {
      const raw = memoInput.trim()

      if (!raw) {
        setError('no encrypted data found. paste the full memo from your wallet.')
        setJoining(false)
        return
      }

      let data: Uint8Array
      try {
        const b64 = raw.replace(/[^A-Za-z0-9\-_+/=]/g, '').replace(/-/g, '+').replace(/_/g, '/')
        const padded = b64 + '='.repeat((4 - b64.length % 4) % 4)
        const binary = atob(padded)
        data = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i)
      } catch {
        setError('invalid invite data. paste the memo exactly as shown in your wallet.')
        setJoining(false)
        return
      }

      let invite
      try {
        invite = await decryptInviteBlob(data, myAddress)
      } catch {
        setError('this invite is not for your wallet. only the authorized address can decrypt it.')
        setJoining(false)
        return
      }

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
    } catch {
      setError('failed to decrypt. this may not be a valid invite or it was not sent to your wallet.')
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
          invites are wallet-locked. the encrypted data can only be unlocked
          by the shielded address it was sent to.
        </p>
      </div>
    </div>
  )
}
