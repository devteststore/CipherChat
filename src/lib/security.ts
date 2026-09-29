import { RELAYS } from './transport'

export function initSecurityHardening() {
  document.addEventListener('contextmenu', e => {
    const target = e.target as HTMLElement
    if (target.closest('.chat-view') || target.closest('.messages-container')) {
      e.preventDefault()
    }
  })

  if ((import.meta as any).env?.PROD) {
    document.addEventListener('keydown', e => {
      if (
        e.key === 'F12' ||
        (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) ||
        (e.ctrlKey && e.key === 'u')
      ) {
        e.preventDefault()
      }
    })
  }

  const style = document.createElement('style')
  style.textContent = `
    .messages-container { -webkit-user-select: none; user-select: none; }
    .chat-input { -webkit-user-select: text; user-select: text; }
  `
  document.head.appendChild(style)

  const clearClipboard = () => {
    try { navigator.clipboard.writeText('').catch(() => {}) } catch {}
  }
  window.addEventListener('beforeunload', clearClipboard)
  window.addEventListener('pagehide', clearClipboard)

  document.addEventListener('visibilitychange', () => {
    const container = document.querySelector('.messages-container')
    if (!container) return
    if (document.hidden) {
      (container as HTMLElement).style.filter = 'blur(8px)'
    } else {
      (container as HTMLElement).style.filter = ''
    }
  })

  const robotsMeta = document.createElement('meta')
  robotsMeta.name = 'robots'
  robotsMeta.content = 'noindex, nofollow, noarchive, nosnippet, noimageindex'
  document.head.appendChild(robotsMeta)
}

export function secureWipe(arr: Uint8Array) {
  crypto.getRandomValues(arr)
  arr.fill(0)
}

export function injectCSP() {
  const meta = document.createElement('meta')
  meta.httpEquiv = 'Content-Security-Policy'
  meta.content = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    `connect-src 'self' ${RELAYS.join(' ')}`,
    "img-src 'self' data:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ')
  document.head.prepend(meta)

  const xfo = document.createElement('meta')
  xfo.httpEquiv = 'X-Frame-Options'
  xfo.content = 'DENY'
  document.head.prepend(xfo)
}

export function blockExternalResources() {
  if (window.self !== window.top) {
    document.body.innerHTML = ''
    throw new Error('ZeChat cannot run inside an iframe')
  }
}
