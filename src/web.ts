import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { UpgradeWebSocket } from 'hono/ws'
import { CONFIG } from './config.js'
import { runAgent, type AgentEvent } from './agent-runner.js'
import { TaskQueue } from './queue.js'
import { listAllSessions, getMessages } from './sessions.js'

const queue = new TaskQueue(CONFIG.maxConcurrentAgents)

function isAuthorizedToken(token?: string | null): boolean {
  if (!CONFIG.authEnabled) return true
  if (!token) return false

  const expected = Buffer.from(CONFIG.authToken)
  const actual = Buffer.from(token)
  if (expected.length !== actual.length) return false

  return timingSafeEqual(expected, actual)
}

function getBearerToken(header?: string | null): string | null {
  if (!header) return null
  const prefix = 'Bearer '
  return header.startsWith(prefix) ? header.slice(prefix.length).trim() : null
}

export function createWebRoutes(upgradeWebSocket: UpgradeWebSocket) {
  const app = new Hono()

  // CORS for dev
  app.use('*', cors())

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || !CONFIG.authEnabled) {
      await next()
      return
    }

    const token = getBearerToken(c.req.header('authorization'))
    if (!isAuthorizedToken(token)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
  })

  // Health check
  app.get('/api/health', (c) => c.json({ status: 'ok', authEnabled: CONFIG.authEnabled }))

  // List sessions
  app.get('/api/sessions', async (c) => {
    try {
      const sessions = await listAllSessions()
      return c.json({ sessions })
    } catch (err) {
      return c.json({ sessions: [], error: String(err) })
    }
  })

  // Get session messages
  app.get('/api/sessions/:id/messages', async (c) => {
    try {
      const id = c.req.param('id')
      const limit = parseInt(c.req.query('limit') || '50', 10)
      const messages = await getMessages(id, limit)
      return c.json({ messages })
    } catch (err) {
      return c.json({ messages: [], error: String(err) })
    }
  })

  app.use('/ws', async (c, next) => {
    const token = c.req.query('auth')
    if (!isAuthorizedToken(token)) {
      return c.text('Unauthorized', 401)
    }

    await next()
  })

  // WebSocket chat
  app.get(
    '/ws',
    upgradeWebSocket((c) => ({
      onMessage(evt, ws) {
        try {
          const data = JSON.parse(typeof evt.data === 'string' ? evt.data : '')
          if (data.action === 'chat' && data.prompt) {
            handleChat(ws, data.prompt, data.sessionId)
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid message' }))
        }
      },
      onClose() {
        // cleanup if needed
      },
    }))
  )

  return app
}

async function handleChat(ws: any, prompt: string, sessionId?: string) {
  try {
    ws.send(JSON.stringify({ type: 'status', status: 'queued' }))

    const result = await queue.enqueue(() =>
      runAgent(
        {
          prompt,
          workspacePath: CONFIG.workspacePath,
          ...(sessionId ? { sessionId } : {}),
          ...(CONFIG.defaultModel ? { model: CONFIG.defaultModel } : {}),
        },
        (event: AgentEvent) => {
          ws.send(JSON.stringify({ type: 'event', event }))
        }
      )
    )

    ws.send(
      JSON.stringify({
        type: 'done',
        sessionId: result.sessionId,
        exitCode: result.exitCode,
        ...(result.error ? { error: result.error } : {}),
      })
    )
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', error: String(err) }))
  }
}
