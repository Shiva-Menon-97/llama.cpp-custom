<script lang="ts">
	import { Switch } from '$lib/components/ui/switch';
	import { Button } from '$lib/components/ui/button';
	import { skillsStore } from '$lib/stores';

	let directory = $state('');

	async function handleScan() {
		await skillsStore.scan(directory);
	}

	function toggle(skillId: string) {
		if (skillsStore.isEnabled(skillId)) skillsStore.disable(skillId);
		else skillsStore.enable(skillId);
	}
</script>

<div class="space-y-4 p-4">
	<div class="flex flex-col sm:flex-row sm:items-end gap-2">
		<label for="skill-directory" class="text-sm font-medium text-muted-foreground shrink-0">Skill directory</label>
		<input
			id="skill-directory"
			type="text"
			bind:value={directory}
			placeholder="Directory containing SKILL.md files"
			class="flex-1 border border-input bg-background px-3 py-2 text-sm rounded-md shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
			disabled={skillsStore.loading}
		/>
		<Button onclick={handleScan} disabled={skillsStore.loading || !directory.trim()} size="sm">
			{#if skillsStore.loading} Scanning... {:else} Scan {/if}
		</Button>
	</div>

	{#if skillsStore.error}
		<div class="text-sm text-destructive">{skillsStore.error}</div>
	{/if}

	{#if skillsStore.available.length === 0}
		<div class="text-sm text-muted-foreground">
			No SKILL.md files found. Point the directory at a folder containing SKILL.md files.
		</div>
	{:else}
		<div class="space-y-2 border border-input rounded-lg p-3">
			{#each skillsStore.available as skill (skill.id)}
				<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-2 rounded hover:bg-muted">
					<div class="flex flex-col gap-1">
						<div class="text-sm font-medium">{skill.name}</div>
						<div class="text-xs text-muted-foreground truncate max-w-[30rem]" title={skill.description}>
							{skill.description}
						</div>
						<div class="text-[10px] text-muted-foreground truncate" title={skill.path}>
							{skill.path}
						</div>
					</div>
					<Switch
						checked={skillsStore.isEnabled(skill.id)}
						onCheckedChange={() => toggle(skill.id)}
					/>
				</div>
			{/each}
		</div>
		<div class="text-xs text-muted-foreground">
			{skillsStore.enabled.length} of {skillsStore.available.length} skill(s) enabled
		</div>
	{/if}
</div>
