# Implementation plan: extend load config with context, GPU layers, KV offload, unified KV

Add four more options to the per-model load configuration: context window size,
number of layers on GPU (`ngl`), KV cache offload to GPU, and unified KV cache.

> Prerequisite: this is a delta on `ui-model-load-configuration-plan.md`, which
> is NOT in the tree yet. Verified on 2026-10-25: `post_router_models_load`
> (`tools/server/server-models.cpp:2408`) still calls `models.load(meta->name)`
> with no options, there is no `load_config_to_args()`, no `load_options::extra_args`,
> no `ModelLoadConfig`, no load form, and no `test_router_load_config`.
> Land that plan (all 4 phases) first. The refs below assume it has landed.

## Current state (after the base plan lands)

- Transport: structured `load_config` object in `POST /models/load`. Server maps
  it to CLI args via `load_config_to_args()`, validated against allowlists.
- `ModelLoadConfig` (`types/models.d.ts`) has 4 string fields: `cacheTypeK`,
  `cacheTypeV`, `flashAttn`, `loadMode`.
- Form: `ModelsManagerModelLoadConfig.svelte`, 4 `Select` rows.
- Wire type is `Record<string, string>`.

## New options

| UI label | flag(s) | value type |
| --- | --- | --- |
| Context size (total KV pool) | `--ctx-size N` | int, `0` = from model |
| GPU layers | `--n-gpu-layers N` | int, empty = auto |
| KV offload | `--kv-offload` / `--no-kv-offload` | bool |
| Unified KV | `--kv-unified` / `--no-kv-unified` | bool |

Verified in `common/arg.cpp`: ctx-size L1650, kv-unified L1736, kv-offload
L2426, n-gpu-layers L2811.

## Design

- Reuse the existing `load_config` transport. Add 4 fields. Wire type stays
  `Record<string, string>`, so no JSON schema change.
- Numbers as strings, empty = don't send. The server skips empty values, so the
  child keeps its default. No tri-state needed for numbers.
- Booleans as tri-state `default` / `on` / `off`. `default` sends nothing. A
  `Switch` cannot express "leave default", so use a `Select`.
- `ngl` needs no `all` special case. `n_gpu_layers > n_layer` already means all
  layers. The CLI default is `auto` (`-1`); empty leaves it alone. An explicit
  `0` means "CPU only", which is not the same as the default. Keep the number
  input, no `auto`/`all` select.
- Append via the base plan's `opts.extra_args`; last value wins
  (`common/arg.cpp:844`). Child presets already inherit the router's own CLI
  args (`server-models.cpp:934`), so if the router was started with `-c`/`-ngl`
  the child logs a `DEPRECATED: argument ... specified multiple times` warning
  on each load. Cosmetic; do not mutate `meta.preset` to avoid it, that lives in
  `mapping` and would leak the per-load value into later loads and into
  `/models` `status.preset` (`server-models.cpp:2447`). If the warning ever
  matters, copy the preset inside `load()` and `set_option()` on the copy.

## What the flags actually do (the UI must not lie)

- Children are not router servers, so they auto-set `n_parallel = 4` and
  `kv_unified = true` (`tools/server/server.cpp:169-174`).
- With unified KV, `-c` is one shared pool and `n_ctx_seq = n_ctx`. With
  `--no-kv-unified`, each slot gets `n_ctx / 4` (`src/llama-context.cpp:389-402`,
  `tools/server/server-context.cpp:4955`). This is why the label is "total KV
  pool", not "context size".
- `-c 0` means "full trained context" and disables fit's context reduction
  (`common/arg.cpp:1654`).
- `--fit` is ON by default (`common/common.h:483`). An explicit `-ngl` makes fit
  abort when it would need to rebalance layers (`common/fit.cpp:463`), and an
  explicit `-c` blocks context reduction (`common/fit.cpp:455`). Net: these
  options opt that model out of auto-fit, so a load that would have adapted to
  memory can now fail. The fit warning in the child log is expected, not a bug.

## Phase 1 - Server (~35 lines)

Extend `load_config_to_args()` in `tools/server/server-models.cpp`. Keep the
existing `add` (enum) helper, add two:

```cpp
auto add_int = [&](const char * flag, const char * key, int min, int max) {
    const std::string val = json_value(cfg, key, std::string());
    if (val.empty()) return;
    int n = 0;
    try {
        size_t pos = 0;
        n = std::stoi(val, &pos);
        if (pos != val.size()) throw std::invalid_argument("");
    } catch (...) {
        throw std::invalid_argument(std::string("invalid value for ") + flag + ": " + val);
    }
    if (n < min || n > max) {
        throw std::invalid_argument(std::string("out of range for ") + flag + ": " + val);
    }
    out.push_back(flag);
    out.push_back(std::to_string(n)); // canonical: reject/absorb "+5" and " 5"
};

auto add_bool = [&](const char * on_flag, const char * off_flag, const char * key) {
    const std::string val = json_value(cfg, key, std::string());
    if (val.empty() || val == "default") return;
    if (val == "on")  { out.push_back(on_flag);  return; }
    if (val == "off") { out.push_back(off_flag); return; }
    throw std::invalid_argument(std::string("invalid value for ") + key + ": " + val);
};
```

Wire the new fields:

```cpp
add_int ("--ctx-size",     "ctx_size",     0, 1 << 20);
add_int ("--n-gpu-layers", "n_gpu_layers", 0, 1 << 20);
add_bool("--kv-offload",   "--no-kv-offload", "kv_offload");
add_bool("--kv-unified",   "--no-kv-unified", "kv_unified");
```

`1 << 20` instead of `INT32_MAX`: a larger ctx just fails allocation later, and
`INT32_MAX` is not currently used in this file (no include to borrow). Bad
values throw `std::invalid_argument`, which `ex_wrapper` turns into a 400
(`tools/server/server.cpp:56-69`).

## Phase 2 - UI plumbing (~20 lines)

`types/models.d.ts` - extend `ModelLoadConfig`:

```ts
ctxSize: string;     // empty = server default
nGpuLayers: string;  // empty = server default (auto)
kvOffload: string;   // 'default' | 'on' | 'off'
kvUnified: string;   // 'default' | 'on' | 'off'
```

`constants/model-loading.constants.ts` - extend `LOAD_CONFIG_DEFAULTS` with
`ctxSize: ''`, `nGpuLayers: ''`, `kvOffload: 'default'`, `kvUnified: 'default'`.
Add `TRI_STATE_OPTIONS = ['default', 'on', 'off']`.

`stores/models/index.svelte.ts` - `getLoadConfig()` must merge defaults. Existing
localStorage entries predate these keys, and an unmerged object leaves the new
`Select`s blank:

```ts
getLoadConfig(modelId: string): ModelLoadConfig {
    return { ...LOAD_CONFIG_DEFAULTS, ...this.loadConfigs[modelId] };
}
```

`services/models.service.ts` - add 4 keys to the `load_config` body: `ctx_size`,
`n_gpu_layers`, `kv_offload`, `kv_unified`. Omit empty strings (the existing
enum helper only skips `nullptr`, not `""`, so an empty select would 400).

## Phase 3 - UI form (~45 lines)

Add 4 rows to `ModelsManagerModelLoadConfig.svelte`. Reuse `Input`
(`$lib/components/ui/input`) and the existing `Select` rows.

Number rows (context size, GPU layers):

```svelte
<div class={rowClass}>
	<span class="text-sm text-muted-foreground">Context size (total)</span>

	<Input
		class="ml-auto h-7 w-32 text-xs"
		inputmode="numeric"
		min="0"
		step="1"
		oninput={(e) => update({ ctxSize: e.currentTarget.value })}
		placeholder="default"
		type="number"
		value={config.ctxSize}
	/>
</div>
```

`step="1"` keeps the browser from offering decimals and exponents, which the
server rejects. `oninput` reads `.value` as a string, so config stays
string-typed. `value={...}` is fine unbound: the parent keys the panel by model
id (`{#key shownId}`), so switching models remounts it. Verify that key exists
in the base form before relying on it.

One hint line under the number rows, only when `kvUnified === 'off'`:
"Context is split across 4 slots when unified KV is off (per slot: size / 4)."

Boolean rows (KV offload, unified KV): same `Select` shape as the existing rows,
over `TRI_STATE_OPTIONS`.

## Phase 4 - Tests (~30 lines)

- UI (`tests/unit/model-load-config.test.ts`): extend the config object and
  expected body with the 4 new keys. Add a case asserting empty fields are
  omitted from `load_config`.
- Server (`tools/server/tests/unit/test_router.py`): `test_router_load_config`
  does not exist yet, create it. `_load_model_and_wait` (`:97`) takes no config,
  so add a small `_load_model_with_config_and_wait` or an optional `config` arg.
  Then assert the flags appear in `GET /models` -> `data[].status.args`
  (exposed at `server-models.cpp:2444`): `--ctx-size`, `--n-gpu-layers`,
  `--no-kv-offload`, `--kv-unified`. Add one invalid-int case
  (`ctx_size: "abc"` -> 400) and one out-of-range case (`ctx_size: "1048577"` ->
  400).

## Not doing (YAGNI)

- No `auto`/`all` control for `ngl`. Empty is auto, a big number is all.
- No `--kv-unified-per-slot`. Server-only, not requested.
- No new section. 8 rows in the one "Load configuration" section.
- No per-field "reset to default" button. Clearing the input or picking
  `default` does it.
- No reload persistence. Same limitation as the base plan: extra args apply to
  the spawn only, so LRU/startup reloads (`server-models.cpp:1233`, `:1826`)
  drop them. Add later if users complain about `-ngl` vanishing after eviction;
  the lazy fix then is to keep the validated args on the instance meta and
  re-append on reload.

## Effort

Phase 1 is the only C++ and is self-contained (~35 lines, not 25). Phases 2-3
are pure UI. Phase 1 first, same as before.
