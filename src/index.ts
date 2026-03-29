import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { readFileSync, existsSync } from 'fs'
import { CONFIG } from './config.js'
import { createWebRoutes } from './web.js'

const app = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

// API + WebSocket
const webRoutes = createWebRoutes(upgradeWebSocket)
app.route('/', webRoutes)

// 托管前端构建产物
app.use('/*', serveStatic({ root: './web/dist' }))

// SPA fallback — 非 API 路由都返回 index.html
app.get('*', (c) => {
  const index = './web/dist/index.html'
  if (existsSync(index)) {
    return c.html(readFileSync(index, 'utf-8'))
  }
  return c.text('Frontend not built. Run: npm run build:web', 404)
})

const server = serve(
  { fetch: app.fetch, port: CONFIG.port, hostname: CONFIG.host },
  (info) => {
    console.log(`☕ Coffee Agent running at http://${info.address}:${info.port}`)
  }
)

injectWebSocket(server)
