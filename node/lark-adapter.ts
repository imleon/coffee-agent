import * as Lark from '@larksuiteoapi/node-sdk'
import { CONFIG } from './config.js'
import { createLogger } from './logger.js'
import { appendSessionChannelLog } from './transport-logs.js'
import { SessionBindingStore } from './session-bindings.js'
import type { ChannelInboundMessage, ChannelOutboundMessage, PendingInteraction, SessionEvent } from '../shared/message-types.js'
import type { RunCoordinator, RunRecord } from './run-coordinator.js'
import { buildContentFromBlocks, normalizeSdkEnvelopeMessage } from '../shared/transcript-normalizer.js'

const logger = createLogger('lark-adapter')
const DEDUPE_TTL_MS = 10 * 60 * 1000

let clientInstance: any | null = null
let dispatcherInstance: any | null = null
let cardActionHandlerInstance: any | null = null
let wsClientInstance: any | null = null
let wsStartPromise: Promise<void> | null = null
const bindings = new SessionBindingStore()
const processedMessageIds = new Map<string, number>()
const processedActionKeys = new Map<string, number>()

export type LarkInboundEvent = {
  conversationKey: string
  userKey?: string
  text: string
  platformMessageId?: string
}

export type LarkOutboundDelivery = {
  conversationKey: string
  text?: string
  card?: unknown
  runId?: string
  sessionId?: string
}

type LarkInteractionCommand =
  | { type: 'permission'; runId: string; interactionId: string; decision: 'approve' | 'deny' }
  | { type: 'elicitation'; runId: string; interactionId: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> }
  | { type: 'invalid'; scope: 'permission' | 'elicitation'; reason: string }

function hasLarkCredentials(): boolean {
  return Boolean(CONFIG.lark.appId && CONFIG.lark.appSecret)
}

function parseLarkMessageText(content: unknown): string {
  if (typeof content !== 'string') return ''
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    return typeof parsed.text === 'string' ? parsed.text.trim() : content.trim()
  } catch {
    return content.trim()
  }
}

function cleanupDedupeMap(store: Map<string, number>, now: number): void {
  for (const [key, seenAt] of store.entries()) {
    if (now - seenAt > DEDUPE_TTL_MS) {
      store.delete(key)
    }
  }
}

function markIfDuplicate(store: Map<string, number>, key?: string): boolean {
  if (!key) return false
  const now = Date.now()
  cleanupDedupeMap(store, now)
  if (store.has(key)) return true
  store.set(key, now)
  return false
}

function isDuplicateMessage(platformMessageId?: string): boolean {
  return markIfDuplicate(processedMessageIds, platformMessageId)
}

function isDuplicateAction(actionKey?: string): boolean {
  return markIfDuplicate(processedActionKeys, actionKey)
}

async function isDuplicateInboundMessage(conversationKey: string, platformMessageId?: string): Promise<boolean> {
  if (!platformMessageId) return false
  if (isDuplicateMessage(platformMessageId)) return true
  const binding = await bindings.get({ channel: 'lark', conversationKey })
  return binding?.lastInboundPlatformMessageId === platformMessageId
}

function parseInteractionContent(raw: string): Record<string, string | number | boolean | string[]> | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, string | number | boolean | string[]>
  } catch {
    return { response: trimmed }
  }
}

function parseLarkInteractionCommand(text: string): LarkInteractionCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  const permissionMatch = trimmed.match(/^\/permission\s+(\S+)\s+(\S+)\s+(approve|deny)$/)
  if (permissionMatch) {
    return {
      type: 'permission',
      runId: permissionMatch[1],
      interactionId: permissionMatch[2],
      decision: permissionMatch[3] as 'approve' | 'deny',
    }
  }

  const elicitationMatch = trimmed.match(/^\/elicitation\s+(\S+)\s+(\S+)\s+(accept|decline|cancel)(?:\s+([\s\S]+))?$/)
  if (elicitationMatch) {
    const action = elicitationMatch[3] as 'accept' | 'decline' | 'cancel'
    const content = action === 'accept' ? parseInteractionContent(elicitationMatch[4] ?? '') : undefined
    if (action === 'accept' && !content) {
      return {
        type: 'invalid',
        scope: 'elicitation',
        reason: 'accept requires JSON object content or plain text content',
      }
    }
    return {
      type: 'elicitation',
      runId: elicitationMatch[1],
      interactionId: elicitationMatch[2],
      action,
      ...(content ? { content } : {}),
    }
  }

  if (trimmed.startsWith('/permission')) {
    return {
      type: 'invalid',
      scope: 'permission',
      reason: 'use /permission <runId> <interactionId> approve|deny',
    }
  }

  if (trimmed.startsWith('/elicitation')) {
    return {
      type: 'invalid',
      scope: 'elicitation',
      reason: 'use /elicitation <runId> <interactionId> accept <json|text> | decline | cancel',
    }
  }

  return null
}

function getLarkClient(): any | null {
  if (!hasLarkCredentials()) return null
  if (clientInstance) return clientInstance

  clientInstance = new Lark.Client({
    appId: CONFIG.lark.appId,
    appSecret: CONFIG.lark.appSecret,
  })
  return clientInstance
}

function getLarkWsClient(): any | null {
  if (!hasLarkCredentials()) return null
  if (wsClientInstance) return wsClientInstance

  wsClientInstance = new Lark.WSClient({
    appId: CONFIG.lark.appId,
    appSecret: CONFIG.lark.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  })
  return wsClientInstance
}

export async function startLarkLongConnection(coordinator: RunCoordinator): Promise<void> {
  const wsClient = getLarkWsClient()
  if (!wsClient) {
    logger.info('lark:ws:disabled', { reason: 'missing-config' })
    return
  }
  if (wsStartPromise) return await wsStartPromise

  logger.info('lark:ws:starting', { hasVerificationToken: Boolean(CONFIG.lark.verificationToken) })
  const startPromise = wsClient.start({
    eventDispatcher: createLarkEventDispatcher(coordinator),
  }).then(() => {
    logger.info('lark:ws:started', {})
  }).catch((error: unknown) => {
    wsStartPromise = null
    logger.error('lark:ws:start:error', {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  })

  wsStartPromise = startPromise
  return await startPromise
}

async function appendLarkChannelLog(params: {
  sessionId?: string
  runId?: string
  direction: 'inbound' | 'outbound' | 'internal'
  eventName: string
  conversationKey?: string
  platformMessageId?: string
  payloadSummary?: string
  payload?: unknown
}): Promise<void> {
  if (typeof params.sessionId !== 'string' || !params.sessionId) return
  await appendSessionChannelLog(params.sessionId, {
    source: 'channel',
    channel: 'lark',
    direction: params.direction,
    eventName: params.eventName,
    ...(params.conversationKey ? { conversationKey: params.conversationKey } : {}),
    ...(params.platformMessageId ? { platformMessageId: params.platformMessageId } : {}),
    ...(params.payloadSummary ? { payloadSummary: params.payloadSummary } : {}),
    ...(params.payload !== undefined ? { payload: params.payload } : {}),
  }, params.runId)
}

async function handleInteractionCommand(coordinator: RunCoordinator, conversationKey: string, command: LarkInteractionCommand): Promise<void> {
  if (command.type === 'invalid') {
    await sendLarkTextMessage(conversationKey, `Invalid ${command.scope} command: ${command.reason}`)
    return
  }

  if (command.type === 'permission') {
    const run = coordinator.getRun(command.runId)
    await appendLarkChannelLog({
      sessionId: run?.sessionId,
      runId: command.runId,
      direction: 'inbound',
      eventName: 'permission.respond',
      conversationKey,
      payloadSummary: command.decision,
      payload: {
        interactionId: command.interactionId,
        decision: command.decision,
      },
    })
    const ok = coordinator.respondToPermission(command.runId, command.interactionId, command.decision)
    await sendLarkTextMessage(
      conversationKey,
      ok
        ? `Permission response recorded: ${command.decision}`
        : 'No matching active run for that permission command.',
    )
    return
  }

  const run = coordinator.getRun(command.runId)
  await appendLarkChannelLog({
    sessionId: run?.sessionId,
    runId: command.runId,
    direction: 'inbound',
    eventName: 'elicitation.respond',
    conversationKey,
    payloadSummary: command.action,
    payload: {
      interactionId: command.interactionId,
      action: command.action,
      ...(command.content ? { content: command.content } : {}),
    },
  })
  const ok = coordinator.respondToElicitation(command.runId, command.interactionId, command.action, command.content)
  await sendLarkTextMessage(
    conversationKey,
    ok
      ? `Elicitation response recorded: ${command.action}`
      : 'No matching active run for that elicitation command.',
  )
}

function buildPermissionCard(runId: string, interaction: Extract<PendingInteraction, { kind: 'permission' }>): Lark.InteractiveCard {
  const title = interaction.title || interaction.displayName || interaction.toolName
  const description = interaction.description || 'Claude 需要你的确认后才能继续执行。'
  return {
    config: {
      wide_screen_mode: true,
      update_multi: false,
    },
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: `Permission required: ${title}`,
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: description,
      },
      {
        tag: 'action',
        layout: 'bisected',
        actions: [
          {
            tag: 'button',
            type: 'primary',
            text: {
              tag: 'plain_text',
              content: 'Approve',
            },
            value: {
              actionType: 'permission',
              runId,
              interactionId: interaction.id,
              decision: 'approve',
            },
            confirm: {
              title: {
                tag: 'plain_text',
                content: 'Approve permission',
              },
              text: {
                tag: 'plain_text',
                content: '确认允许这次操作继续执行吗？',
              },
            },
          },
          {
            tag: 'button',
            type: 'danger',
            text: {
              tag: 'plain_text',
              content: 'Deny',
            },
            value: {
              actionType: 'permission',
              runId,
              interactionId: interaction.id,
              decision: 'deny',
            },
            confirm: {
              title: {
                tag: 'plain_text',
                content: 'Deny permission',
              },
              text: {
                tag: 'plain_text',
                content: '确认拒绝这次操作吗？',
              },
            },
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `Fallback: /permission ${runId} ${interaction.id} approve|deny`,
          },
        ],
      },
    ],
  }
}

function createLarkEventDispatcher(coordinator: RunCoordinator): any {
  return new Lark.EventDispatcher({
    ...(CONFIG.lark.encryptKey ? { encryptKey: CONFIG.lark.encryptKey } : {}),
    ...(CONFIG.lark.verificationToken ? { verificationToken: CONFIG.lark.verificationToken } : {}),
  }).register({
    'im.message.receive_v1': async (data: any) => {
      await handleLarkMessageEvent(coordinator, data)
      return undefined
    },
  })
}

async function handleLarkMessageEvent(coordinator: RunCoordinator, data: any): Promise<void> {
  const conversationKey = typeof data?.message?.chat_id === 'string' ? data.message.chat_id : ''
  const text = parseLarkMessageText(data?.message?.content)
  const userKey = typeof data?.sender?.sender_id?.open_id === 'string'
    ? data.sender.sender_id.open_id
    : typeof data?.sender?.sender_id?.user_id === 'string'
      ? data.sender.sender_id.user_id
      : undefined
  const platformMessageId = typeof data?.message?.message_id === 'string' ? data.message.message_id : undefined

  if (!conversationKey || !text) {
    return
  }

  if (await isDuplicateInboundMessage(conversationKey, platformMessageId)) {
    return
  }

  const interactionCommand = parseLarkInteractionCommand(text)
  if (interactionCommand) {
    await handleInteractionCommand(coordinator, conversationKey, interactionCommand)
    return
  }

  const inbound = toLarkInboundMessage({
    conversationKey,
    text,
    ...(userKey ? { userKey } : {}),
    ...(platformMessageId ? { platformMessageId } : {}),
  })
  const run = await coordinator.startRun(inbound)
  await appendLarkChannelLog({
    sessionId: run.sessionId,
    runId: run.runId,
    direction: 'inbound',
    eventName: 'message.accepted',
    conversationKey,
    platformMessageId,
    payloadSummary: text,
  })
}

function getLarkDispatcher(coordinator: RunCoordinator): any {
  if (dispatcherInstance) return dispatcherInstance

  dispatcherInstance = createLarkEventDispatcher(coordinator)
  return dispatcherInstance
}

function getLarkCardActionHandler(coordinator: RunCoordinator): any {
  if (cardActionHandlerInstance) return cardActionHandlerInstance

  cardActionHandlerInstance = new Lark.CardActionHandler({
    ...(CONFIG.lark.encryptKey ? { encryptKey: CONFIG.lark.encryptKey } : {}),
    ...(CONFIG.lark.verificationToken ? { verificationToken: CONFIG.lark.verificationToken } : {}),
  }, async (data: Lark.InteractiveCardActionEvent) => {
    const runId = typeof data?.action?.value?.runId === 'string' ? data.action.value.runId : ''
    const interactionId = typeof data?.action?.value?.interactionId === 'string' ? data.action.value.interactionId : ''
    const decision = data?.action?.value?.decision === 'approve' || data?.action?.value?.decision === 'deny'
      ? data.action.value.decision
      : null
    const actionType = typeof data?.action?.value?.actionType === 'string' ? data.action.value.actionType : ''
    const actionKey = [data?.open_message_id, runId, interactionId, decision ?? 'invalid'].join(':')

    if (actionType !== 'permission' || !runId || !interactionId || !decision) {
      logger.warn('lark:card-action:invalid', {
        openMessageId: data?.open_message_id,
        runId,
        interactionId,
        actionType,
      })
      return {
        toast: {
          type: 'error',
          content: 'Invalid permission action.',
        },
      }
    }

    if (isDuplicateAction(actionKey)) {
      return {
        toast: {
          type: 'info',
          content: 'This permission action was already handled.',
        },
      }
    }

    const ok = coordinator.respondToPermission(runId, interactionId, decision)

    return {
      toast: {
        type: ok ? 'success' : 'error',
        content: ok
          ? `Permission ${decision} recorded.`
          : 'No matching active run for that permission action.',
      },
      card: {
        config: {
          wide_screen_mode: true,
          update_multi: false,
        },
        header: {
          template: ok ? (decision === 'approve' ? 'green' : 'red') : 'grey',
          title: {
            tag: 'plain_text',
            content: ok
              ? `Permission ${decision}`
              : 'Permission unavailable',
          },
        },
        elements: [
          {
            tag: 'markdown',
            content: ok
              ? `This permission has been **${decision}**.`
              : 'No matching active run was found for this permission action.',
          },
        ],
      },
    }
  })

  return cardActionHandlerInstance
}

export async function invokeLarkEvent(coordinator: RunCoordinator, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const dispatcher = getLarkDispatcher(coordinator)
  const assigned = Object.assign(Object.create({ headers }), body as object)
  return dispatcher.invoke(assigned)
}

export async function invokeLarkCardAction(coordinator: RunCoordinator, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const handler = getLarkCardActionHandler(coordinator)
  const assigned = Object.assign(Object.create({ headers }), body as object)
  return handler.invoke(assigned)
}

export async function sendLarkTextMessage(conversationKey: string, text: string): Promise<{ delivered: boolean; response?: unknown; error?: string }> {
  const client = getLarkClient()
  if (!client) {
    logger.warn('lark:send:missing-config', { conversationKey })
    return { delivered: false, error: 'Lark client is not configured' }
  }

  try {
    const response = await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: conversationKey,
        content: JSON.stringify({ text }),
        msg_type: 'text',
      },
    })
    return { delivered: true, response }
  } catch (error) {
    logger.error('lark:send:error', {
      conversationKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return { delivered: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function sendLarkCardMessage(conversationKey: string, card: unknown): Promise<{ delivered: boolean; response?: unknown; error?: string }> {
  const client = getLarkClient()
  if (!client) {
    logger.warn('lark:send:missing-config', { conversationKey })
    return { delivered: false, error: 'Lark client is not configured' }
  }

  try {
    const response = await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: conversationKey,
        content: JSON.stringify(card),
        msg_type: 'interactive',
      },
    })
    return { delivered: true, response }
  } catch (error) {
    logger.error('lark:send-card:error', {
      conversationKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return { delivered: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function toLarkInboundMessage(event: LarkInboundEvent): ChannelInboundMessage {
  return {
    channel: 'lark',
    conversationKey: event.conversationKey,
    ...(event.userKey ? { userKey: event.userKey } : {}),
    text: event.text,
    ...(event.platformMessageId ? { platformMessageId: event.platformMessageId } : {}),
  }
}

export function createLarkOutboundMessage(runId: string, sessionId: string | undefined, conversationKey: string, content: string): ChannelOutboundMessage {
  return {
    channel: 'lark',
    conversationKey,
    runId,
    ...(sessionId ? { sessionId } : {}),
    content,
  }
}

function summarizePermissionInteraction(runId: string, interaction: Extract<PendingInteraction, { kind: 'permission' }>): string {
  const title = interaction.title || interaction.displayName || interaction.toolName
  const description = interaction.description ? `\n${interaction.description}` : ''
  return [
    `Permission required: ${title}${description}`,
    `Approve: /permission ${runId} ${interaction.id} approve`,
    `Deny: /permission ${runId} ${interaction.id} deny`,
  ].join('\n')
}

function summarizeElicitationInteraction(runId: string, interaction: Extract<PendingInteraction, { kind: 'elicitation' }>): string {
  const schemaHint = interaction.requestedSchema
    ? `\nSchema hint: ${JSON.stringify(interaction.requestedSchema)}`
    : ''
  return [
    interaction.message || 'Additional input required',
    `Accept with text: /elicitation ${runId} ${interaction.id} accept your answer`,
    `Accept with JSON: /elicitation ${runId} ${interaction.id} accept {"field":"value"}`,
    `Decline: /elicitation ${runId} ${interaction.id} decline`,
    `Cancel: /elicitation ${runId} ${interaction.id} cancel`,
  ].join('\n') + schemaHint
}

export function summarizeLarkInteraction(runId: string, interaction: PendingInteraction): string {
  if (interaction.kind === 'permission') {
    return summarizePermissionInteraction(runId, interaction)
  }
  return summarizeElicitationInteraction(runId, interaction)
}

export function extractLarkAssistantText(event: Extract<SessionEvent, { type: 'session.sdk.message' }>): string {
  const parsed = event.parsed ?? normalizeSdkEnvelopeMessage(event.payload)
  if (!parsed || parsed.role !== 'assistant') return ''
  if (Array.isArray(parsed.blocks) && parsed.blocks.length > 0) {
    return buildContentFromBlocks(parsed.blocks).trim()
  }
  return parsed.content.trim()
}

export function buildLarkDeliveries(event: SessionEvent, record: RunRecord): LarkOutboundDelivery[] {
  if (record.channel !== 'lark') return []

  switch (event.type) {
    case 'session.sdk.message': {
      const text = extractLarkAssistantText(event)
      if (!text) return []
      return [{
        conversationKey: record.conversationKey,
        text,
        runId: record.runId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      }]
    }
    case 'session.sdk.control.requested':
      if (event.interaction.kind === 'permission') {
        return [{
          conversationKey: record.conversationKey,
          text: summarizePermissionInteraction(record.runId, event.interaction),
          card: buildPermissionCard(record.runId, event.interaction),
          runId: record.runId,
          ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        }]
      }
      return [{
        conversationKey: record.conversationKey,
        text: summarizeLarkInteraction(record.runId, event.interaction),
        runId: record.runId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      }]
    case 'session.run.failed':
      return [{
        conversationKey: record.conversationKey,
        text: `Run failed: ${event.error}`,
        runId: record.runId,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      }]
    default:
      return []
  }
}

export async function deliverLarkSessionEvent(event: SessionEvent, record: RunRecord): Promise<void> {
  const deliveries = buildLarkDeliveries(event, record)
  if (deliveries.length === 0) return

  logger.info('lark:deliveries:built', {
    count: deliveries.length,
    runId: record.runId,
    sessionId: record.sessionId,
  })

  for (const delivery of deliveries) {
    await appendLarkChannelLog({
      sessionId: delivery.sessionId,
      runId: delivery.runId,
      direction: 'outbound',
      eventName: 'message.requested',
      conversationKey: delivery.conversationKey,
      payloadSummary: delivery.text || (delivery.card ? 'interactive-card' : 'outbound'),
      payload: delivery.card ?? delivery.text,
    })

    if (delivery.card) {
      const result = await sendLarkCardMessage(delivery.conversationKey, delivery.card)
      await appendLarkChannelLog({
        sessionId: delivery.sessionId,
        runId: delivery.runId,
        direction: 'outbound',
        eventName: result.delivered ? 'message.delivered' : 'message.failed',
        conversationKey: delivery.conversationKey,
        payloadSummary: result.delivered ? 'interactive-card' : (result.error || 'failed'),
        payload: result,
      })
      continue
    }
    if (delivery.text) {
      const result = await sendLarkTextMessage(delivery.conversationKey, delivery.text)
      await appendLarkChannelLog({
        sessionId: delivery.sessionId,
        runId: delivery.runId,
        direction: 'outbound',
        eventName: result.delivered ? 'message.delivered' : 'message.failed',
        conversationKey: delivery.conversationKey,
        payloadSummary: result.delivered ? delivery.text : (result.error || 'failed'),
        payload: result,
      })
    }
  }
}
