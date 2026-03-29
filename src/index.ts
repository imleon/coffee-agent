/**
 * Coffee Agent — Main Entry Point
 * M1: CLI test mode (no HTTP server yet, that's M2)
 */

import { CONFIG } from './config.js'

console.log('☕ Coffee Agent starting...')
console.log(`   Workspace: ${CONFIG.workspacePath}`)
console.log(`   Max concurrent: ${CONFIG.maxConcurrentAgents}`)
console.log(`   Model: ${CONFIG.defaultModel}`)
console.log('')
console.log('M1: Agent core ready. Use `npm run test:cli` to test.')
