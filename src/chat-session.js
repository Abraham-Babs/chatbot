import profile from '../profile.json'

const MODEL_POOL = [
	'@cf/meta/llama-3.1-8b-instruct',
	'@cf/mistral/mistral-7b-instruct-v0.2',
	'@cf/meta/llama-3-8b-instruct'
]

export class ChatSession {
	constructor(state, env) {
		this.state = state
		this.env = env
		this.connections = new Set()
		this.conversationHistory = []
		this.socketIPs = new WeakMap()
	}

	async fetch(request) {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected websocket', { status: 400 })
		}

		if (this.connections.size >= 5) {
			return new Response('Connection limit exceeded', { status: 429 })
		}

		const clientIP = request.headers.get('X-Client-IP') || 'unknown'
		const [client, server] = Object.values(new WebSocketPair())

		this.state.acceptWebSocket(server)
		this.connections.add(server)
		this.socketIPs.set(server, clientIP)

		server.addEventListener('close', () => {
			this.connections.delete(server)
		})

		// Set expiration alarm on first access (24h cleanup)
		if (!(await this.state.storage.getAlarm())) {
			await this.state.storage.setAlarm(Date.now() + 86400000)
		}

		return new Response(null, { status: 101, webSocket: client })
	}

	async webSocketMessage(ws, msg) {
		try {
			if (msg.length > 1024) throw new Error('Message too large')
			const data = JSON.parse(msg)

			if (data.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }))
			if (data.type !== 'chat') return

			const clientIP = this.socketIPs.get(ws) || 'unknown'

			// Native Edge Rate Limiting (10 req/min)
			const { success } = await this.env.RATE_LIMITER.limit({ key: clientIP })
			if (!success) {
				return ws.send(JSON.stringify({
					type: 'chunk',
					text: `Rate limit reached (10 messages per minute). Please wait a moment before trying again, or reach out to me via email at ${profile.contact}.`,
					done: true
				}))
			}

			await this.handleChatMessage(ws, data.message, clientIP)
		} catch (error) {
			ws.send(JSON.stringify({ type: 'error', error: error.message }))
		}
	}

	async handleChatMessage(ws, message, clientIP) {
		const userMsg = typeof message === 'string' ? message.trim() : ''
		if (userMsg.length > 500) {
			return ws.send(JSON.stringify({ type: 'error', error: 'Message too long (max 500 chars)' }))
		}
		if (!userMsg) return

		// Session message quota & Call to Action
		this.messageCount = (this.messageCount || 0) + 1
		if (this.messageCount > 20) {
			return ws.send(JSON.stringify({
				type: 'chunk',
				text: `We've reached the conversation limit for this session! I'd love to discuss potential opportunities, technical challenges, or collaborations directly—please reach out to Abraham at ${profile.contact}.`,
				done: true
			}))
		}

		ws.send(JSON.stringify({ type: 'status', status: 'thinking' }))

		try {
			const [relevantChunks] = await Promise.all([
				this.getRelevantProfileChunks(userMsg),
				Promise.resolve(this.truncateHistory())
			])

			const systemPrompt = this.buildSystemPrompt(relevantChunks)
			const messages = [
				{ role: 'system', content: systemPrompt },
				...this.conversationHistory,
				{ role: 'user', content: userMsg }
			]

			// Waterfall through prioritized model pool
			let stream = null
			let usedModel = MODEL_POOL[0]
			let lastModelError = null

			for (const model of MODEL_POOL) {
				try {
					stream = await this.env.ai.run(model, {
						messages,
						stream: true,
						max_tokens: 400
					})
					usedModel = model
					break
				} catch (err) {
					console.warn(`[AI Model Pool] ${model} unavailable:`, err.message)
					lastModelError = err
				}
			}

			if (!stream) {
				throw lastModelError || new Error('All models in fallback pool failed')
			}

			ws.send(JSON.stringify({ type: 'status', status: 'responding' }))

			let fullAIResponse = ""
			const decoder = new TextDecoder()
			let buffer = ""

			for await (const chunk of stream) {
				buffer += decoder.decode(chunk, { stream: true })
				const lines = buffer.split(/\r?\n/)
				buffer = lines.pop() ?? ""

				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed || trimmed === 'data: [DONE]') continue

					if (trimmed.startsWith('data:')) {
						try {
							const data = JSON.parse(trimmed.slice(5).trim())
							if (data.response) {
								fullAIResponse += data.response
								ws.send(JSON.stringify({ type: 'chunk', text: data.response, done: false }))
							}
						} catch {
							// Incomplete chunk buffer, skip
						}
					}
				}
			}

			if (buffer) {
				const trimmed = buffer.trim()
				if (trimmed.startsWith('data:') && trimmed !== 'data: [DONE]') {
					try {
						const data = JSON.parse(trimmed.slice(5).trim())
						if (data.response) {
							fullAIResponse += data.response
							ws.send(JSON.stringify({ type: 'chunk', text: data.response, done: false }))
						}
					} catch {}
				}
			}

			this.conversationHistory.push(
				{ role: 'user', content: userMsg },
				{ role: 'assistant', content: fullAIResponse }
			)

			ws.send(JSON.stringify({ type: 'chunk', text: '', done: true }))

			// Background logging (Fire and forget via Durable Object state)
			this.state.waitUntil(this.logInteraction(userMsg, fullAIResponse, 400, clientIP, usedModel))

		} catch (error) {
			console.error('[AI Error]', error)
			ws.send(JSON.stringify({
				type: 'chunk',
				text: this.getFallbackResponse(),
				done: true
			}))
		}
	}

	async logInteraction(query, response, tokens, clientIP, modelName) {
		try {
			if (!this.env.chatbot_logs) return

			const salt = this.env.LOG_SALT || "development-fallback-salt"
			const msgUint8 = new TextEncoder().encode((clientIP || 'unknown') + salt)
			const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8)
			const ipHash = Array.from(new Uint8Array(hashBuffer))
				.map(b => b.toString(16).padStart(2, '0'))
				.join('')
				.slice(0, 16)

			// Fix email scrubber regex (removed rogue space after @)
			const scrubbedQuery = query.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED]')

			await this.env.chatbot_logs.prepare(
				"INSERT INTO interactions (session_id, ip_hash, query, response, tokens, model) VALUES (?, ?, ?, ?, ?, ?)"
			).bind(
				this.state.id.toString(),
				ipHash,
				scrubbedQuery,
				response,
				tokens,
				modelName || '@cf/meta/llama-3.1-8b-instruct'
			).run()
		} catch (e) {
			console.warn('[D1 Logging Error]', e.message)
		}
	}

	getFallbackResponse() {
		const fallbacks = [
			"I'm currently having a bit of trouble connecting to my thought processes. Could you try asking that again in a moment?",
			"My brain is taking a quick tactical break! Please reach out again shortly, or email me if it's urgent.",
			"Running into some technical static on the AI side—even Digital Twins need a reboot sometimes! I'll be back online soon.",
			"Service is currently a bit patchy. While I fix that, feel free to check out my projects in the meantime!"
		]
		return fallbacks[Math.floor(Math.random() * fallbacks.length)]
	}

	async getRelevantProfileChunks(query) {
		try {
			const embedding = await this.env.ai.run('@cf/baai/bge-small-en-v1.5', { text: query })
			const results = await this.env.VECTORIZE.query({
				vector: embedding.data[0],
				topK: 3,
				returnMetadata: true
			})
			if (results.matches && results.matches.length > 0) {
				return results.matches.map(m => m.metadata.content)
			}
		} catch (e) {
			console.warn('[Vectorize Query Failed, falling back to core profile]', e.message)
		}

		// Resilient fallback context
		return [
			`${profile.name} is a ${profile.title}. ${profile.bio}`,
			`Problem solving: ${profile.problem_solving_approach}`,
			`Contact: ${profile.contact}`
		]
	}

	truncateHistory() {
		if (this.conversationHistory.length > 10) {
			this.conversationHistory = this.conversationHistory.slice(-10)
		}
	}

	buildSystemPrompt(chunks) {
		return `You are the AI Digital Twin of ${profile.name}, a ${profile.title}.
Your goal is to demonstrate technical expertise and professional value to recruiters and hiring managers.

CONTEXT:
${chunks.join('\n\n')}

GUIDELINES:
- Be engaging, professional, and proactive in highlighting core strengths (e.g., First Principles thinking, Security by Design, eagerness to learn).
- When possible, tie answers back to specific impact mentioned in the context.
- Keep responses concise (under 750 chars).
- Do not fabricate or hallucinate accomplishments outside the provided context. If asked something unknown, politely direct them to contact Abraham directly via ${profile.contact}.
- Direct, clear, and confident tone.`
	}

	webSocketClose(ws) {
		this.connections.delete(ws)
	}

	async alarm() {
		this.conversationHistory = []
		this.connections.clear()
		this.messageCount = 0
	}
}
