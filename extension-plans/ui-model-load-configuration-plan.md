# Implementation plan: per-model load configuration in the UI

Extend the built-in web UI model loader so a model can be loaded with a chosen
KV cache quantization, Flash Attention setting, and loading mode (mmap / mlock).

## Current state (verified)

Every load funnels through one method:

```
ModelLoadControl.svelte (row button)  ─┐
ModelsManager.svelte  toggleLoad()    ─┼─> modelsStore.status.load(modelId)
use-context-gauge.svelte loadModel()  ─┘        (stores/models/status.svelte.ts:352)
                                                       |
                                                       v
                                          ModelsService.load(modelId, extraArgs?)   (services/models.service.ts:120)
                                                       |
                                                       v
                                          POST /models/load  { model, extra_args? }
```

Two things already exist and are worth reusing:

- `ModelsService.load()` already accepts and sends `extra_args`, but no caller
  passes it and the server ignores it. It is dead plumbing.
- `LOAD_DEFAULTS` in `constants/model-loading.constants.ts` is defined but never
  referenced. Leftover from a planned load form.

Server load path (`tools/server/server-models.cpp`):

- `post_router_models_load` (L2067) reads only `model`, then calls
  `models.load(name)`.
- `server_models::load()` (L1137) renders the model's preset into `child_args`
  via `update_args()` (L1194) and spawns a child `llama-server` process with
  them (L1214). `load_options` (server-models.h:261) already exists as the place
  to pass per-load data.

Key fact: in this fork, mmap/mlock are not separate flags. They are values of
`--load-mode` (`mmap`, `mlock`, `mmap+mlock`). So the UI exposes one "loading
mode" control, not two checkboxes.

## Design decisions

1. Per-model config, stored in `localStorage`, keyed by model id, following the
   existing `favoriteModelIds` / `hiddenModelIds` pattern
   (`stores/models/index.svelte.ts:663`). Defaults come from `LOAD_DEFAULTS`.
2. The store resolves config, not the callers. `ModelStatusManager.load(modelId)`
   looks up the saved config and passes it down. This means the row hover
   button, the panel button, and background loads all get the config with zero
   changes to their call sites.
3. Structured config, not raw CLI args. The request carries named fields; the
   server maps them to flags against an allowlist. This avoids arbitrary-flag
   injection into a spawned subprocess (the server README treats file and
   security-sensitive features as a trust boundary). The unused `extra_args`
   field gets replaced by this.

## Phase 1 - Server (small, ~40 lines)

`tools/server/server-models.h` - extend `load_options`:

```cpp
struct load_options {
    server_child_mode mode = SERVER_CHILD_MODE_NORMAL;
    std::optional<server_model_meta> custom_meta = std::nullopt;
    std::vector<std::string> extra_args; // validated, appended to the child's args
};
```

`tools/server/server-models.cpp` - two edits:

1. In `post_router_models_load` (L2067), read the config from the body and
   translate it to validated args:

```cpp
// allowlist: only memory-related flags the UI offers
static std::vector<std::string> load_config_to_args(const json & cfg) {
    std::vector<std::string> out;
    auto add = [&](const char * flag, const char * val,
                   std::initializer_list<const char *> allowed) {
        if (val == nullptr) return;
        for (const char * a : allowed) {
            if (strcmp(a, val) == 0) { out.push_back(flag); out.push_back(val); return; }
        }
        throw std::invalid_argument(std::string("invalid value for ") + flag);
    };
    add("--cache-type-k", json_value(cfg, "cache_type_k", (const char *) nullptr),
        {"f32","f16","bf16","q8_0","q4_0","q4_1","iq4_nl","q5_0","q5_1"});
    add("--cache-type-v", json_value(cfg, "cache_type_v", (const char *) nullptr),
        {"f32","f16","bf16","q8_0","q4_0","q4_1","iq4_nl","q5_0","q5_1"});
    add("--flash-attn",   json_value(cfg, "flash_attn",   (const char *) nullptr),
        {"on","off","auto"});
    add("--load-mode",    json_value(cfg, "load_mode",    (const char *) nullptr),
        {"auto","none","mmap","mlock","mmap+mlock","dio"});
    return out;
}
```

Then pass them: `models.load(meta->name, opts)` where
`opts.extra_args = load_config_to_args(body.value("load_config", json::object()));`.

2. In `server_models::load()` (L1196), after `child_args` is copied, append:

```cpp
child_args.insert(child_args.end(), opts.extra_args.begin(), opts.extra_args.end());
```

That is the entire server change. `inst.meta.args = child_args` (L1210) then
makes the effective args visible in `GET /models` status, which is also what the
test asserts.

Known limitation to note in the PR: extra args apply to the spawn only. An
LRU/startup reload calls `load()` with empty `load_options`, so it drops them.
Persisting into the model's preset is a follow-up, not v1.

## Phase 2 - UI plumbing (~30 lines)

`constants/model-loading.constants.ts` - replace the dead `LOAD_DEFAULTS` with
the real shape and option lists:

```ts
export const CACHE_TYPE_OPTIONS = ['f16','f32','bf16','q8_0','q4_0','q4_1','iq4_nl','q5_0','q5_1'];
export const FLASH_ATTN_OPTIONS = ['auto','on','off'];
export const LOAD_MODE_OPTIONS = ['auto','mmap','mlock','mmap+mlock','none','dio'];

export const LOAD_CONFIG_DEFAULTS: ModelLoadConfig = {
    cacheTypeK: 'f16', cacheTypeV: 'f16', flashAttn: 'auto', loadMode: 'auto'
};
```

`types/models.ts` - add `ModelLoadConfig` (camelCase UI shape).

`stores/models/index.svelte.ts` - add
`loadConfigs = $state<Record<string, ModelLoadConfig>>(loadLoadConfigsFromStorage())`
plus `getLoadConfig(id)` / `setLoadConfig(id, cfg)`, mirroring the favorites
helpers.

`stores/models/status.svelte.ts` - in `load()` (L352), resolve and pass:

```ts
await ModelsService.load(modelId, this.host.getLoadConfig(modelId));
```

`services/models.service.ts` - change `load(modelId, extraArgs?)` to
`load(modelId, config?)`, mapping camelCase to the snake_case `load_config`
body. Drop the unused `extra_args` field.

## Phase 3 - UI form (~1 component)

Add a `CollapsibleSection` ("Load configuration") to
`ModelsManagerModelConfiguration.svelte`, below the information block and above
the delete button. Four selects bound to the store's config for `option.model`:

- KV cache K / V type - `CACHE_TYPE_OPTIONS`
- Flash Attention - `FLASH_ATTN_OPTIONS`
- Loading mode - `LOAD_MODE_OPTIONS`

Reuse the existing `Select` / `CollapsibleSection` UI primitives; no new
dependency. One inline hint when a quantized V type is chosen with Flash
Attention `off` (the server rejects that combination -
`src/llama-context.cpp:4020`), or just auto-set `flashAttn` to `on`.

## Phase 4 - Tests

- Server: extend `tools/server/tests/unit/test_router.py` - POST `/models/load`
  with a `load_config`, then assert the flags appear in `GET /models`
  `status.args`. Add one rejection case for an invalid value.
- UI: one small test for the config to request-body mapping (the only
  non-trivial logic).

## Not doing (YAGNI)

- No global-vs-per-model inheritance layer. Per-model with defaults covers it.
- No `--lazy-mode`, `--swa-full`, `--no-kv-offload` in v1. The four requested
  controls are enough; the allowlist makes adding them a one-line change later.
- No new settings-store keys. Per-model config is a map, not a flat setting.
- No server-side preset persistence in v1 (see limitation above).

## Effort

Phase 1 is the only C++ and is self-contained. Phases 2-3 are the bulk and are
pure UI. Phase 1 must land first, since the UI is inert until the server honours
the config.
