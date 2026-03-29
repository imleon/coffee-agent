import { CONFIG } from './config.js'
import { runAgent, type AgentEvent } from './agent-runner.js'
import { TaskQueue } from './queue.js'

const queue = new TaskQueue(CONFIG.maxConcurrentAgents)

async function main() {
  const prompt = process.argv[2] || 'Say hello and tell me the current date.'

  console.log('☕ Coffee Agent CLI Test')
  console.log('========================')
  console.log(`Prompt: ${prompt}`)
  console.log(`Workspace: ${CONFIG.workspacePath}`)
  console.log('')

  const result = await queue.enqueue(() =>
    runAgent(
      {
        prompt,
        workspacePath: CONFIG.workspacePath,
        ...(CONFIG.defaultModel ? { model: CONFIG.defaultModel } : {}),
      },
      (event: AgentEvent) => {
        const c = event.content as Record<string, unknown>
        if (c.type === 'result') {
          console.log('\n\n--- Result ---')
          console.log(JSON.stringify(c, null, 2))
        } else if (typeof c.result === 'string') {
          process.stdout.write(c.result)
        } else if (c.type === 'system' || c.type === 'assistant') {
          // skip verbose system/assistant meta events
        } else {
          console.log(`[${String(c.type || event.type)}]`, JSON.stringify(c).slice(0, 150))
        }
      }
    )
  )

  console.log('\n========================')
  console.log(`Exit code: ${result.exitCode}`)
  console.log(`Session: ${result.sessionId || '(unknown)'}`)
  console.log(`Events: ${result.events.length}`)
  if (result.error) console.error(`Error: ${result.error}`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
