/**
 * Labels shown while a model loads, keyed by the stage reported on /models/sse.
 */
export const MODEL_LOAD_STAGE_LABELS: Record<ApiModelLoadStage, string> = {
	mmproj_model: 'Loading projector',
	spec_model: 'Loading draft',
	text_model: 'Loading weights'
};

/**
 * Share of the bar reserved for each load phase after text_model.
 * text_model fills the rest, so a plain model reaches 100% on its own.
 */
export const MODEL_LOAD_TAIL_SHARE = 0.1;

/** KV cache types the load form offers for K and V. */
export const CACHE_TYPE_OPTIONS = [
	'f16',
	'f32',
	'bf16',
	'q8_0',
	'q4_0',
	'q4_1',
	'iq4_nl',
	'q5_0',
	'q5_1'
];

/** Flash Attention modes the load form offers. */
export const FLASH_ATTN_OPTIONS = ['auto', 'on', 'off'];

/** Loading modes the load form offers, as `--load-mode` values. */
export const LOAD_MODE_OPTIONS = ['auto', 'mmap', 'mlock', 'mmap+mlock', 'none', 'dio'];

/** A boolean the form can leave to the child, or force on or off. */
export const TRI_STATE_OPTIONS = ['default', 'on', 'off'];

/** Load configuration a model falls back to; empty and `default` send no flag. */
export const LOAD_CONFIG_DEFAULTS: ModelLoadConfig = {
	cacheTypeK: 'f16',
	cacheTypeV: 'f16',
	ctxSize: '',
	flashAttn: 'auto',
	kvOffload: 'default',
	kvUnified: 'default',
	loadMode: 'auto',
	nGpuLayers: '',
	temperature: '',
	topP: '',
	topK: '',
	minP: '',
	repeatPenalty: '',
	repeatLastN: ''
};

/** Speculative decoding modes the load form offers. */
export const SPECULATIVE_OPTIONS = ['off', 'draft-model'];
