import { useState, useCallback } from 'react'
import { Home } from './views/Home'
import { CreateRoom } from './views/CreateRoom'
import { JoinRoom } from './views/JoinRoom'
import { ChatRoom } from './views/ChatRoom'
import type { RoomData } from './lib/crypto'
import { normalizeAddress } from './lib/crypto'
import { destroy as closeTransport } from './lib/transport'

type View = 'home' | 'create' | 'join' | 'chat'

export function App() {
  const [view, setView] = useState<View>('home')
  const [myAddress, setMyAddress] = useState('')
  const [activeRoom, setActiveRoom] = useState<RoomData | null>(null)
  const [joined, setJoined] = useState(false)

  const handleStartChat = useCallback((address: string) => {
    setMyAddress(normalizeAddress(address))
    setView('create')
  }, [])

  const handleJoinChat = useCallback((address: string) => {
    setMyAddress(normalizeAddress(address))
    setView('join')
  }, [])

  const handleRoomCreated = useCallback((room: RoomData) => {
    setActiveRoom(room)
    setJoined(false)
    setView('chat')
  }, [])

  const handleRoomJoined = useCallback((room: RoomData) => {
    setActiveRoom(room)
    setJoined(true)
    setView('chat')
  }, [])

  const handleLeave = useCallback(() => {
    closeTransport()
    setActiveRoom(null)
    setJoined(false)
    setView('home')
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <button onClick={handleLeave} className="logo">ZeChat</button>
        <div className="header-right">
          <span className="network-badge mainnet">mainnet</span>
        </div>
      </header>
      <main>
        {view === 'home' && (
          <Home onStartChat={handleStartChat} onJoinChat={handleJoinChat} />
        )}
        {view === 'create' && (
          <CreateRoom
            myAddress={myAddress}
            onCreated={handleRoomCreated}
            onBack={() => setView('home')}
          />
        )}
        {view === 'join' && (
          <JoinRoom
            myAddress={myAddress}
            onJoined={handleRoomJoined}
            onBack={() => setView('home')}
          />
        )}
        {view === 'chat' && activeRoom && (
          <ChatRoom
            room={activeRoom}
            myAddress={myAddress}
            announceJoin={joined}
            onLeave={handleLeave}
            onRoomUpdated={setActiveRoom}
          />
        )}
      </main>
    </div>
  )
}
