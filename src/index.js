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
	const allowedOrigins = (c.env.ALLOWED_ORIGINS || '').split(',')

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

	if (c.req.method === 'POST' && c.req.path !== '/sync') {
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
		const upgradeHeader = c.req.header('Upgrade')
		if (upgradeHeader !== 'websocket') return c.json({ error: 'WebSocket connection required' }, 400)

		const sessionId = c.req.query('sessionId')
		if (!sessionId || !isValidUUID(sessionId)) return c.json({ error: 'Invalid session ID' }, 400)

		const clientIP = c.req.header('cf-connecting-ip') || 'unknown'
		const id = c.env.CHAT_SESSION.idFromName(sessionId)
		const stub = c.env.CHAT_SESSION.get(id)

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

// Sync endpoint to vectorize profile.json
app.post('/sync', async (c) => {
	try {
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

function createProfileChunks(obj, path = []) {
	let chunks = []

	for (const [key, value] of Object.entries(obj)) {
		const currentPath = [...path, key]
		const section = currentPath[0]

		if (value && typeof value === 'object' && !Array.isArray(value)) {
			// Recursive call for nested objects
			chunks.push(...createProfileChunks(value, currentPath))
		} else if (Array.isArray(value)) {
			// Handle arrays (e.g., skills, experience)
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
			// Primitive values
			chunks.push({
				id: currentPath.join('_'),
				section: section,
				content: `${currentPath.join(' ')}: ${value}`
			})
		}
	}

	// If this is the root call, group small related chunks into more context-rich strings
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

app.get('/', (c) => c.json({ status: 'ok' }))

export default app
export { ChatSession }
