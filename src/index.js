import { Hono } from 'hono'
import { ChatSession } from './chat-session.js'
import profile from '../profile.json'

// UUID v4 validation regex (crypto.randomUUID() format)
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidUUID(uuid) {
    return typeof uuid === 'string' && UUID_V4_REGEX.test(uuid)
}

const app = new Hono()

// CORS middleware - whitelist Cloudflare Pages domain
app.use('*', async (c, next) => {
	const origin = c.req.header('origin') || ''
	const allowedOrigins = [
		'https://cloudflare-page-wjy.pages.dev',
		'https://abraham.dpdns.org'
	]

	if (allowedOrigins.includes(origin)) {
		c.header('Access-Control-Allow-Origin', origin)
		c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
		c.header('Access-Control-Allow-Headers', 'Content-Type, Upgrade')
		c.header('Access-Control-Max-Age', '86400')
	}

	if (c.req.method === 'OPTIONS') {
		return c.text('', 204)
	}

	await next()
})

// Request validation middleware
app.use('*', async (c, next) => {
	const contentType = c.req.header('content-type') || ''
	const contentLength = parseInt(c.req.header('content-length') || '0')
	
	if (c.req.method === 'POST') {
		if (!contentType.includes('application/json')) {
			return c.json({ error: 'Bad request' }, 400)
		}
		if (contentLength > 2048) {
			return c.json({ error: 'Bad request' }, 413)
		}
	}
	
	await next()
	
	// Add security headers
	c.header('X-Content-Type-Options', 'nosniff')
	c.header('X-Frame-Options', 'DENY')
	c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
	c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
	c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
})

// WebSocket endpoint for chat
app.get('/chat', async (c) => {
	try {
		// Check if this is a WebSocket upgrade request
		const upgradeHeader = c.req.header('Upgrade')
		if (upgradeHeader !== 'websocket') {
			return c.json({ error: 'WebSocket connection required' }, 400)
		}

		// Get and validate session ID from query parameter
		const sessionId = c.req.query('sessionId')
		if (!sessionId) {
			return c.json({ error: 'Session ID required' }, 400)
		}

		if (!isValidUUID(sessionId)) {
			return c.json({ error: 'Invalid session ID format' }, 400)
		}

		// Extract client IP for rate limiting
		const clientIP = c.req.header('cf-connecting-ip') || 'unknown'

		// Create or get existing chat session Durable Object based on sessionId
		const id = c.env.CHAT_SESSION.idFromName(sessionId)
		const stub = c.env.CHAT_SESSION.get(id)

		// Create new request with IP information
		const chatRequest = new Request(c.req.url, {
			method: c.req.method,
			headers: c.req.raw.headers,
			body: c.req.raw.body
		})
		// Add IP as custom header for the DO
		chatRequest.headers.set('X-Client-IP', clientIP)

		// Forward the request to the Durable Object
		return await stub.fetch(chatRequest)

	} catch (error) {
		console.error('[WebSocket Setup Error]', error.message)
		return new Response('Internal server error', { status: 500 })
	}
})

app.get('/', (c) => c.json({ status: 'ok' }))

export default app
export { ChatSession }
