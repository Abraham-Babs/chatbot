import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import worker from '../src'
import { createProfileChunks } from '../src/chunker.js'
import profile from '../profile.json'

describe('Chatbot Worker Integration & Security Tests', () => {
	it('returns 404 for unknown endpoints and applies security headers', async () => {
		const response = await SELF.fetch('https://example.com/unknown')
		expect(response.status).toBe(404)

		const body = await response.json()
		expect(body).toEqual({ error: 'Not Found' })

		// Security headers
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
		expect(response.headers.get('X-Frame-Options')).toBe('DENY')
		expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000')
		expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
	})

	it('handles CORS preflight for allowed origins', async () => {
		const allowedOrigin = 'https://abraham.dpdns.org'
		const request = new Request('https://example.com/chat', {
			method: 'OPTIONS',
			headers: {
				Origin: allowedOrigin
			}
		})
		const ctx = createExecutionContext()
		const response = await worker.fetch(request, env, ctx)
		await waitOnExecutionContext(ctx)

		expect(response.status).toBe(204)
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe(allowedOrigin)
		expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS')
	})

	it('rejects chat requests missing the WebSocket Upgrade header', async () => {
		const response = await SELF.fetch('https://example.com/chat')
		expect(response.status).toBe(400)

		const body = await response.json()
		expect(body).toEqual({ error: 'WebSocket connection required' })
	})

	it('rejects chat requests with missing or invalid session ID', async () => {
		const request = new Request('https://example.com/chat?sessionId=invalid-uuid', {
			headers: {
				Upgrade: 'websocket'
			}
		})
		const ctx = createExecutionContext()
		const response = await worker.fetch(request, env, ctx)
		await waitOnExecutionContext(ctx)

		expect(response.status).toBe(400)
		const body = await response.json()
		expect(body).toEqual({ error: 'Invalid session ID' })
	})

	it('protects /sync route against unauthorized access', async () => {
		const response = await SELF.fetch('https://example.com/sync', {
			method: 'POST'
		})
		expect(response.status).toBe(401)
		const body = await response.json()
		expect(body).toEqual({ error: 'Unauthorized' })
	})
})

describe('Profile Chunker Unit Tests', () => {
	it('generates non-empty semantic chunks from profile.json', () => {
		const chunks = createProfileChunks(profile)
		expect(chunks.length).toBeGreaterThan(0)

		const ids = chunks.map(c => c.id)
		expect(ids).toContain('core_identity')
		expect(ids).toContain('skills')

		// Verify chunk structure
		for (const chunk of chunks) {
			expect(chunk).toHaveProperty('id')
			expect(chunk).toHaveProperty('section')
			expect(chunk).toHaveProperty('content')
			expect(typeof chunk.content).toBe('string')
			expect(chunk.content.length).toBeGreaterThan(0)
		}
	})
})
