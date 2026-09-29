import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initSecurityHardening, injectCSP, blockExternalResources } from './lib/security'
import './app.css'

blockExternalResources()
injectCSP()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

initSecurityHardening()
