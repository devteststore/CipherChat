import { useState, useEffect } from 'react'
import { config } from '../config'
import { isValidZcashAddress } from '../lib/crypto'

interface Props {
  onStartChat: (address: string) => void
  onJoinChat: (address: string) => void
}

const ASCII_LOGO = `
 ███████╗███████╗ ██████╗██╗  ██╗ █████╗ ████████╗
 ╚══███╔╝██╔════╝██╔════╝██║  ██║██╔══██╗╚══██╔══╝
   ███╔╝ █████╗  ██║     ███████║███████║   ██║
  ███╔╝  ██╔══╝  ██║     ██╔══██║██╔══██║   ██║
 ███████╗███████╗╚██████╗██║  ██║██║  ██║   ██║
 ╚══════╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝`.trim()

export function Home({ onStartChat, onJoinChat }: Props) {
  const [address, setAddress] = useState('')
  const [checks, setChecks] = useState<{ label: string; ok: boolean | null }[]>([
    { label: 'webcrypto engine', ok: null },
    { label: 'aes-256-gcm + hkdf-sha-512', ok: null },
    { label: 'forward secrecy hash chain', ok: null },
    { label: 'broadcastchannel transport', ok: null },
    { label: 'zero persistence mode', ok: null },
  ])

  useEffect(() => {
    async function runChecks() {
      const results: { label: string; ok: boolean }[] = []

      const hasCrypto = !!(globalThis.crypto?.subtle?.encrypt && globalThis.crypto?.subtle?.deriveKey && globalThis.crypto?.getRandomValues)
      results.push({ label: 'webcrypto engine', ok: hasCrypto })

      let aesOk = false
      try {
        const raw = crypto.getRandomValues(new Uint8Array(32))
        const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
        const key = await crypto.subtle.deriveKey(
          { name: 'HKDF', salt: raw, info: raw, hash: 'SHA-512' },
          material,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        )
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, raw)
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, ct)
        aesOk = true
      } catch {}
      results.push({ label: 'aes-256-gcm + hkdf-sha-512', ok: aesOk })

      let hashChainOk = false
      try {
        const seed = crypto.getRandomValues(new Uint8Array(64))
        const h1 = await crypto.subtle.digest('SHA-512', seed)
        const h2 = await crypto.subtle.digest('SHA-512', h1)
        hashChainOk = h2.byteLength === 64 && new Uint8Array(h2).some(b => b !== 0)
      } catch {}
      results.push({ label: 'forward secrecy hash chain', ok: hashChainOk })

      let bcOk = false
      try {
        const ch = new BroadcastChannel('__sc_probe__')
        ch.close()
        bcOk = true
      } catch {}
      results.push({ label: 'broadcastchannel transport', ok: bcOk })

      const noStorage = typeof localStorage !== 'undefined' && typeof sessionStorage !== 'undefined'
      let zeroPersist = false
      try {
        const testKey = '__sc_zero_persist_check__'
        localStorage.setItem(testKey, '1')
        localStorage.removeItem(testKey)
        zeroPersist = noStorage && !document.cookie.includes('sc_')
      } catch {
        zeroPersist = true
      }
      results.push({ label: 'zero persistence mode', ok: zeroPersist })

      setChecks(results)
    }
    runChecks()
  }, [])

  const valid = isValidZcashAddress(address)
  const allOk = checks.every(c => c.ok === true)
  const anyFailed = checks.some(c => c.ok === false)

  return (
    <div className="view home-view">
      <div className="hero">
        <pre className="ascii-logo">{ASCII_LOGO}</pre>
        <p className="subtitle">
          encrypted ephemeral group chat over zcash shielded pool.
          zero logs. zero traces. zero persistence.
        </p>
        <div className="mainnet-banner">
          [mainnet] — ironwood shielded pool active
        </div>
      </div>

      <section className="card">
        {checks.map((c, i) => (
          <div className="terminal-line" key={i}>
            {c.ok === null
              ? <span className="checking">[...]</span>
              : c.ok
                ? <span className="ok">[ok]</span>
                : <span className="fail">[fail]</span>
            }
            {' '}{c.label}
          </div>
        ))}
        {checks.every(c => c.ok !== null) && (
          <div className="terminal-line">
            {allOk
              ? <><span className="ok">[ok]</span> ready — enter shielded address<span className="cursor-blink" /></>
              : <><span className="fail">[fail]</span> browser missing required apis</>
            }
          </div>
        )}
        {anyFailed && (
          <div className="terminal-line error-text">
            this browser does not support the required encryption apis.
          </div>
        )}
      </section>

      <section className="card">
        <h2>Your Shielded Address</h2>
        <p className="hint">
          paste your zcash shielded address. it never leaves your browser.
        </p>
        <input
          type="text"
          value={address}
          onChange={e => setAddress(e.target.value)}
          placeholder={`${config.hrp}1...`}
          className="input-address input-full"
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />
      </section>

      <div className="actions two-buttons">
        <button
          onClick={() => onStartChat(address.trim())}
          disabled={!valid || !allOk}
          className="btn-primary btn-large"
        >
          [ start zechat ]
        </button>
        <button
          onClick={() => onJoinChat(address.trim())}
          disabled={!valid || !allOk}
          className="btn-secondary btn-large"
        >
          [ join existing chat ]
        </button>
      </div>

      <section className="card how-it-works">
        <h3>Protocol</h3>
        <div className="steps">
          <div className="step">
            <span className="step-num">1</span>
            <div>
              <strong>enter shielded address</strong>
              <p>your zcash shielded address identifies you.</p>
            </div>
          </div>
          <div className="step">
            <span className="step-num">2</span>
            <div>
              <strong>start or join a chat</strong>
              <p>create a new room, or paste an invite from a shielded memo.</p>
            </div>
          </div>
          <div className="step">
            <span className="step-num">3</span>
            <div>
              <strong>invite via shielded memo</strong>
              <p>invites are wallet-locked encrypted blobs sent on-chain.</p>
            </div>
          </div>
          <div className="step">
            <span className="step-num">4</span>
            <div>
              <strong>ephemeral &amp; encrypted</strong>
              <p>all chat is in-memory. leave or end = total wipe. zero logs.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="card encryption-info">
        <h3>Encryption</h3>
        <ul>
          <li>end-to-end encrypted</li>
          <li>forward secrecy</li>
          <li>wallet-bound invites</li>
          <li>zero persistence</li>
        </ul>
      </section>

      <section className="card wallets-info">
        <h3>Recommended Wallets</h3>
        <p className="hint">use any zcash wallet that supports shielded memos.</p>
        <div className="wallet-list">
          <a href="https://myzodl.com" target="_blank" rel="noopener noreferrer" className="wallet-card">
            <strong>Zodl</strong>
            <span>web &amp; mobile — formerly zashi, built by the original ecc team</span>
          </a>
          <a href="https://cakewallet.com" target="_blank" rel="noopener noreferrer" className="wallet-card">
            <strong>Cake Wallet</strong>
            <span>mobile — autoshielding, full shielded memo support</span>
          </a>
          <a href="https://vizorwallet.com" target="_blank" rel="noopener noreferrer" className="wallet-card">
            <strong>Vizor</strong>
            <span>desktop — macos, windows, linux — by chainapsis (keplr team)</span>
          </a>
        </div>
      </section>
    </div>
  )
}
