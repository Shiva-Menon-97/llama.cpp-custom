<script lang="ts">
	import { ChatFormPickerList, ChatFormPickerListItem } from '$lib/components/app/chat';
	import * as Popover from '$lib/components/ui/popover';
	import { KeyboardKey } from '$lib/enums';
	import { usePickerNavigation } from '$lib/hooks/use-picker-navigation.svelte';
	import { skillsStore } from '$lib/stores';
	import type { Skill } from '$lib/utils/skills';

	interface Props {
		class?: string;
		isOpen: boolean;
		query: string;
		customAnchor?: HTMLElement | null;
		onClose: () => void;
		onSelect: (skill: Skill) => void;
		onOpened?: () => void;
	}

	let {
		class: className = '',
		customAnchor = null,
		isOpen,
		onClose,
		onOpened,
		onSelect,
		query
	}: Props = $props();

	const nav = usePickerNavigation({
		count: () => displayedSkills.length,
		isOpen: () => isOpen,
		onClose: () => onClose(),
		onSelect: (index) => handleSelect(displayedSkills[index])
	});

	const trimmedQuery = $derived((query ?? '').trim());

	const displayedSkills = $derived(
		skillsStore.enabled.filter(
			(s) =>
				s.name.toLowerCase().includes(trimmedQuery.toLowerCase()) ||
				s.description.toLowerCase().includes(trimmedQuery.toLowerCase())
		)
	);

	$effect(() => {
		if (isOpen) nav.reset(0);
	});

	$effect(() => {
		if (isOpen) onOpened?.();
	});

	function handleSelect(skill: Skill) {
		onSelect(skill);
		onClose();
	}

	export function handleKeydown(event: KeyboardEvent): boolean {
		if (isOpen && event.key === KeyboardKey.ENTER) {
			event.preventDefault();

			if (nav.hoveredIndex >= 0 && displayedSkills[nav.hoveredIndex]) {
				handleSelect(displayedSkills[nav.hoveredIndex]);
			}

			return true;
		}

		return nav.handleKeydown(event);
	}
</script>

<Popover.Root
	onOpenChange={(open) => {
		if (!open) onClose();
	}}
	open={isOpen}
>
	<Popover.Trigger
		aria-hidden="true"
		class="pointer-events-none absolute inset-0 opacity-0"
		tabindex={-1}
	>
		<span class="sr-only">Open skill picker</span>
	</Popover.Trigger>

	<Popover.Content
		align="start"
		class="w-[var(--bits-popover-anchor-width)] max-w-none rounded-xl border-border/50 p-0 shadow-xl"
		{customAnchor}
		onCloseAutoFocus={(event) => event.preventDefault()}
		onOpenAutoFocus={(event) => event.preventDefault()}
		onkeydown={handleKeydown}
		preventScroll={false}
		side="top"
		sideOffset={12}
	>
		<ChatFormPickerList
			emptyMessage="No matching skills"
			isLoading={false}
			itemKey={(skill) => skill.id}
			items={displayedSkills}
			scrollTrigger={nav.scrollTrigger}
			searchQuery={query ?? ''}
			selectedIndex={nav.hoveredIndex}
			showSearchInput={false}
		>
			{#snippet item(skill, index, isSelected)}
				<ChatFormPickerListItem
					dataIndex={index}
					{isSelected}
					onclick={() => handleSelect(skill)}
					onmouseenter={() => nav.setHover(index)}
				>
					<div class="flex min-w-0 flex-col">
						<div class="flex min-w-0 items-center gap-2">
							<span class="truncate text-sm font-medium">{skill.name}</span>
						</div>
						{#if skill.description}
							<span
								class="min-w-0 flex-1 truncate font-mono text-left text-xs text-muted-foreground"
							>
								{skill.description}
							</span>
						{/if}
					</div>
				</ChatFormPickerListItem>
			{/snippet}
		</ChatFormPickerList>
	</Popover.Content>
</Popover.Root>
