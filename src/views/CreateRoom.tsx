import { useState } from 'react'
import { generateRoomId, KeyRing } from '../lib/crypto'
import type { RoomData } from '../lib/crypto'

interface Props {
  myAddress: string
  onCreated: (room: RoomData) => void
  onBack: () => void
}

export function CreateRoom({ myAddress, onCreated, onBack }: Props) {
  const [roomName, setRoomName] = useState('')
  const [creating, setCreating] = useState(false)

  async function handleCreate() {
    if (!roomName.trim()) return
    setCreating(true)

    const ring = KeyRing.create()
    const { chain, epoch } = ring.export()
    ring.destroy()

    const room: RoomData = {
      id: generateRoomId(),
      name: roomName.trim(),
      participants: [myAddress],
      createdAt: Date.now(),
      version: 1,
      chain,
      chainEpoch: epoch,
    }

    onCreated(room)
  }

  return (
    <div className="view create-view">
      <button onClick={onBack} className="btn-back">back</button>
      <h2>start cipherchat</h2>
      <p className="hint" style={{ marginBottom: 16 }}>
        a private encrypted room will be created. invite others by sending them
        a wallet-locked invite via shielded zcash memo.
      </p>

      <div className="card">
        <label className="label">room name</label>
        <input
          type="text"
          value={roomName}
          onChange={e => setRoomName(e.target.value)}
          placeholder="e.g. project alpha"
          className="input-full"
          maxLength={50}
          autoComplete="off"
          autoFocus
          onKeyDown={e => e.key === 'Enter' && handleCreate()}
        />
      </div>

      <div className="card">
        <label className="label">your wallet</label>
        <code className="address">{truncate(myAddress)}</code>
        <p className="hint" style={{ marginTop: 6 }}>
          you are the room creator. once inside, invite others by their shielded address.
        </p>
      </div>

      <div className="actions">
        <button
          onClick={handleCreate}
          disabled={creating || !roomName.trim()}
          className="btn-primary btn-large"
        >
          {creating ? '[ creating... ]' : '[ create room ]'}
        </button>
      </div>
    </div>
  )
}

function truncate(addr: string): string {
  if (addr.length <= 24) return addr
  return `${addr.slice(0, 12)}...${addr.slice(-10)}`
}
