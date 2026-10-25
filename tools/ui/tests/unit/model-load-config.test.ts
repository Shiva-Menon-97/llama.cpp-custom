// The load config is the only non-trivial part of the load request: UI fields
// become wire keys, and empty ones must not reach the server.

import { LOAD_CONFIG_DEFAULTS } from '$lib/constants';
import { loadConfigToBody } from '$lib/services/models.service';
import type { ModelLoadConfig } from '$lib/types/models';
import { describe, expect, it } from 'vitest';

const config: ModelLoadConfig = {
	cacheTypeK: 'q8_0',
	cacheTypeV: 'q8_0',
	ctxSize: '32768',
	flashAttn: 'on',
	kvOffload: 'on',
	kvUnified: 'off',
	loadMode: 'mmap',
	nGpuLayers: '99',
	temperature: '0.7',
	topP: '0.9',
	topK: '40',
	minP: '0.05',
	repeatPenalty: '1.1',
	repeatLastN: '64'
};

describe('loadConfigToBody', () => {
	it('maps every field to its wire key', () => {
		expect(loadConfigToBody(config)).toStrictEqual({
			cache_type_k: 'q8_0',
			cache_type_v: 'q8_0',
			ctx_size: '32768',
			flash_attn: 'on',
			kv_offload: 'on',
			kv_unified: 'off',
			load_mode: 'mmap',
			n_gpu_layers: '99',
			temperature: '0.7',
			top_p: '0.9',
			top_k: '40',
			min_p: '0.05',
			repeat_penalty: '1.1',
			repeat_last_n: '64'
		});
	});

	it('omits empty number fields', () => {
		expect(loadConfigToBody(LOAD_CONFIG_DEFAULTS)).toStrictEqual({
			cache_type_k: 'f16',
			cache_type_v: 'f16',
			flash_attn: 'auto',
			kv_offload: 'default',
			kv_unified: 'default',
			load_mode: 'auto'
		});
	});

	it('keeps an explicit zero', () => {
		expect(
			loadConfigToBody({
				...LOAD_CONFIG_DEFAULTS,
				ctxSize: '0',
				nGpuLayers: '0',
				temperature: '0',
				minP: '0',
				topK: '0'
			})
		).toMatchObject({
			ctx_size: '0',
			n_gpu_layers: '0',
			temperature: '0',
			min_p: '0',
			top_k: '0'
		});
	});
});
