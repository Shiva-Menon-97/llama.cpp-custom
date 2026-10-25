// Skill matching + shared Skill type.
//
// Skill content is matched against the user's query by simple token overlap:
// score = number of query tokens that appear in the skill's name or
// description. Case-insensitive, punctuation ignored. Top 3 matches returned.

export interface Skill {
	id: string;
	name: string;
	description: string;
	content: string;
	path: string;
}

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length > 0)
	);
}

export function matchSkills(query: string, skills: Skill[]): Skill[] {
	if (!query.trim()) return [];

	const queryTokens = tokenize(query);

	const scored = skills
		.map((skill) => {
			const skillTokens = tokenize(`${skill.name} ${skill.description}`);
			let score = 0;
			for (const t of queryTokens) {
				if (skillTokens.has(t)) score++;
			}
			return { skill, score };
		})
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, 3)
		.map((s) => s.skill);

	return scored;
}
