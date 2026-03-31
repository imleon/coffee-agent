import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { TranscriptBlock, TranscriptMessage } from './transcript-normalizer.js'

export type SessionRunState = 'idle' | 'queued' | 'running' | 'requires_action' | 'completed' | 'failed' | 'cancelled'
export type SessionLifecycleState = SessionRunState

export type SessionMessageBlock = TranscriptBlock
export type SessionMessage = TranscriptMessage

export interface SessionSummary {
  id: string
  title: string
  updatedAt: number
}

export interface PendingInteractionBase {
  id: string
  kind: 'permission' | 'elicitation'
  status: 'pending' | 'resolved' | 'cancelled'
}

export interface PendingPermissionInteraction extends PendingInteractionBase {
  kind: 'permission'
  toolName: string
  input: Record<string, unknown>
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  toolUseId?: string
  agentId?: string
}

export interface PendingElicitationInteraction extends PendingInteractionBase {
  kind: 'elicitation'
  serverName: string
  message: string
  mode?: string
  url?: string
  requestedSchema?: unknown
}

export type PendingInteraction = PendingPermissionInteraction | PendingElicitationInteraction

export interface RunStateSnapshot {
  status: SessionLifecycleState
  sessionId?: string
  currentInteraction?: PendingInteraction | null
}

export interface RuntimeEnvelopeBase {
  sessionId?: string
  receivedAt: number
  sequence: number
}

export type RunnerAgentInput = {
  prompt: string
  sessionId?: string
  workspacePath: string
  systemPrompt?: string
  model?: string
}

export type RunnerCommand =
  | { type: 'run.start'; input: RunnerAgentInput }
  | { type: 'run.cancel' }
  | { type: 'interaction.permission.respond'; permissionId: string; decision: 'approve' | 'deny' }
  | { type: 'interaction.elicitation.respond'; requestId: string; response: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> } }

export type RunnerRuntimeEvent =
  | { type: 'run.started'; sessionId?: string }
  | { type: 'run.state_changed'; state: SessionRunState; sessionId?: string }
  | { type: 'run.completed'; messageCount: number; sessionId?: string }
  | { type: 'run.failed'; error: string; stack?: string; sessionId?: string }
  | { type: 'run.cancelled'; sessionId?: string }
  | ({ type: 'sdk.message'; payload: SDKMessage; parsed?: SessionMessage } & RuntimeEnvelopeBase)
  | ({ type: 'sdk.control.requested'; interaction: PendingInteraction; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'sdk.control.resolved'; interaction: PendingInteraction; payload?: unknown } & RuntimeEnvelopeBase)

export type SessionEvent =
  | { type: 'session.run.queued'; runId: string; sessionId?: string }
  | { type: 'session.run.started'; runId: string; sessionId?: string }
  | { type: 'session.run.state_changed'; runId: string; state: SessionRunState; sessionId?: string }
  | { type: 'session.run.completed'; runId: string; sessionId?: string; exitCode?: number | null; error?: string }
  | { type: 'session.run.failed'; runId?: string; sessionId?: string; error: string }
  | { type: 'session.run.cancelled'; runId: string; sessionId?: string }
  | ({ type: 'session.sdk.message'; runId: string; payload: SDKMessage; parsed?: SessionMessage } & RuntimeEnvelopeBase)
  | ({ type: 'session.sdk.control.requested'; runId: string; interaction: PendingInteraction; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.sdk.control.resolved'; runId: string; interaction: PendingInteraction; payload?: unknown } & RuntimeEnvelopeBase)
  | { type: 'session.error'; runId?: string; error: string }
