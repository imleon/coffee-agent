import { randomUUID, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { UpgradeWebSocket } from 'hono/ws'
import { CONFIG } from './config.js'
import { createAgentRun, type AgentRunHandle, type ServerEvent } from './agent-runner.js'
import type { SessionEvent } from '../shared/message-types.js'
import { TaskQueue } from './queue.js'
import { listAllSessions, getMessages } from './sessions.js'
import { createLogger, shortId } from './logger.js'

const queue = new TaskQueue(CONFIG.maxConcurrentAgents)
const logger = createLogger('web')
const EVENT_LOG_INTERVAL = 20

type PermissionDecision = 'approve' | 'deny'
type ElicitationAction = 'accept' | 'decline' | 'cancel'

type ActiveRunState = {
  runId: string
  handle: AgentRunHandle | null
  abortController: AbortController
  canceled: boolean
  sessionId?: string
}

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

function sendSocketEvent(ws: any, payload: unknown) {
  try {
    ws.send(JSON.stringify(payload))
  } catch (error) {
    logger.error('ws:send:error', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function sendSessionEvent(ws: any, event: SessionEvent) {
  sendSocketEvent(ws, event)
}

function toSessionEvent(event: ServerEvent): SessionEvent {
  return event
}

export function createWebRoutes(upgradeWebSocket: UpgradeWebSocket) {
  const app = new Hono()

  app.use('*', cors())

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || !CONFIG.authEnabled) {
      await next()
      return
    }

    const token = getBearerToken(c.req.header('authorization'))
    if (!isAuthorizedToken(token)) {
      logger.warn('auth:api:unauthorized', {
        path: c.req.path,
        hasToken: Boolean(token),
      })
      return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
  })

  app.get('/api/health', (c) => {
    logger.debug('http:health', { authEnabled: CONFIG.authEnabled })
    return c.json({ status: 'ok', authEnabled: CONFIG.authEnabled })
  })

  app.get('/api/sessions', async (c) => {
    const startedAt = Date.now()
    logger.info('http:sessions:list:start')
    try {
      const sessions = await listAllSessions()
      logger.info('http:sessions:list:success', {
        count: sessions.length,
        durationMs: Date.now() - startedAt,
      })
      return c.json({ sessions })
    } catch (err) {
      logger.error('http:sessions:list:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ sessions: [], error: String(err) })
    }
  })

  app.get('/api/sessions/:id/messages', async (c) => {
    const startedAt = Date.now()
    try {
      const id = c.req.param('id')
      const limit = parseInt(c.req.query('limit') || '50', 10)
      logger.info('http:messages:start', {
        sessionId: shortId(id),
        limit,
      })
      const messages = await getMessages(id, limit)
      logger.info('http:messages:success', {
        sessionId: shortId(id),
        limit,
        count: messages.length,
        durationMs: Date.now() - startedAt,
      })
      return c.json({ messages })
    } catch (err) {
      logger.error('http:messages:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ messages: [], error: String(err) })
    }
  })

  app.use('/ws', async (c, next) => {
    const token = c.req.query('auth')
    if (!isAuthorizedToken(token)) {
      logger.warn('auth:ws:unauthorized', {
        path: c.req.path,
        hasToken: Boolean(token),
      })
      return c.text('Unauthorized', 401)
    }
    await next()
  })

  app.get('/ws', upgradeWebSocket(() => {
    let activeRun: ActiveRunState | null = null
    const connId = shortId(randomUUID())
    let forwardedEvents = 0

    logger.info('ws:connect', { connId })

    return {
      onMessage(evt, ws) {
        try {
          const raw = typeof evt.data === 'string' ? evt.data : ''
          const data = JSON.parse(raw)
          logger.info('ws:message:received', {
            connId,
            action: typeof data.action === 'string' ? data.action : '(unknown)',
            promptLength: typeof data.prompt === 'string' ? data.prompt.length : undefined,
            sessionId: typeof data.sessionId === 'string' ? shortId(data.sessionId) : undefined,
          })
          if (data.action === 'message.create' && data.prompt) {
            if (activeRun?.canceled) activeRun = null
            if (activeRun) {
              logger.warn('run:rejected:active-run', {
                connId,
                runId: shortId(activeRun.runId),
              })
              sendSessionEvent(ws, { type: 'session.error', runId: activeRun.runId, error: 'Another run is already active' })
              return
            }
            activeRun = handleMessageCreate(ws, connId || 'ws', data.prompt, data.sessionId, (next) => {
              activeRun = next
            }, (count) => {
              forwardedEvents = count
            })
            return
          }

          if (data.action === 'permission.respond' && data.runId && typeof data.permissionId === 'string' && (data.decision === 'approve' || data.decision === 'deny')) {
            handlePermission(ws, activeRun, data.runId, data.permissionId, data.decision)
            return
          }

          if (data.action === 'elicitation.respond' && data.runId && data.requestId && (data.responseAction === 'accept' || data.responseAction === 'decline' || data.responseAction === 'cancel')) {
            handleElicitation(ws, activeRun, data.runId, data.requestId, data.responseAction, data.content)
            return
          }

          if (data.action === 'run.cancel') {
            logger.warn('run:cancel:requested', {
              connId,
              runId: shortId(activeRun?.runId),
            })
            if (activeRun) {
              activeRun.canceled = true
              activeRun.abortController.abort()
              if (activeRun.handle) {
                activeRun.handle.cancel()
              } else {
                sendSessionEvent(ws, { type: 'session.run.cancelled', runId: activeRun.runId })
                sendSessionEvent(ws, { type: 'session.run.state_changed', runId: activeRun.runId, state: 'cancelled' })
                activeRun = null
              }
            }
            return
          }

          logger.warn('ws:message:unsupported-action', {
            connId,
            action: typeof data.action === 'string' ? data.action : '(unknown)',
          })
        } catch (error) {
          logger.warn('ws:message:invalid-json', {
            connId,
            error: error instanceof Error ? error.message : String(error),
          })
          sendSessionEvent(ws, { type: 'session.error', error: 'Invalid message' })
        }
      },
      onClose() {
        logger.info('ws:close', {
          connId,
          runId: shortId(activeRun?.runId),
          forwardedEvents,
        })
        if (activeRun) {
          activeRun.canceled = true
          activeRun.abortController.abort()
          activeRun.handle?.cancel()
        }
        activeRun = null
      },
    }
  }))

  return app
}

function handlePermission(ws: any, activeRun: ActiveRunState | null, runId: string, permissionId: string, decision: PermissionDecision) {
  if (!activeRun || activeRun.runId !== runId || !activeRun.handle) {
    logger.warn('run:permission:missing-active-run', {
      runId: shortId(runId),
      permissionId: shortId(permissionId),
    })
    sendSessionEvent(ws, { type: 'session.error', runId, error: 'No matching active run for permission response' })
    return
  }
  logger.info('run:permission:respond', {
    runId: shortId(runId),
    permissionId: shortId(permissionId),
    decision,
  })
  activeRun.handle.respondToPermission(permissionId, decision)
}

function handleElicitation(ws: any, activeRun: ActiveRunState | null, runId: string, requestId: string, action: ElicitationAction, content: unknown) {
  if (!activeRun || activeRun.runId !== runId || !activeRun.handle) {
    logger.warn('run:elicitation:missing-active-run', {
      runId: shortId(runId),
      requestId: shortId(requestId),
    })
    sendSessionEvent(ws, { type: 'session.error', runId, error: 'No matching active run for elicitation response' })
    return
  }

  if (content !== undefined && (typeof content !== 'object' || content === null || Array.isArray(content))) {
    logger.warn('run:elicitation:invalid-content', {
      runId: shortId(runId),
      requestId: shortId(requestId),
    })
    sendSessionEvent(ws, { type: 'session.error', runId, error: 'Elicitation content must be an object' })
    return
  }

  logger.info('run:elicitation:respond', {
    runId: shortId(runId),
    requestId: shortId(requestId),
    action,
  })
  activeRun.handle.respondToElicitation(requestId, {
    action,
    ...(content && typeof content === 'object' && !Array.isArray(content) ? { content: content as Record<string, string | number | boolean | string[]> } : {}),
  })
}

function handleMessageCreate(
  ws: any,
  connId: string,
  prompt: string,
  sessionId: string | undefined,
  setActiveRun: (value: ActiveRunState | null) => void,
  setForwardedEvents: (count: number) => void,
): ActiveRunState {
  const runId = randomUUID()
  const startedAt = Date.now()
  const abortController = new AbortController()
  const state: ActiveRunState = { runId, handle: null, abortController, canceled: false, ...(sessionId ? { sessionId } : {}) }
  let forwardedEvents = 0

  logger.info('run:queued', {
    connId,
    runId: shortId(runId),
    sessionId: shortId(sessionId),
    promptLength: prompt.length,
    queuePending: queue.pending,
    queueActive: queue.active,
  })
  sendSessionEvent(ws, { type: 'session.run.queued', runId, ...(sessionId ? { sessionId } : {}) })
  sendSessionEvent(ws, { type: 'session.run.state_changed', runId, state: 'queued', ...(sessionId ? { sessionId } : {}) })

  queue.enqueue(async () => {
    if (state.canceled) throw new Error('Run canceled before start')

    state.handle = createAgentRun({
      prompt,
      workspacePath: CONFIG.workspacePath,
      ...(sessionId ? { sessionId } : {}),
      ...(CONFIG.defaultModel ? { model: CONFIG.defaultModel } : {}),
    }, (event: ServerEvent) => {
      const sessionEvent = toSessionEvent(event)
      if ('sessionId' in sessionEvent && sessionEvent.sessionId) state.sessionId = sessionEvent.sessionId
      forwardedEvents += 1
      setForwardedEvents(forwardedEvents)
      if (forwardedEvents === 1 || forwardedEvents % EVENT_LOG_INTERVAL === 0) {
        logger.debug('run:event:forward', {
          connId,
          runId: shortId(runId),
          count: forwardedEvents,
          type: sessionEvent.type,
          sessionId: 'sessionId' in sessionEvent ? shortId(sessionEvent.sessionId) : undefined,
        })
      }
      sendSessionEvent(ws, sessionEvent)
    }, abortController.signal, runId)

    logger.info('run:started', {
      connId,
      runId: shortId(runId),
      sessionId: shortId(state.sessionId),
      queuePending: queue.pending,
      queueActive: queue.active,
    })
    sendSessionEvent(ws, { type: 'session.run.started', runId, ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    sendSessionEvent(ws, { type: 'session.run.state_changed', runId, state: 'running', ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    return state.handle.done
  }).then((result) => {
    logger.info('run:completed', {
      connId,
      runId: shortId(runId),
      sessionId: shortId(result.sessionId || state.sessionId),
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      forwardedEvents,
      hasError: Boolean(result.error),
    })
    sendSessionEvent(ws, {
      type: 'session.run.completed',
      runId,
      ...((result.sessionId || state.sessionId) ? { sessionId: result.sessionId || state.sessionId } : {}),
      exitCode: result.exitCode,
      ...(result.error ? { error: result.error } : {}),
    })
  }).catch((err) => {
    if (!state.canceled) {
      logger.error('run:failed', {
        connId,
        runId: shortId(runId),
        sessionId: shortId(state.sessionId),
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      })
      sendSessionEvent(ws, { type: 'session.run.failed', runId, ...(state.sessionId ? { sessionId: state.sessionId } : {}), error: String(err) })
      sendSessionEvent(ws, { type: 'session.run.state_changed', runId, state: 'failed', ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    }
  }).finally(() => {
    if (state.canceled) {
      logger.warn('run:cancelled', {
        connId,
        runId: shortId(runId),
        sessionId: shortId(state.sessionId),
        durationMs: Date.now() - startedAt,
      })
    }
    setActiveRun(null)
  })

  return state
}
