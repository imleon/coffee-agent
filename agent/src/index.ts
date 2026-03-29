/**
 * Coffee Agent Runner
 * 
 * This is the core execution engine. It runs as a child process:
 *   1. Reads AgentInput from stdin (JSON)
 *   2. Calls SDK query() in a streaming loop
 *   3. Writes events to stdout using marker protocol
 * 
 * Communication protocol:
 *   stdin:  JSON AgentInput
 *   stdout: ---OUTPUT_START---\n{JSON}\n---OUTPUT_END--- (per event)
 *   stderr: debug/error logs
 */

import { query } from '@anthropic-ai/claude-agent-sdk'

// --- Types ---

interface AgentInput {
  prompt: string
  sessionId?: string
  workspacePath: string
  systemPrompt?: string
  model?: string
}

// --- stdout marker protocol ---

const OUTPUT_START = '---OUTPUT_START---'
const OUTPUT_END = '---OUTPUT_END---'

function writeOutput(data: unknown): void {
  const json = JSON.stringify(data)
  process.stdout.write(`\n${OUTPUT_START}\n${json}\n${OUTPUT_END}\n`)
}

// --- stdin reader ---

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

// --- Main ---

function extractSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  const direct = record.sessionId ?? record.session_id
  return typeof direct === 'string' && direct.length > 0 ? direct : undefined
}

async function main(): Promise<void> {
  // 1. Read input
  const raw = await readStdin()
  let input: AgentInput

  try {
    input = JSON.parse(raw)
  } catch (e) {
    console.error('[AgentRunner] Failed to parse stdin JSON:', e)
    writeOutput({ type: 'error', content: { message: 'Invalid input JSON' } })
    process.exit(1)
  }

  console.error(`[AgentRunner] Starting with prompt: ${input.prompt.slice(0, 100)}...`)
  console.error(`[AgentRunner] Session: ${input.sessionId || '(new)'}`)
  console.error(`[AgentRunner] Workspace: ${input.workspacePath}`)
  console.error(`[AgentRunner] Model: ${input.model || '(env default)'}`)

  try {
    // 2. Build options
    const options: Record<string, unknown> = {
      cwd: input.workspacePath,
      ...(input.model ? { model: input.model } : {}),
      allowedTools: [
        'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
      ],
      permissionMode: 'default',
    }

    // Resume existing session if sessionId provided
    if (input.sessionId) {
      options.resume = input.sessionId
    }

    // Custom system prompt
    if (input.systemPrompt) {
      options.systemPrompt = input.systemPrompt
    }

    // 3. Call SDK query() — the core loop
    let messageCount = 0
    let sessionId = input.sessionId
    const queryIterator = query({
      prompt: input.prompt,
      options: options as any,
    })

    for await (const message of queryIterator) {
      messageCount++
      sessionId = extractSessionId(message) ?? sessionId
      writeOutput({
        type: (message as any).type || 'message',
        content: message,
      })
    }

    console.error(`[AgentRunner] Completed. ${messageCount} messages.`)

    // 4. Write final result
    writeOutput({
      type: 'result',
      content: {
        status: 'completed',
        messageCount,
        ...(sessionId ? { sessionId } : {}),
      },
    })

  } catch (error) {
    console.error('[AgentRunner] Error:', error)
    writeOutput({
      type: 'error',
      content: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    })
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[AgentRunner] Unhandled error:', err)
  process.exit(1)
})
