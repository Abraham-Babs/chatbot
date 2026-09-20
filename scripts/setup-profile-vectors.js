import profile from '../profile.json'
import { createProfileChunks } from '../src/chunker.js'
export { ChatSession } from '../src/chat-session.js'

/**
 * Script to chunk profile data and generate embeddings for RAG
 * Run this once to initialize the Vectorize database with profile chunks
 *
 * Usage: npx wrangler deploy scripts/setup-profile-vectors.js --dry-run
 * Then: npx wrangler deploy scripts/setup-profile-vectors.js
 */

export default {
	async fetch(request, env) {
		try {
			// Create semantic chunks from profile data
			const chunks = createProfileChunks(profile)

			console.log(`Processing ${chunks.length} profile chunks...`)

			// Generate embeddings for each chunk
			const embeddings = []
			for (const chunk of chunks) {
				console.log(`Generating embedding for: ${chunk.id}`)

				const embedding = await env.ai.run('@cf/baai/bge-small-en-v1.5', {
					text: chunk.content
				})

				embeddings.push({
					id: chunk.id,
					values: embedding.data[0],
					metadata: {
						section: chunk.section,
						content: chunk.content
					}
				})
			}

			// Insert all embeddings into Vectorize
			console.log('Inserting embeddings into Vectorize...')
			await env.VECTORIZE.insert(embeddings)

			return new Response(`Successfully initialized ${embeddings.length} profile vectors`, { status: 200 })

		} catch (error) {
			console.error('Error setting up profile vectors:', error)
			return new Response(`Error: ${error.message}`, { status: 500 })
		}
	}
}