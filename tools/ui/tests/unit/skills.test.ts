import { describe, expect, it } from 'vitest';
import { matchSkills } from '$lib/utils/skills';

const skills = [
	{ id: 'a', name: 'Code Review', description: 'Review code for bugs and style', content: '', path: 'a/SKILL.md' },
	{ id: 'b', name: 'Summarize', description: 'Summarize long documents', content: '', path: 'b/SKILL.md' },
	{ id: 'c', name: 'Translate', description: 'Translate text between languages', content: '', path: 'c/SKILL.md' },
	{ id: 'd', name: 'Format JSON', description: 'Pretty-print JSON', content: '', path: 'd/SKILL.md' }
];

describe('matchSkills', () => {
	it('returns empty for an empty query', () => {
		expect(matchSkills('', skills)).toEqual([]);
		expect(matchSkills('   ', skills)).toEqual([]);
	});

	it('returns nothing when no tokens overlap', () => {
		expect(matchSkills('xyzzy frobnicate', skills)).toEqual([]);
	});

	it('matches by skill name (case-insensitive)', () => {
		const result = matchSkills('code review', skills);
		expect(result.map((s) => s.id)).toEqual(['a']);
	});

	it('matches by skill description', () => {
		const result = matchSkills('languages', skills);
		expect(result.map((s) => s.id)).toEqual(['c']);
	});

	it('ranks higher-scoring matches first', () => {
		// 'code' matches both 'Code Review' (name) and 'Format JSON' (description: code-ish? no)
		// Use 'review code' -> matches Code Review twice (name+desc)
		const result = matchSkills('review code', skills);
		expect(result.map((s) => s.id)[0]).toBe('a');
	});

	it('caps results at top 3', () => {
		// every skill matches the word 'text' via descriptions? only Summarize/Translate mention docs/text
		// Instead add a 5th skill matching a common token
		const many = [
			...skills,
			{ id: 'e', name: 'Extract', description: 'Extract text from images', content: '', path: 'e/SKILL.md' },
			{ id: 'f', name: 'Rewrite', description: 'Rewrite text for clarity', content: '', path: 'f/SKILL.md' }
		];
		const result = matchSkills('text', many);
		expect(result.length).toBeLessThanOrEqual(3);
	});

	it('only returns enabled-relevant matches (query tokens present)', () => {
		const result = matchSkills('Review', skills);
		expect(result.map((s) => s.id)).toEqual(['a']);
	});
});
