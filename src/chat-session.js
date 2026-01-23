import profile from '../profile.json'

export class ChatSession {
	constructor(state, env) {
		this.state = state
		this.env = env
		this.connections = new Set()
		this.conversationHistory = []
		this.clientIP = null
	}

	async fetch(request) {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected websocket', { status: 400 })
		this.clientIP = request.headers.get('X-Client-IP') || 'unknown'
		if (this.connections.size >= 5) return new Response('Connection limit exceeded', { status: 429 })

		const [client, server] = Object.values(new WebSocketPair())
		this.state.acceptWebSocket(server)
		this.connections.add(server)
		server.addEventListener('close', () => this.connections.delete(server))

		// Set expiration alarm on first access
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

			// Issue 5: Native Rate Limiting
			const { success } = await this.env.RATE_LIMITER.limit({ key: this.clientIP })
			if (!success) {
				return ws.send(JSON.stringify({
					type: 'chunk',
					text: "I've hit my daily conversation limit for today! I'd love to chat more tomorrow, or you can reach out to me via email at babalolabeat@gmail.com.",
					done: true
				}))
			}

			await this.handleChatMessage(ws, data.message)
		} catch (error) {
			ws.send(JSON.stringify({ type: 'error', error: error.message }))
		}
	}

	async handleChatMessage(ws, message) {
		const userMsg = message.trim()
		if (userMsg.length > 500) {
			return ws.send(JSON.stringify({ type: 'error', error: 'Message too long (max 500 chars)' }))
		}
		if (!userMsg) return

		ws.send(JSON.stringify({ type: 'status', status: 'thinking' }))

		try {
			// Issue 2: Parallelize RAG retrieval and history management
			const [relevantChunks, _] = await Promise.all([
				this.getRelevantProfileChunks(userMsg),
				Promise.resolve(this.truncateHistory())
			])

			const systemPrompt = this.buildSystemPrompt(relevantChunks)
			const messages = [
				{ role: 'system', content: systemPrompt },
				...this.conversationHistory,
				{ role: 'user', content: `[USER_INPUT]\n${userMsg}\n[END_USER_INPUT]` }
			]

			// Issue 1: Native Streaming
			const stream = await this.env.ai.run('@cf/meta/llama-3.1-8b-instruct', {
				messages,
				stream: true,
				max_tokens: 200
			})

			ws.send(JSON.stringify({ type: 'status', status: 'responding' }))

			let fullAIResponse = ""
			const decoder = new TextDecoder()
			let buffer = ""

			for await (const chunk of stream) {
				buffer += decoder.decode(chunk, { stream: true })
				let lines = buffer.split(/\n+/)
				buffer = lines.pop() || ""

				for (const line of lines) {
					const trimmedLine = line.trim()
					if (!trimmedLine || trimmedLine === 'data: [DONE]') continue

					const match = trimmedLine.match(/^data:\s*(.*)$/)
					if (match) {
						try {
							const data = JSON.parse(match[1])
							if (data.response) {
								fullAIResponse += data.response
								ws.send(JSON.stringify({ type: 'chunk', text: data.response, done: false }))
							}
						} catch (e) {
							// If parsing fails, it might be a split line, though split lines are largely handled by pop()
						}
					}
				}
			}

			// Capture any final response that might have been left in the buffer
			if (buffer) {
				const trimmedLine = buffer.trim()
				const match = trimmedLine.match(/^data:\s*(.*)$/)
				if (match && trimmedLine !== 'data: [DONE]') {
					try {
						const data = JSON.parse(match[1])
						if (data.response) {
							fullAIResponse += data.response
							ws.send(JSON.stringify({ type: 'chunk', text: data.response, done: false }))
						}
					} catch (e) { }
				}
			}

			this.conversationHistory.push(
				{ role: 'user', content: userMsg },
				{ role: 'assistant', content: fullAIResponse }
			)

			ws.send(JSON.stringify({ type: 'chunk', text: '', done: true }))

			// Background logging (Fire and forget via Durable Object state)
			this.state.waitUntil(this.logInteraction(userMsg, fullAIResponse, 200))

		} catch (error) {
			console.error('[AI Error]', error)
			ws.send(JSON.stringify({
				type: 'chunk',
				text: this.getFallbackResponse(),
				done: true
			}))
		}
	}

	async logInteraction(query, response, tokens) {
		try {
			if (!this.env.chatbot_logs) return

			// Use a secret for hashing (set via npx wrangler secret put LOG_SALT)
			const salt = this.env.LOG_SALT || "development-fallback-salt"
			const msgUint8 = new TextEncoder().encode(this.clientIP + salt)
			const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8)
			const ipHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)

			const scrubbedQuery = query.replace(/[a-zA-Z0-9._%+-]+@ [a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED]')

			await this.env.chatbot_logs.prepare(
				"INSERT INTO interactions (session_id, ip_hash, query, response, tokens, model) VALUES (?, ?, ?, ?, ?, ?)"
			).bind(
				this.state.id.toString(),
				ipHash,
				scrubbedQuery,
				response,
				tokens,
				'@cf/meta/llama-3.1-8b-instruct'
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
			return results.matches.map(m => m.metadata.content)
		} catch (e) {
			return [`${profile.name} is a ${profile.title}. ${profile.bio}`]
		}
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
- Direct and confident tone.`
	}

	webSocketClose(ws) {
		this.connections.delete(ws)
	}

	async alarm() {
		this.conversationHistory = []
		this.connections.clear()
	}
}
