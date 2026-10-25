<script lang="ts">
	import { CollapsibleSection } from '$lib/components/app';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import {
		CACHE_TYPE_OPTIONS,
		FLASH_ATTN_OPTIONS,
		LOAD_MODE_OPTIONS,
		TRI_STATE_OPTIONS
	} from '$lib/constants';
	import { modelsStore } from '$lib/stores';
	import type { ModelLoadConfig } from '$lib/types/models';

	interface Props {
		modelId: string;
	}

	let { modelId }: Props = $props();

	let config = $derived(modelsStore.getLoadConfig(modelId));

	function update(patch: Partial<ModelLoadConfig>): void {
		modelsStore.setLoadConfig(modelId, { ...config, ...patch });
	}

	const rowClass = 'flex items-center gap-3 border-b border-border/30 py-2 last:border-b-0';
	const sectionTrigger = 'flex w-full cursor-pointer items-center gap-2 py-2 text-left';
	const selectTrigger = 'ml-auto h-7 w-36 text-xs';
	const numberInput = 'ml-auto h-7 w-36 text-xs';
</script>

{#snippet selectRow(
	label: string,
	value: string,
	options: readonly string[],
	onPick: (value: string) => void
)}
	<div class={rowClass}>
		<span class="text-sm text-muted-foreground">{label}</span>

		<Select.Root onValueChange={(next) => next && onPick(next)} type="single" {value}>
			<Select.Trigger class={selectTrigger} size="sm">{value}</Select.Trigger>

			<Select.Content>
				{#each options as option (option)}
					<Select.Item label={option} value={option}>{option}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</div>
{/snippet}

{#snippet numberRow(
	label: string,
	value: string,
	placeholder: string,
	onInput: (value: string) => void,
	step = '1'
)}
	<div class={rowClass}>
		<span class="text-sm text-muted-foreground">{label}</span>

		<Input
			class={numberInput}
			inputmode={step === '1' ? 'numeric' : 'decimal'}
			min="0"
			oninput={(event) => onInput(event.currentTarget.value)}
			{placeholder}
			{step}
			type="number"
			{value}
		/>
	</div>
{/snippet}

<div class="mt-4">
	<CollapsibleSection triggerClass={sectionTrigger}>
		{#snippet trigger()}
			<span class="text-sm font-medium">Load configuration</span>
		{/snippet}

		<div class="mt-1">
			{@render numberRow('Context size (total)', config.ctxSize, 'default', (value) =>
				update({ ctxSize: value })
			)}

			{@render numberRow('GPU layers', config.nGpuLayers, 'auto', (value) =>
				update({ nGpuLayers: value })
			)}

			{@render selectRow('KV offload', config.kvOffload, TRI_STATE_OPTIONS, (value) =>
				update({ kvOffload: value })
			)}

			{@render selectRow('Unified KV', config.kvUnified, TRI_STATE_OPTIONS, (value) =>
				update({ kvUnified: value })
			)}

			{@render selectRow('KV cache K', config.cacheTypeK, CACHE_TYPE_OPTIONS, (value) =>
				update({ cacheTypeK: value })
			)}

			{@render selectRow('KV cache V', config.cacheTypeV, CACHE_TYPE_OPTIONS, (value) =>
				update({ cacheTypeV: value })
			)}

			{@render selectRow('Flash Attention', config.flashAttn, FLASH_ATTN_OPTIONS, (value) =>
				update({ flashAttn: value })
			)}

			{@render selectRow('Loading mode', config.loadMode, LOAD_MODE_OPTIONS, (value) =>
				update({ loadMode: value })
			)}

			{#if config.kvUnified === 'off'}
				<p class="pt-2 text-xs text-muted-foreground">
					Context is split across 4 slots when unified KV is off (per slot: size / 4).
				</p>
			{/if}
		</div>
	</CollapsibleSection>

	<CollapsibleSection triggerClass={sectionTrigger}>
		{#snippet trigger()}
			<span class="text-sm font-medium">Sampling defaults</span>
		{/snippet}

		<div class="mt-1">
			{@render numberRow(
				'Temperature',
				config.temperature,
				'default',
				(value) => update({ temperature: value }),
				'0.01'
			)}

			{@render numberRow(
				'Top P',
				config.topP,
				'default',
				(value) => update({ topP: value }),
				'0.01'
			)}

			{@render numberRow('Top K', config.topK, 'default', (value) => update({ topK: value }))}

			{@render numberRow(
				'Min P',
				config.minP,
				'default',
				(value) => update({ minP: value }),
				'0.01'
			)}

			{@render numberRow(
				'Repeat penalty',
				config.repeatPenalty,
				'default',
				(value) => update({ repeatPenalty: value }),
				'0.01'
			)}

			{@render numberRow('Repeat last N', config.repeatLastN, 'default', (value) =>
				update({ repeatLastN: value })
			)}

			<p class="pt-2 text-xs text-muted-foreground">
				Defaults for this model. A request that sends its own value still wins. Empty leaves the
				model's own default.
			</p>
		</div>
	</CollapsibleSection>
</div>
