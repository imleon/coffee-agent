type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LogFields = Record<string, unknown>

const REDACTED = '[REDACTED]'
const MAX_STRING_LENGTH = 160

function isDebugEnabled(): boolean {
  const raw = (process.env.COTTA_DEBUG || process.env.DEBUG || '').trim()
  if (!raw) return false
  return raw === '1' || raw === 'true' || raw === '*' || raw.split(',').map((part) => part.trim()).includes('agent')
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return normalized.includes('token')
    || normalized.includes('authorization')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('apikey')
    || normalized === 'auth'
}

function sanitizeString(value: string): string {
  const masked = value
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, `$1${REDACTED}`)
    .replace(/([?&]auth=)[^&]+/gi, `$1${REDACTED}`)

  return masked.length > MAX_STRING_LENGTH ? `${masked.slice(0, MAX_STRING_LENGTH)}…` : masked
}

function sanitizeValue(value: unknown, depth: number = 0): unknown {
  if (value == null) return value
  if (typeof value === 'string') return sanitizeString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) return { name: value.name, message: sanitizeString(value.message) }
  if (Array.isArray(value)) {
    if (depth >= 2) return `[array:${value.length}]`
    return value.slice(0, 10).map((item) => sanitizeValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    if (depth >= 2) return '[object]'
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        isSensitiveKey(key) ? REDACTED : sanitizeValue(entryValue, depth + 1),
      ])
    )
  }
  return String(value)
}

export function logAgent(level: LogLevel, event: string, fields?: LogFields): void {
  if (level === 'debug' && !isDebugEnabled()) return
  const payload = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(sanitizeValue(fields))}` : ''
  process.stderr.write(`[agent] ${event}${payload}\n`)
}
