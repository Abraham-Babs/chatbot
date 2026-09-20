/**
 * Semantic chunking utility for profile data in RAG pipelines.
 * Shared between initialization scripts and runtime sync endpoints.
 */
export function createProfileChunks(profile) {
	if (!profile) return []

	const chunks = []

	// 1. Core Identity
	if (profile.name && profile.title) {
		chunks.push({
			id: 'core_identity',
			section: 'identity',
			content: `${profile.name} is a ${profile.title}. ${profile.bio || ''}`.trim()
		})
	}

	// 2. Skills & Proficiencies
	if (Array.isArray(profile.skills) && profile.skills.length > 0) {
		const skillsText = profile.skills
			.map(s => typeof s === 'object' ? `${s.name} (${s.proficiency})` : s)
			.join(', ')
		chunks.push({
			id: 'skills',
			section: 'skills',
			content: `Skills and proficiencies: ${skillsText}`
		})
	}

	// 3. Work Experience (granular per role for precise retrieval)
	if (Array.isArray(profile.experience)) {
		profile.experience.forEach((exp, index) => {
			chunks.push({
				id: `experience_${index}`,
				section: 'experience',
				content: `${exp.role} at ${exp.company} (${exp.duration}): ${exp.key_impact || exp.description || ''}`.trim()
			})
		})
	}

	// 4. Education & Certifications
	if (Array.isArray(profile.education)) {
		profile.education.forEach((edu, index) => {
			const credential = edu.degree || edu.Certification || 'Education'
			const institution = edu.school || edu.Platform || ''
			const year = edu.year ? ` (${edu.year})` : ''
			chunks.push({
				id: `education_${index}`,
				section: 'education',
				content: `${credential}${institution ? ` from ${institution}` : ''}${year}`.trim()
			})
		})
	}

	// 5. Projects
	if (Array.isArray(profile.projects)) {
		profile.projects.forEach((proj, index) => {
			const tech = proj.tech_stack?.join(', ') || 'Not specified'
			chunks.push({
				id: `project_${index}`,
				section: 'projects',
				content: `${proj.name}: ${proj.description || ''}. Technologies: ${tech}`.trim()
			})
		})
	}

	// 6. Core Philosophies
	if (Array.isArray(profile.philosophies) && profile.philosophies.length > 0) {
		const philosophiesText = profile.philosophies
			.map(p => `${p.name}: ${p.description}`)
			.join('. ')
		chunks.push({
			id: 'philosophies',
			section: 'philosophies',
			content: `Professional philosophies: ${philosophiesText}`
		})
	}

	// 7. Personality & Interests
	if (Array.isArray(profile.personality_traits) && profile.personality_traits.length > 0) {
		const traitsText = profile.personality_traits
			.map(t => `${t.category}: ${t.details}. ${t.relevance || ''}`.trim())
			.join('. ')
		chunks.push({
			id: 'personality',
			section: 'personality',
			content: `Personality traits and work style: ${traitsText}`
		})
	}

	// 8. Problem Solving Approach
	if (profile.problem_solving_approach) {
		const approachText = Array.isArray(profile.problem_solving_approach)
			? profile.problem_solving_approach.join(' ')
			: profile.problem_solving_approach
		chunks.push({
			id: 'problem_solving',
			section: 'approach',
			content: `Problem solving approach: ${approachText}`
		})
	}

	// 9. Communication Style
	if (profile.communication_style) {
		chunks.push({
			id: 'communication',
			section: 'communication',
			content: `Communication style: ${profile.communication_style}`
		})
	}

	return chunks
}
