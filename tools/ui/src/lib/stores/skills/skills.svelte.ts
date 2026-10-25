import { apiPost } from '$lib/utils';
import type { Skill } from '$lib/utils/skills';
import { matchSkills } from '$lib/utils/skills';

export interface SkillsState {
	available: Skill[];
	enabled: Skill[];
	loading: boolean;
	error: string | null;
}

export class SkillStore {
	available = $state<Skill[]>([]);
	enabled = $state<Skill[]>([]);
	loading = $state(false);
	error = $state<string | null>(null);

	async scan(directory: string): Promise<void> {
		this.loading = true;
		this.error = null;
		try {
			const { skills } = await apiPost<{ skills: Skill[] }>('/v1/skills/scan', {
				directory
			});
			this.available = skills ?? [];
			// keep only enabled skills that were re-discovered
			this.enabled = this.enabled.filter((e) =>
				this.available.some((a) => a.id === e.id)
			);
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
			console.error('[SkillStore] scan failed:', err);
		} finally {
			this.loading = false;
		}
	}

	enable(id: string): void {
		const skill = this.available.find((s) => s.id === id);
		if (!skill) return;
		if (!this.enabled.some((s) => s.id === id)) {
			this.enabled = [...this.enabled, skill];
		}
	}

	disable(id: string): void {
		this.enabled = this.enabled.filter((s) => s.id !== id);
	}

	isEnabled(id: string): boolean {
		return this.enabled.some((s) => s.id === id);
	}

	match(query: string): Skill[] {
		return matchSkills(query, this.enabled);
	}
}

export const skillsStore = new SkillStore();
