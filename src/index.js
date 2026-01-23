import { Hono } from 'hono'
import { ChatSession } from './chat-session.js'
import profile from '../profile.json'

// UUID v4 validation regex (crypto.randomUUID() format)
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidUUID(uuid) {
	return typeof uuid === 'string' && UUID_V4_REGEX.test(uuid)
}

const app = new Hono()

// ============================================================================
// 1. TIER ONE: GLOBAL CORS SHIELD
// ============================================================================
app.use('*', async (c, next) => {
	const origin = c.req.header('origin') || ''
	const allowedOrigins = (c.env.ALLOWED_ORIGINS || '').split(',')

	if (allowedOrigins.includes(origin)) {
		c.header('Access-Control-Allow-Origin', origin)
		c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
		c.header('Access-Control-Allow-Headers', 'Content-Type, Upgrade, Authorization')
		c.header('Access-Control-Max-Age', '86400')
	}

	if (c.req.method === 'OPTIONS') {
		return c.text('', 204)
	}

	await next()
})

// ============================================================================
// 2. TIER TWO: EXEMPT WEBSOCKET ROUTE
// Handled before security middleware to avoid CSP handshake conflicts.
// ============================================================================
app.get('/chat', async (c) => {
	try {
		const upgradeHeader = c.req.header('Upgrade') || ''
		if (upgradeHeader.toLowerCase() !== 'websocket') {
			return c.json({ error: 'WebSocket connection required' }, 400)
		}

		const sessionId = c.req.query('sessionId')
		if (!sessionId || !isValidUUID(sessionId)) {
			return c.json({ error: 'Invalid session ID' }, 400)
		}

		const clientIP = c.req.header('cf-connecting-ip') || 'unknown'
		const id = c.env.CHAT_SESSION.idFromName(sessionId)
		const stub = c.env.CHAT_SESSION.get(id)

		// Create a direct request to the Durable Object
		// Passing raw headers ensures protocol stability
		const chatRequest = new Request(c.req.url, {
			method: c.req.method,
			headers: c.req.raw.headers,
			body: c.req.raw.body
		})
		chatRequest.headers.set('X-Client-IP', clientIP)

		return await stub.fetch(chatRequest)
	} catch (error) {
		console.error('[WebSocket Setup Error]', error.message)
		return new Response('Internal server error', { status: 500 })
	}
})

// ============================================================================
// 3. TIER THREE: SECURITY HEADERS MIDDLEWARE
// Only applied to non-WebSocket routes (Sync, Errors, etc.) below this point.
// ============================================================================
app.use('*', async (c, next) => {
	await next()

	c.header('X-Content-Type-Options', 'nosniff')
	c.header('X-Frame-Options', 'DENY')
	c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
	c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
	c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
})

// ============================================================================
// 4. TIER FOUR: SECURED SYNC ROUTE
// Requires SYNC_SECRET_KEY for AI re-indexing.
// ============================================================================
app.post('/sync', async (c) => {
	try {
		const authHeader = c.req.header('Authorization')
		const syncKey = c.env.SYNC_SECRET_KEY

		if (!syncKey || authHeader !== `Bearer ${syncKey}`) {
			return c.json({ error: 'Unauthorized' }, 401)
		}

		const chunks = createProfileChunks(profile)
		const embeddings = await Promise.all(chunks.map(async (chunk) => {
			const res = await c.env.ai.run('@cf/baai/bge-small-en-v1.5', { text: chunk.content })
			return {
				id: chunk.id,
				values: res.data[0],
				metadata: { section: chunk.section, content: chunk.content }
			}
		}))

		await c.env.VECTORIZE.insert(embeddings)
		return c.json({ status: 'success', chunks: chunks.length })
	} catch (error) {
		return c.json({ error: error.message }, 500)
	}
})

// ============================================================================
// 5. TIER FIVE: GLOBAL REJECTION (HIDE API)
// Catch-all for any other path (including /) to hide the API from probing.
// ============================================================================
app.notFound((c) => {
	return c.json({ error: 'Not Found' }, 404)
})

// ============================================================================
// HELPERS
// ============================================================================

function createProfileChunks(obj, path = []) {
	let chunks = []

	for (const [key, value] of Object.entries(obj)) {
		const currentPath = [...path, key]
		const section = currentPath[0]

		if (value && typeof value === 'object' && !Array.isArray(value)) {
			chunks.push(...createProfileChunks(value, currentPath))
		} else if (Array.isArray(value)) {
			value.forEach((item, index) => {
				if (typeof item === 'object') {
					chunks.push(...createProfileChunks(item, [...currentPath, index]))
				} else {
					chunks.push({
						id: [...currentPath, index].join('_'),
						section: section,
						content: `${currentPath.join(' ')}: ${item}`
					})
				}
			})
		} else {
			chunks.push({
				id: currentPath.join('_'),
				section: section,
				content: `${currentPath.join(' ')}: ${value}`
			})
		}
	}

	if (path.length === 0) {
		return consolidateChunks(chunks)
	}
	return chunks
}

function consolidateChunks(chunks) {
	const grouped = chunks.reduce((acc, chunk) => {
		acc[chunk.section] = acc[chunk.section] || []
		acc[chunk.section].push(chunk.content)
		return acc
	}, {})

	return Object.entries(grouped).map(([section, contents]) => ({
		id: `section_${section}`,
		section: section,
		content: `${section.toUpperCase()} INFO:\n${contents.join('\n')}`
	}))
}

export default app
export { ChatSession }
