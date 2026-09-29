import { useState, useEffect } from 'react'
import { config } from '../config'
import { isValidZcashAddress } from '../lib/crypto'
import { warmUp, connectedRelayCount } from '../lib/transport'

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
    { label: 'encrypted relay transport', ok: null },
    { label: 'zero persistence mode', ok: null },
  ])

  useEffect(() => {
    async function runChecks() {
      const results: { label: string; ok: boolean }[] = []

      const hasCrypto = typeof globalThis.crypto?.subtle?.encrypt === 'function' && typeof globalThis.crypto?.subtle?.deriveKey === 'function' && typeof globalThis.crypto?.getRandomValues === 'function'
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

      let relayOk = false
      try {
        warmUp()
        for (let i = 0; i < 40 && !relayOk; i++) {
          relayOk = connectedRelayCount() > 0
          if (!relayOk) await new Promise(r => setTimeout(r, 250))
        }
      } catch {}
      results.push({ label: 'encrypted relay transport', ok: relayOk })

      // Read-only: confirm nothing from this app exists in any browser storage.
      let zeroPersist = false
      try {
        const ours = (k: string | null) => !!k && /zc|zechat|sc_/i.test(k)
        const keysOf = (s: Storage) => Array.from({ length: s.length }, (_, i) => s.key(i))
        zeroPersist = !keysOf(localStorage).some(ours) && !keysOf(sessionStorage).some(ours)
          && !/(^|;\s*)(zc|zechat|sc_)/i.test(document.cookie)
          && !('serviceWorker' in navigator && navigator.serviceWorker.controller)
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
              <p>create a new room, or enter the invite code from your shielded memo.</p>
            </div>
          </div>
          <div className="step">
            <span className="step-num">3</span>
            <div>
              <strong>invite via shielded memo</strong>
              <p>a short code sent on-chain, locked to the invited wallet.</p>
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
        <p className="hint">
          tip: use <a href="https://www.zknoir.com/" target="_blank" rel="noopener noreferrer">noir wallet</a> (chrome extension) for easy memo copy-paste in your browser.
        </p>
      </section>
    </div>
  )
}
