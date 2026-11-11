import { HTTP_BASE_URL, BRIDGE_PROVIDER } from './http-bridge.js'

export default function antigravity(pi) {
  pi.on('before_provider_headers', (event, ctx) => {
    if (ctx.model?.provider !== BRIDGE_PROVIDER && ctx.model?.baseUrl?.replace(/\/$/, '') !== HTTP_BASE_URL) return
    const sessionId = ctx.sessionManager.getSessionId()
    if (sessionId) event.headers['x-pi-acp-session-id'] = sessionId
    event.headers['x-pi-acp-reasoning'] = pi.getThinkingLevel()
  })
}
