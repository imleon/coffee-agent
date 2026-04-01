import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { UpgradeWebSocket } from 'hono/ws'
import { CONFIG } from './config.js'
import { createAgentRun, type AgentRunHandle, type ServerEvent } from './agent-runner.js'
import type { SessionEvent, StaticMetadataSnapshot, StaticMetadataTreeNode } from '../shared/message-types.js'
import { TaskQueue } from './queue.js'
import { listAllSessions, getMessages } from './sessions.js'
import { readSessionRuntimeLogs, readSessionTransportLogs } from './transport-logs.js'
import { createLogger, shortId } from './logger.js'
import { buildSdkExportTree, mapTree, overlayNodeValues } from './sdk-type-tree.js'

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

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SDK_DIR = resolve(ROOT_DIR, 'node_modules/@anthropic-ai/claude-agent-sdk')
const PROJECT_CLAUDE_DIR = resolve(ROOT_DIR, '.claude')
const SETTINGS_LOCAL_PATH = resolve(PROJECT_CLAUDE_DIR, 'settings.local.json')
const USER_STATE_PATH = resolve(homedir(), '.claude.json')
const SDK_PACKAGE_JSON_PATH = resolve(SDK_DIR, 'package.json')
const SDK_MANIFEST_JSON_PATH = resolve(SDK_DIR, 'manifest.json')
const SDK_DTS_PATH = resolve(SDK_DIR, 'sdk.d.ts')

function createNode(input: {
  key: string
  path: string
  label?: string
  kind: StaticMetadataTreeNode['kind']
  status?: StaticMetadataTreeNode['status']
  description?: string
  source?: string
  value?: unknown
  requiresSession?: boolean
  children?: StaticMetadataTreeNode[]
  meta?: Record<string, unknown>
}): StaticMetadataTreeNode {
  return {
    key: input.key,
    path: input.path,
    label: input.label ?? input.key,
    kind: input.kind,
    status: input.status ?? 'resolved',
    ...(input.description ? { description: input.description } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.requiresSession ? { requiresSession: true } : {}),
    ...(input.children ? { children: input.children } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
  }
}

function inferKind(value: unknown): StaticMetadataTreeNode['kind'] {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'object':
      return 'object'
    default:
      return 'unknown'
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function toLabel(key: string): string {
  if (!key) return key
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (char) => char.toUpperCase())
}

function objectFromEntries(value: Record<string, unknown>, path: string, source: string, description?: string): StaticMetadataTreeNode {
  const children = Object.entries(value).map(([key, entry]) => valueToNode(`${path}.${key}`, entry, source))
  return createNode({
    key: path.split('.').pop() || path,
    path,
    label: toLabel(path.split('.').pop() || path),
    kind: 'object',
    source,
    description,
    value,
    children,
  })
}

function arrayToNode(path: string, items: unknown[], source: string, description?: string): StaticMetadataTreeNode {
  const children = items.map((item, index) => valueToNode(`${path}[${index}]`, item, source))
  return createNode({
    key: path.split('.').pop() || path,
    path,
    label: toLabel(path.split('.').pop() || path),
    kind: 'array',
    source,
    description,
    value: items,
    children,
    meta: { length: items.length },
  })
}

function valueToNode(path: string, value: unknown, source: string, description?: string): StaticMetadataTreeNode {
  const key = path.endsWith(']') ? path.slice(path.lastIndexOf('[') + 1, -1) : path.split('.').pop() || path
  if (Array.isArray(value)) {
    return arrayToNode(path, value, source, description)
  }
  const record = asRecord(value)
  if (record) {
    return objectFromEntries(record, path, source, description)
  }
  return createNode({
    key,
    path,
    label: toLabel(key),
    kind: inferKind(value),
    source,
    description,
    value,
  })
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    const text = await readFile(path, 'utf-8')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function buildInstallGroup(pkg: unknown, manifest: unknown): StaticMetadataTreeNode {
  const source = 'sdk package.json + manifest.json'
  const packageNode = valueToNode('install.package', pkg ?? {}, 'sdk package.json', 'SDK npm 包元数据')
  const manifestNode = valueToNode('install.manifest', manifest ?? {}, 'sdk manifest.json', 'Claude Code 安装清单')
  return createNode({
    key: 'install',
    path: 'install',
    label: 'Install',
    kind: 'group',
    source,
    children: [packageNode, manifestNode],
  })
}

function normalizeTreeSource(node: StaticMetadataTreeNode, source: string): StaticMetadataTreeNode {
  return mapTree(node, (entry) => ({
    ...entry,
    source,
  }))
}

function markTreeSessionRequired(node: StaticMetadataTreeNode): StaticMetadataTreeNode {
  return mapTree(node, (entry) => ({
    ...entry,
    status: 'session-required',
    requiresSession: true,
  }))
}

function buildAccountGroup(userState: unknown): StaticMetadataTreeNode {
  const source = 'sdk.d.ts AccountInfo + ~/.claude.json'
  const state = asRecord(userState)
  const claude = asRecord(state?.oauthAccount)
  const accountTree = buildSdkExportTree(SDK_DTS_PATH, 'AccountInfo', 'account', {
    source,
    maxDepth: 3,
  })

  const overlay: Record<string, unknown> = {}
  if (typeof claude?.emailAddress === 'string') overlay.email = claude.emailAddress
  if (typeof claude?.organizationName === 'string') overlay.organization = claude.organizationName
  if (typeof claude?.organizationType === 'string') overlay.subscriptionType = claude.organizationType

  return Object.keys(overlay).length > 0
    ? overlayNodeValues(accountTree, overlay, source)
    : accountTree
}

function buildAgentGroup(): StaticMetadataTreeNode {
  const source = 'sdk.d.ts AgentInfo / AgentDefinition'
  return createNode({
    key: 'agent',
    path: 'agent',
    label: 'Agent',
    kind: 'group',
    source,
    children: [
      buildSdkExportTree(SDK_DTS_PATH, 'AgentInfo', 'agent.agentInfo', {
        source,
        maxDepth: 3,
      }),
      buildSdkExportTree(SDK_DTS_PATH, 'AgentDefinition', 'agent.agentDefinition', {
        source,
        maxDepth: 4,
        maxUnionVariants: 12,
      }),
    ],
  })
}

function buildConfigGroup(localSettings: unknown): StaticMetadataTreeNode {
  const source = 'project settings + sdk.d.ts'
  const localSettingsNode = valueToNode('config.localSettings', localSettings ?? {}, 'project .claude/settings.local.json', '项目本地 Claude 配置')
  const settingsSchemaNode = buildSdkExportTree(SDK_DTS_PATH, 'Settings', 'config.settingsSchema', {
    source: 'sdk.d.ts Settings',
    maxDepth: 3,
    maxProperties: 60,
    maxUnionVariants: 10,
  })
  const pluginNode = buildSdkExportTree(SDK_DTS_PATH, 'SdkPluginConfig', 'config.plugin', {
    source: 'sdk.d.ts SdkPluginConfig',
    maxDepth: 3,
  })
  const mcpNode = createNode({
    key: 'mcp',
    path: 'config.mcp',
    label: 'Mcp',
    kind: 'object',
    source: 'sdk.d.ts MCP types',
    status: 'unavailable',
    children: [
      buildSdkExportTree(SDK_DTS_PATH, 'McpClaudeAIProxyServerConfig', 'config.mcp.claudeAiProxy', {
        source: 'sdk.d.ts MCP types',
        maxDepth: 3,
      }),
      buildSdkExportTree(SDK_DTS_PATH, 'McpHttpServerConfig', 'config.mcp.http', {
        source: 'sdk.d.ts MCP types',
        maxDepth: 3,
      }),
      buildSdkExportTree(SDK_DTS_PATH, 'McpSdkServerConfig', 'config.mcp.sdk', {
        source: 'sdk.d.ts MCP types',
        maxDepth: 3,
      }),
      buildSdkExportTree(SDK_DTS_PATH, 'McpSSEServerConfig', 'config.mcp.sse', {
        source: 'sdk.d.ts MCP types',
        maxDepth: 3,
      }),
      buildSdkExportTree(SDK_DTS_PATH, 'McpStdioServerConfig', 'config.mcp.stdio', {
        source: 'sdk.d.ts MCP types',
        maxDepth: 3,
      }),
      buildSdkExportTree(SDK_DTS_PATH, 'McpServerStatus', 'config.mcp.status', {
        source: 'sdk.d.ts MCP types',
        maxDepth: 4,
      }),
      buildSdkExportTree(SDK_DTS_PATH, 'McpSetServersResult', 'config.mcp.setServersResult', {
        source: 'sdk.d.ts MCP types',
        maxDepth: 3,
      }),
    ],
  })
  return createNode({
    key: 'config',
    path: 'config',
    label: 'Config',
    kind: 'group',
    source,
    children: [localSettingsNode, settingsSchemaNode, pluginNode, mcpNode],
  })
}

function buildCapabilitiesGroup(localSettings: unknown, pkg: unknown, userState: unknown): StaticMetadataTreeNode {
  const settings = asRecord(localSettings)
  const packageJson = asRecord(pkg)
  const state = asRecord(userState)
  const capabilities = {
    settingsSchema: true,
    localSettings: Boolean(settings),
    accountMetadata: Boolean(asRecord(state?.oauthAccount)?.emailAddress),
    plugins: Array.isArray(settings?.enabledPlugins) || Boolean(settings?.pluginConfigs),
    mcp: ['enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'allowedMcpServers', 'deniedMcpServers'].some((key) => key in (settings ?? {})),
    modelConfig: typeof settings?.model === 'string' || Array.isArray(settings?.availableModels),
    installMetadata: typeof packageJson?.version === 'string',
  }
  return createNode({
    key: 'capabilities',
    path: 'capabilities',
    label: 'Capabilities',
    kind: 'group',
    source: 'derived from static sources',
    children: Object.entries(capabilities).map(([key, value]) => createNode({
      key,
      path: `capabilities.${key}`,
      label: toLabel(key),
      kind: 'boolean',
      source: 'derived from static sources',
      value,
    })),
  })
}

function buildSessionOnlyGroup(): StaticMetadataTreeNode {
  const source = 'SDKSystemMessage / runtime APIs'
  const sessionTree = buildSdkExportTree(SDK_DTS_PATH, 'SDKSystemMessage', 'sessionOnly', {
    source,
    maxDepth: 3,
  })
  return markTreeSessionRequired(normalizeTreeSource(sessionTree, source))
}

async function buildStaticMetadataSnapshot(): Promise<StaticMetadataSnapshot> {
  const [pkg, manifest, localSettings, userState] = await Promise.all([
    readJsonFile(SDK_PACKAGE_JSON_PATH),
    readJsonFile(SDK_MANIFEST_JSON_PATH),
    readJsonFile(SETTINGS_LOCAL_PATH),
    readJsonFile(USER_STATE_PATH),
  ])
  return {
    generatedAt: Date.now(),
    groups: [
      buildInstallGroup(pkg, manifest),
      buildAccountGroup(userState),
      buildAgentGroup(),
      buildConfigGroup(localSettings),
      buildCapabilitiesGroup(localSettings, pkg, userState),
      buildSessionOnlyGroup(),
    ],
  }
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
    try {
      const sessions = await listAllSessions()
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

  app.get('/api/sessions/:id/transport-logs', async (c) => {
    const startedAt = Date.now()
    try {
      const id = c.req.param('id')
      const limit = parseInt(c.req.query('limit') || '100', 10)
      const cursorRaw = c.req.query('cursor')
      const follow = c.req.query('follow') === '1'
      const cursor = cursorRaw ? parseInt(cursorRaw, 10) : null
      const page = await readSessionTransportLogs(id, Number.isFinite(cursor) ? cursor : null, limit, follow)
      return c.json(page)
    } catch (err) {
      logger.error('http:transport-logs:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ items: [], hasMore: false, nextCursor: null, error: String(err) })
    }
  })

  app.get('/api/sessions/:id/runtime-logs', async (c) => {
    const startedAt = Date.now()
    try {
      const id = c.req.param('id')
      const limit = parseInt(c.req.query('limit') || '100', 10)
      const cursorRaw = c.req.query('cursor')
      const follow = c.req.query('follow') === '1'
      const cursor = cursorRaw ? parseInt(cursorRaw, 10) : null
      const page = await readSessionRuntimeLogs(id, Number.isFinite(cursor) ? cursor : null, limit, follow)
      return c.json(page)
    } catch (err) {
      logger.error('http:runtime-logs:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ items: [], hasMore: false, nextCursor: null, error: String(err) })
    }
  })

  app.get('/api/static-metadata', async (c) => {
    const startedAt = Date.now()
    try {
      const snapshot = await buildStaticMetadataSnapshot()
      logger.info('http:static-metadata:success', {
        durationMs: Date.now() - startedAt,
        groups: snapshot.groups.length,
      })
      return c.json(snapshot)
    } catch (err) {
      logger.error('http:static-metadata:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ generatedAt: Date.now(), groups: [], error: String(err) }, 500)
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
      if (event.type === 'session.sdk.transport') {
        return
      }
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
