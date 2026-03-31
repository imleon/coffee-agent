import { randomUUID } from 'node:crypto'
import { query, type CanUseTool, type ElicitationRequest, type ElicitationResult, type PermissionResult, type Query, type SDKControlRequest, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  PendingInteraction,
  RunnerAgentInput,
  RunnerCommand,
  RunnerRuntimeEvent,
  RuntimeEnvelopeBase,
  SessionMessage,
} from '../../shared/message-types.js'
import {
  normalizeSdkEnvelopeMessage,
} from '../../shared/transcript-normalizer.js'
import { logAgent } from './logger.js'

const OUTPUT_START = '---OUTPUT_START---'
const OUTPUT_END = '---OUTPUT_END---'
const EVENT_LOG_INTERVAL = 20
let eventSequence = 0

function nextEnvelope(sessionId?: string): RuntimeEnvelopeBase {
  eventSequence += 1
  return {
    receivedAt: Date.now(),
    sequence: eventSequence,
    ...(sessionId ? { sessionId } : {}),
  }
}

function writeOutput(data: unknown): void {
  const json = JSON.stringify(data)
  process.stdout.write(`\n${OUTPUT_START}\n${json}\n${OUTPUT_END}\n`)
}

function writeRuntimeEvent(event: RunnerRuntimeEvent): void {
  writeOutput(event)
}

function extractSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const direct = record.sessionId ?? record.session_id
  return typeof direct === 'string' && direct.length > 0 ? direct : undefined
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function toParsedSessionMessage(message: SDKMessage): SessionMessage | undefined {
  return normalizeSdkEnvelopeMessage(message) ?? undefined
}

function normalizePermissionRequest(request: SDKControlRequest): PendingInteraction | null {
  const payload = asRecord(request.request) ?? asRecord(request)
  if (!payload || payload.subtype !== 'can_use_tool') return null

  return {
    id: typeof request.request_id === 'string'
      ? request.request_id
      : typeof payload.tool_use_id === 'string'
        ? payload.tool_use_id
        : '',
    kind: 'permission',
    status: 'pending',
    toolName: typeof payload.tool_name === 'string' ? payload.tool_name : 'unknown_tool',
    input: (payload.input && typeof payload.input === 'object' ? payload.input : {}) as Record<string, unknown>,
    title: typeof payload.title === 'string' ? payload.title : undefined,
    displayName: typeof payload.display_name === 'string' ? payload.display_name : undefined,
    description: typeof payload.description === 'string' ? payload.description : undefined,
    decisionReason: typeof payload.decision_reason === 'string' ? payload.decision_reason : undefined,
    blockedPath: typeof payload.blocked_path === 'string' ? payload.blocked_path : undefined,
    toolUseId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined,
    agentId: typeof payload.agent_id === 'string' ? payload.agent_id : undefined,
  }
}

function normalizeElicitationRequest(request: SDKControlRequest): PendingInteraction | null {
  const payload = asRecord(request.request) ?? asRecord(request)
  if (!payload || payload.subtype !== 'elicitation') return null

  const serverName = typeof payload.mcp_server_name === 'string'
    ? payload.mcp_server_name
    : typeof payload.server_name === 'string'
      ? payload.server_name
      : typeof payload.serverName === 'string'
        ? payload.serverName
        : 'unknown'
  const messageText = typeof payload.message === 'string' ? payload.message : ''
  const id = typeof request.request_id === 'string'
    ? request.request_id
    : typeof payload.elicitation_id === 'string'
      ? payload.elicitation_id
      : serverName

  return {
    id,
    kind: 'elicitation',
    status: 'pending',
    serverName,
    message: messageText,
    mode: typeof payload.mode === 'string' ? payload.mode : undefined,
    url: typeof payload.url === 'string' ? payload.url : undefined,
    requestedSchema: payload.requested_schema,
  }
}

type PermissionRequest = {
  permissionId: string
  toolName: string
  input: Record<string, unknown>
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  agentId?: string
  permissionSuggestions?: unknown[]
}

type ElicitationContentValue = string | number | boolean | string[]

type ElicitationResponse = {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, ElicitationContentValue>
}

const startDeferred = createDeferred<RunnerAgentInput>()
const permissionWaiters = new Map<string, (decision: 'approve' | 'deny') => void>()
const elicitationWaiters = new Map<string, (response: ElicitationResponse) => void>()
let activeQuery: Query | null = null
let currentSessionId: string | undefined
let cancelRequested = false
let sdkMessageCount = 0

function handleCommand(command: RunnerCommand) {
  switch (command.type) {
    case 'run.start':
      startDeferred.resolve(command.input)
      break
    case 'interaction.permission.respond': {
      logAgent('info', 'agent:permission:response', {
        permissionId: command.permissionId.slice(0, 8),
        decision: command.decision,
      })
      const resolve = permissionWaiters.get(command.permissionId)
      if (resolve) {
        permissionWaiters.delete(command.permissionId)
        resolve(command.decision)
      }
      break
    }
    case 'interaction.elicitation.respond': {
      logAgent('info', 'agent:elicitation:response', {
        requestId: command.requestId.slice(0, 8),
        action: command.response.action,
      })
      const resolve = elicitationWaiters.get(command.requestId)
      if (resolve) {
        elicitationWaiters.delete(command.requestId)
        resolve({
          action: command.response.action,
          ...(command.response.content ? { content: command.response.content as Record<string, ElicitationContentValue> } : {}),
        })
      }
      break
    }
    case 'run.cancel':
      cancelRequested = true
      logAgent('warn', 'agent:run:cancel', {
        sessionId: currentSessionId?.slice(0, 8),
      })
      activeQuery?.close()
      break
  }
}

function startCommandReader() {
  process.stdin.setEncoding('utf-8')
  let buffer = ''

  process.stdin.on('data', (chunk) => {
    buffer += chunk

    while (true) {
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) break

      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (!line) continue

      try {
        handleCommand(JSON.parse(line) as RunnerCommand)
      } catch (e) {
        logAgent('error', 'agent:command:parse-error', {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  })

  process.stdin.on('error', (error) => {
    startDeferred.reject(error)
  })

  process.stdin.on('end', () => {
    if (buffer.trim()) {
      try {
        handleCommand(JSON.parse(buffer.trim()) as RunnerCommand)
      } catch (e) {
        logAgent('error', 'agent:command:final-parse-error', {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  })
}

async function waitForPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionResult> {
  const interaction: PendingInteraction = {
    id: request.permissionId,
    kind: 'permission',
    status: 'pending',
    toolName: request.toolName,
    input: request.input,
    title: request.title,
    displayName: request.displayName,
    description: request.description,
    decisionReason: request.decisionReason,
    blockedPath: request.blockedPath,
    toolUseId: request.permissionId,
    agentId: request.agentId,
  }

  logAgent('info', 'agent:permission:requested', {
    permissionId: request.permissionId.slice(0, 8),
    toolName: request.toolName,
    sessionId: currentSessionId?.slice(0, 8),
  })
  writeRuntimeEvent({
    type: 'sdk.control.requested',
    interaction,
    payload: request,
    ...nextEnvelope(currentSessionId),
  })
  writeRuntimeEvent({
    type: 'run.state_changed',
    state: 'requires_action',
    ...(currentSessionId ? { sessionId: currentSessionId } : {}),
  })

  const decision = await new Promise<'approve' | 'deny'>((resolve, reject) => {
    permissionWaiters.set(request.permissionId, resolve)
    signal.addEventListener(
      'abort',
      () => {
        permissionWaiters.delete(request.permissionId)
        reject(new Error('Permission request aborted'))
      },
      { once: true }
    )
  })

  const resolvedInteraction: PendingInteraction = {
    ...interaction,
    status: 'resolved',
  }
  logAgent('info', 'agent:permission:resolved', {
    permissionId: request.permissionId.slice(0, 8),
    decision,
    sessionId: currentSessionId?.slice(0, 8),
  })
  writeRuntimeEvent({
    type: 'sdk.control.resolved',
    interaction: resolvedInteraction,
    payload: { decision },
    ...nextEnvelope(currentSessionId),
  })
  writeRuntimeEvent({
    type: 'run.state_changed',
    state: 'running',
    ...(currentSessionId ? { sessionId: currentSessionId } : {}),
  })

  if (decision === 'approve') {
    return {
      behavior: 'allow',
      toolUseID: request.permissionId,
      decisionClassification: 'user_temporary',
    }
  }

  return {
    behavior: 'deny',
    message: 'User denied this action.',
    interrupt: true,
    toolUseID: request.permissionId,
    decisionClassification: 'user_reject',
  }
}

async function waitForElicitation(request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResult> {
  const requestId = request.elicitationId || request.serverName
  const interaction: PendingInteraction = {
    id: requestId,
    kind: 'elicitation',
    status: 'pending',
    serverName: request.serverName,
    message: request.message,
    mode: request.mode,
    url: request.url,
    requestedSchema: request.requestedSchema,
  }

  logAgent('info', 'agent:elicitation:requested', {
    requestId: requestId.slice(0, 8),
    serverName: request.serverName,
    sessionId: currentSessionId?.slice(0, 8),
  })
  writeRuntimeEvent({
    type: 'sdk.control.requested',
    interaction,
    payload: request,
    ...nextEnvelope(currentSessionId),
  })
  writeRuntimeEvent({
    type: 'run.state_changed',
    state: 'requires_action',
    ...(currentSessionId ? { sessionId: currentSessionId } : {}),
  })

  const response = await new Promise<ElicitationResponse>((resolve, reject) => {
    elicitationWaiters.set(requestId, resolve)
    signal.addEventListener(
      'abort',
      () => {
        elicitationWaiters.delete(requestId)
        reject(new Error('Elicitation request aborted'))
      },
      { once: true }
    )
  })

  const resolvedInteraction: PendingInteraction = {
    ...interaction,
    status: response.action === 'cancel' ? 'cancelled' : 'resolved',
  }
  logAgent('info', 'agent:elicitation:resolved', {
    requestId: requestId.slice(0, 8),
    action: response.action,
    sessionId: currentSessionId?.slice(0, 8),
  })
  writeRuntimeEvent({
    type: 'sdk.control.resolved',
    interaction: resolvedInteraction,
    payload: response,
    ...nextEnvelope(currentSessionId),
  })
  writeRuntimeEvent({
    type: 'run.state_changed',
    state: response.action === 'cancel' ? 'cancelled' : 'running',
    ...(currentSessionId ? { sessionId: currentSessionId } : {}),
  })

  if (response.action === 'cancel') {
    return {
      action: 'cancel',
      ...(response.content ? { content: response.content } : {}),
    }
  }

  if (response.action === 'decline') {
    return {
      action: 'decline',
    }
  }

  return {
    action: 'accept',
    ...(response.content ? { content: response.content } : {}),
  }
}

function handleSdkMessage(message: SDKMessage) {
  const previousSessionId = currentSessionId
  currentSessionId = extractSessionId(message) ?? currentSessionId
  sdkMessageCount += 1

  if (currentSessionId !== previousSessionId) {
    logAgent('info', 'agent:session:updated', {
      previousSessionId: previousSessionId?.slice(0, 8),
      sessionId: currentSessionId?.slice(0, 8),
    })
  }

  if (message.type === 'system' && message.subtype === 'session_state_changed') {
    writeRuntimeEvent({
      type: 'run.state_changed',
      state: message.state === 'running' || message.state === 'requires_action' || message.state === 'idle' ? message.state : 'idle',
      ...(currentSessionId ? { sessionId: currentSessionId } : {}),
    })
  }

  if (sdkMessageCount === 1 || sdkMessageCount % EVENT_LOG_INTERVAL === 0) {
    logAgent('debug', 'agent:query:event', {
      count: sdkMessageCount,
      type: message.type,
      sessionId: currentSessionId?.slice(0, 8),
    })
  }

  writeRuntimeEvent({
    type: 'sdk.message',
    payload: message,
    ...(message.type === 'assistant' || message.type === 'user' ? { parsed: toParsedSessionMessage(message) } : {}),
    ...nextEnvelope(currentSessionId),
  })
}

async function main(): Promise<void> {
  startCommandReader()

  let input: RunnerAgentInput
  try {
    input = await startDeferred.promise
  } catch (e) {
    logAgent('error', 'agent:run:start-error', {
      error: e instanceof Error ? e.message : String(e),
    })
    writeRuntimeEvent({ type: 'run.failed', error: 'Invalid start command' })
    process.exit(1)
    return
  }

  currentSessionId = input.sessionId
  cancelRequested = false
  eventSequence = 0
  sdkMessageCount = 0

  logAgent('info', 'agent:run:start', {
    promptLength: input.prompt.length,
    sessionId: input.sessionId?.slice(0, 8),
    workspacePath: input.workspacePath,
    model: input.model || '(env default)',
  })

  try {
    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      const permissionId = options.toolUseID || randomUUID()
      return waitForPermission(
        {
          permissionId,
          toolName,
          input: toolInput,
          title: options.title,
          displayName: options.displayName,
          description: options.description,
          decisionReason: options.decisionReason,
          blockedPath: options.blockedPath,
          agentId: options.agentID,
          permissionSuggestions: options.suggestions,
        },
        options.signal
      )
    }

    const options: Record<string, unknown> = {
      cwd: input.workspacePath,
      ...(input.model ? { model: input.model } : {}),
      allowedTools: [
        'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
      ],
      permissionMode: 'default',
      canUseTool,
      onElicitation: waitForElicitation,
    }

    if (input.sessionId) {
      options.resume = input.sessionId
    }

    if (input.systemPrompt) {
      options.systemPrompt = input.systemPrompt
    }

    let messageCount = 0
    writeRuntimeEvent({ type: 'run.started', ...(currentSessionId ? { sessionId: currentSessionId } : {}) })
    writeRuntimeEvent({ type: 'run.state_changed', state: 'running', ...(currentSessionId ? { sessionId: currentSessionId } : {}) })
    logAgent('info', 'agent:query:start', {
      sessionId: currentSessionId?.slice(0, 8),
      resume: Boolean(input.sessionId),
      allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    })

    activeQuery = query({
      prompt: input.prompt,
      options: options as any,
    })

    for await (const message of activeQuery) {
      messageCount++
      currentSessionId = extractSessionId(message) ?? currentSessionId
      handleSdkMessage(message)
    }

    if (!cancelRequested) {
      logAgent('info', 'agent:query:completed', {
        messageCount,
        sessionId: currentSessionId?.slice(0, 8),
      })
      writeRuntimeEvent({
        type: 'run.completed',
        messageCount,
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      })
    } else {
      logAgent('warn', 'agent:query:cancelled', {
        messageCount,
        sessionId: currentSessionId?.slice(0, 8),
      })
      writeRuntimeEvent({
        type: 'run.cancelled',
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      })
    }
  } catch (error) {
    if (!cancelRequested) {
      logAgent('error', 'agent:query:error', {
        error: error instanceof Error ? error.message : String(error),
        sessionId: currentSessionId?.slice(0, 8),
      })
      writeRuntimeEvent({
        type: 'run.failed',
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      })
      process.exit(1)
    } else {
      writeRuntimeEvent({
        type: 'run.cancelled',
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      })
    }
  } finally {
    activeQuery = null
  }

  process.exit(0)
}

main().catch((err) => {
  logAgent('error', 'agent:unhandled-error', {
    error: err instanceof Error ? err.message : String(err),
  })
  process.exit(1)
})
