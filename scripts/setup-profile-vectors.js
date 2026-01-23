import profile from '../profile.json'

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
			// Check if vectors are already initialized
			const existing = await env.VECTORIZE.query({
				vector: new Array(384).fill(0), // Dummy vector for metadata query
				topK: 1,
				returnMetadata: true
			})

			if (existing.matches.length > 0) {
				return new Response('Profile vectors already initialized', { status: 200 })
			}

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

/**
 * Break profile into semantic chunks for RAG
 */
function createProfileChunks(profile) {
	const chunks = []

	// Core identity chunk
	chunks.push({
		id: 'core_identity',
		section: 'identity',
		content: `${profile.name} is a ${profile.title}. ${profile.bio}`
	})

	// Skills chunk
	const skillsText = profile.skills.map(s => `${s.name} (${s.proficiency})`).join(', ')
	chunks.push({
		id: 'skills',
		section: 'skills',
		content: `Skills and proficiencies: ${skillsText}`
	})

	// Experience chunks (one per role)
	profile.experience.forEach((exp, index) => {
		chunks.push({
			id: `experience_${index}`,
			section: 'experience',
			content: `${exp.role} at ${exp.company} (${exp.duration}): ${exp.key_impact}`
		})
	})

	// Education chunks
	profile.education.forEach((edu, index) => {
		const degree = edu.degree || edu.Certification
		const school = edu.school || edu.Platform
		const year = edu.year
		chunks.push({
			id: `education_${index}`,
			section: 'education',
			content: `${degree} from ${school} (${year})`
		})
	})

	// Projects chunks
	profile.projects.forEach((project, index) => {
		chunks.push({
			id: `project_${index}`,
			section: 'projects',
			content: `${project.name}: ${project.description}. Technologies: ${project.tech_stack?.join(', ') || 'Not specified'}`
		})
	})

	// Philosophies chunk
	const philosophiesText = profile.philosophies.map(p => `${p.name}: ${p.description}`).join('. ')
	chunks.push({
		id: 'philosophies',
		section: 'philosophies',
		content: `Personal philosophies: ${philosophiesText}`
	})

	// Personality traits chunk
	const traitsText = profile.personality_traits.map(t =>
		`${t.category}: ${t.details}. ${t.relevance}`
	).join('. ')
	chunks.push({
		id: 'personality',
		section: 'personality',
		content: `Personality and interests: ${traitsText}`
	})

	// Problem solving approach chunk
	chunks.push({
		id: 'problem_solving',
		section: 'approach',
		content: `Problem solving approach: ${Array.isArray(profile.problem_solving_approach)
			? profile.problem_solving_approach.join(' ')
			: profile.problem_solving_approach}`
	})

	// Communication style chunk
	chunks.push({
		id: 'communication',
		section: 'communication',
		content: `Communication style: ${profile.communication_style}`
	})

	return chunks
}