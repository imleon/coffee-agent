/**
 * Manages Agent Runner child processes.
 * Spawns agent/dist/index.js, communicates via stdin/stdout marker protocol.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { CONFIG } from './config.js'
import { createOutputParser, type AgentEvent } from './agent-output-parser.js'

export interface AgentInput {
  prompt: string
  sessionId?: string
  workspacePath: string
  systemPrompt?: string
  model?: string
}

export interface AgentRunResult {
  sessionId?: string
  events: AgentEvent[]
  exitCode: number | null
  error?: string
}

export type AgentEventHandler = (event: AgentEvent) => void

/**
 * Spawn an Agent Runner process and stream results back via callback.
 * Returns a promise that resolves when the process exits.
 */
export function runAgent(
  input: AgentInput,
  onEvent: AgentEventHandler,
  signal?: AbortSignal
): Promise<AgentRunResult> {
  return new Promise((resolvePromise, reject) => {
    const agentPath = resolve(CONFIG.agentRunnerPath)
    const events: AgentEvent[] = []
    let sessionId: string | undefined = input.sessionId
    let stderrOutput = ''

    const child: ChildProcess = spawn('npx', ['tsx', agentPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=4096',
      },
      cwd: process.cwd(),
    })

    // Setup timeout
    const timeout = setTimeout(() => {
      console.warn(`[AgentRunner] Process ${child.pid} timed out, killing...`)
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 5000)
    }, CONFIG.agentTimeoutMs)

    // Setup abort signal
    if (signal) {
      signal.addEventListener('abort', () => {
        console.warn(`[AgentRunner] Process ${child.pid} aborted`)
        child.kill('SIGTERM')
      }, { once: true })
    }

    // Parse stdout with marker protocol
    const parser = createOutputParser((event) => {
      events.push(event)

      // Extract sessionId from result events
      if (event.type === 'result' && typeof event.content === 'object' && event.content !== null) {
        const content = event.content as Record<string, unknown>
        if (content.sessionId || content.session_id) {
          sessionId = (content.sessionId || content.session_id) as string
        }
      }

      onEvent(event)
    })

    child.stdout!.on('data', (data: Buffer) => {
      parser.feed(data.toString())
    })

    child.stderr!.on('data', (data: Buffer) => {
      const text = data.toString()
      stderrOutput += text
      // Log stderr for debugging but don't treat as error
      if (text.trim()) {
        console.error(`[AgentRunner:stderr] ${text.trim()}`)
      }
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      parser.flush()
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      parser.flush()
      resolvePromise({
        sessionId,
        events,
        exitCode: code,
        error: code !== 0 ? stderrOutput.slice(-500) : undefined,
      })
    })

    // Write input to stdin and close
    const inputJson = JSON.stringify(input)
    child.stdin!.write(inputJson)
    child.stdin!.end()
  })
}
