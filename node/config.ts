import { config } from 'dotenv'
config()

const authToken = process.env.APP_AUTH_TOKEN || ''

export const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  workspacePath: process.env.WORKSPACE_PATH || './data/workspace',
  maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS || '2', 10),
  agentTimeoutMs: parseInt(process.env.AGENT_TIMEOUT_MS || '600000', 10),
  defaultModel: process.env.DEFAULT_MODEL || '',
  authToken,
  authEnabled: authToken.length > 0,
  agentRunnerPath: './agent/src/index.ts',
  ipcPath: './data/ipc',
  lark: {
    appId: process.env.LARK_APP_ID || '',
    appSecret: process.env.LARK_APP_SECRET || '',
    encryptKey: process.env.LARK_ENCRYPT_KEY || '',
    verificationToken: process.env.LARK_VERIFICATION_TOKEN || '',
    botName: process.env.LARK_BOT_NAME || 'Cotta',
  },
} as const
