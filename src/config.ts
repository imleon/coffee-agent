import { config } from 'dotenv'
config()

export const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  workspacePath: process.env.WORKSPACE_PATH || './data/workspace',
  maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS || '2', 10),
  agentTimeoutMs: parseInt(process.env.AGENT_TIMEOUT_MS || '600000', 10),
  defaultModel: process.env.DEFAULT_MODEL || '',
  agentRunnerPath: './agent/src/index.ts',
  ipcPath: './data/ipc',
} as const
