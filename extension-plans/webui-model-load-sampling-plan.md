# Implementation Plan: Per-Model Sampling Defaults in the WebUI Load Config

Revised 2026-10-25 against `84462897e` ("server : per-model load configuration").
This revision replaces the earlier draft. Changes from that draft:

- v1 is six fields, not seventeen.
- The per-request overlay (old Phase 4) is deferred. It was based on a wrong premise.
- All file and line references were re-checked against the current tree.
- Server validation covers the child's hard constraints and adds explicit ranges for the rest.
- The UI mapping follows the file's existing explicit-row style; no descriptor table.

## 1. Summary

Pass a small set of sampling values to the router's child process as CLI flags
when a model is loaded. The child uses them as request defaults, so both the
WebUI and external clients get the model's configured sampling without the
WebUI having to send those values on every request.

```
request value (WebUI global override or API client)
  > per-model load flag set on the child
  > GGUF sampling metadata
  > built-in default
```

The WebUI only sends a request value when the user actually overrode the
setting in Settings, so in the common case the load-time flags apply directly.

If external clients do not need these defaults, the cheaper option is the
per-request overlay in 9.2: no server change, no API surface, and it survives
reloads.

## 2. What exists today (verified)

| Piece | Location |
|---|---|
| Load config type | `tools/ui/src/lib/types/models.d.ts:94` (`ModelLoadConfig`) |
| Defaults + option lists | `tools/ui/src/lib/constants/model-loading.constants.ts:39` |
| UI form | `tools/ui/src/lib/components/app/models/ModelsManager/ModelsManagerModelConfiguration/ModelsManagerModelLoadConfig.svelte` |
| Persistence | `tools/ui/src/lib/stores/models/index.svelte.ts:341` (`getLoadConfig`), `:517` (`setLoadConfig`) |
| Defaults merge | `getLoadConfig` already merges over `LOAD_CONFIG_DEFAULTS` at `index.svelte.ts:341-343` |
| Request mapping | `tools/ui/src/lib/services/models.service.ts:30` (`loadConfigToBody`) |
| Load call | `tools/ui/src/lib/services/models.service.ts:175` (`ModelsService.load`) |
| Load trigger | `tools/ui/src/lib/stores/models/status.svelte.ts:504` |
| Server translation | `tools/server/server-models.cpp:477` (`load_config_to_args`) |
| `add_int` / `add_bool` | `tools/server/server-models.cpp:494` / `:516` |
| Args appended to child | `tools/server/server-models.cpp:1492` |
| Route | `tools/server/server-models.cpp:2478` (`post_router_models_load`) |
| 400 mapping | `tools/server/server.cpp:56-65` (`ex_wrapper`) |
| Router-only registration | `tools/server/server.cpp:274` |

Child CLI sampling values become the baseline for every request:
`task.params.sampling = params_base.sampling` at
`tools/server/server-schema.cpp:474-475`, before request fields override it.

## 3. Semantics

### 3.1 Empty means "no flag"

An omitted or empty field emits no CLI flag. The child then keeps whatever it
would have used anyway, which may be GGUF sampling metadata, not just the
built-in default. `common_init_sampler_from_model` reads keys such as
`sampling.temp` and `sampling.top_k` unless the matching
`user_sampling_config` bit is set (`common/common.cpp:1093-1151`). A CLI flag
sets that bit, so an explicit UI value intentionally overrides model metadata.

Document this in the form as a short note, because it is the difference between
"default" and "model default".

### 3.2 The WebUI does not always send global sampling

Global sampling settings default to `undefined`
(`tools/ui/src/lib/constants/settings.constants.ts:409` and the rest of the
section), and `getApiOptions` only sends a value when it is set
(`tools/ui/src/lib/stores/chat/index.svelte.ts:370-371,395`). In router mode the
router's own `/props` reports no sampling defaults, which the settings store
accounts for explicitly (`tools/ui/src/lib/stores/settings/index.svelte.ts:292-294`,
`server.svelte.ts:30-31`).

Consequence: per-model load flags already apply to WebUI chats when the user
has not overridden that parameter globally. No chat-store change is needed for
v1. If a user does set a global override, that override wins; the Settings
page's "Reset to default" is the way back. The settings page already shows the
selected model's `/props` values as the default
(`SettingsChatFields.svelte:103-105`), so it will reflect the new flags.

### 3.3 Flags are not persisted by the router

`extra_args` only exist for the spawn that received them. A later automatic
load calls `load(name)` with no options (`server-models.cpp:1896`), so an idle
unload, LRU eviction, or `models_max` reload starts the child without the
sampling flags. This is pre-existing behaviour for `ctx_size` and friends.
Document it; persisting load configs server-side is out of scope for v1.

## 4. Phase 1 - Server: accept six sampling fields

**File:** `tools/server/server-models.cpp`

Add `add_float` next to `add_int` (`:494`). It parses the whole string, rejects
NaN and infinity, and supports an inclusive or exclusive lower bound:

```cpp
auto add_float = [&](const char * flag, const char * key, float min, float max, bool min_exclusive = false) {
    const std::string val = json_value(cfg, key, std::string());
    if (val.empty()) {
        return;
    }
    float f = 0.0f;
    try {
        size_t pos = 0;
        f = std::stof(val, &pos);
        if (pos != val.size() || !std::isfinite(f)) {
            throw std::invalid_argument("");
        }
    } catch (...) {
        throw std::invalid_argument(std::string("invalid value for ") + flag + ": " + val);
    }
    if (f < min || f > max || (min_exclusive && f == min)) {
        throw std::invalid_argument(std::string("out of range for ") + flag + ": " + val);
    }
    out.push_back(flag);
    out.push_back(val);
};
```

Add `<limits>` and `<cmath>` if `std::numeric_limits` and `std::isfinite` are not
already available through the existing includes.

Append after the existing calls at `:532-540`:

```cpp
add_float("--temp",           "temperature",    0.0f, std::numeric_limits<float>::max());
add_float("--top-p",          "top_p",          0.0f, 1.0f);
add_float("--min-p",          "min_p",          0.0f, 1.0f);
add_float("--repeat-penalty", "repeat_penalty", 0.0f, std::numeric_limits<float>::max(), true);
add_int  ("--top-k",          "top_k",          0,    1 << 20);
add_int  ("--repeat-last-n",  "repeat_last_n",  0,    1 << 20);
```

Validation mirrors the child, not the UI:

| `load_config` key | Flag | Rule |
|---|---|---|
| `temperature` | `--temp` | finite, >= 0 |
| `top_p` | `--top-p` | finite, 0..1 |
| `top_k` | `--top-k` | int, >= 0 |
| `min_p` | `--min-p` | finite, 0..1 |
| `repeat_penalty` | `--repeat-penalty` | finite, > 0 |
| `repeat_last_n` | `--repeat-last-n` | int, >= 0 |

The strict `repeat_penalty` check is required. The child exits at startup when
the value is not finite or not greater than zero
(`common/arg.cpp:2106-2109`), and the router would only report a generic load
failure. `--temp` clamps negative values in the child (`arg.cpp:2031`); the
router rejects them instead, which is stricter but predictable. `--top-p` and
`--min-p` are not range-checked by the child; the 0..1 bounds here are a router
policy, so the tests should state that.

No route changes. `opts.extra_args` already reaches the child at
`server-models.cpp:1492`, after the preset args, so later values win.

## 5. Phase 2 - UI types, defaults, and mapping

**`tools/ui/src/lib/types/models.d.ts:94`** - add six required string fields.
Required with `''` matches the existing shape; the repo guideline prefers
`undefined` for unset, but this file's established convention is empty string.

```ts
export interface ModelLoadConfig {
    // ...existing fields
    temperature: string;
    topP: string;
    topK: string;
    minP: string;
    repeatPenalty: string;
    repeatLastN: string;
}
```

**`tools/ui/src/lib/constants/model-loading.constants.ts`**

- Add the same keys to `LOAD_CONFIG_DEFAULTS` as `''`.
- Delete `SAMPLING_DEFAULTS` (`:51`). It is unused, and its values do not match
  the server (`temperature: 1`, `topK: 64`, `repeatPenalty: 1.1` versus `0.8`,
  `40`, `1.0` in `common/common.h:233-243`). Do not use it as placeholder text.

No table, no new type. The file already writes its eight fields explicitly;
write six more the same way.

**`tools/ui/src/lib/services/models.service.ts:30`** - add the six literal
wire keys to the existing object. Keep the final empty-value filter:

```ts
const body: Record<string, string> = {
    cache_type_k: config.cacheTypeK,
    // ...existing keys
    temperature: config.temperature,
    top_p: config.topP,
    top_k: config.topK,
    min_p: config.minP,
    repeat_penalty: config.repeatPenalty,
    repeat_last_n: config.repeatLastN
};
```

No migration step is needed: `getLoadConfig` already merges defaults
(`index.svelte.ts:341-343`), so old localStorage entries get the new `''` keys.

## 6. Phase 3 - UI form

**File:** `ModelsManagerModelLoadConfig.svelte`

Extend the existing `numberRow` with a `step` parameter and render six
explicit rows in a second `CollapsibleSection` after the load section (`:121`).
No options object: the browser does not submit a form here, so `min`/`max` are
decoration and the server is the validation boundary.

```svelte
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
```

Then the section. Each row uses the existing `update()` directly; no helper:

```svelte
<CollapsibleSection triggerClass={sectionTrigger}>
    {#snippet trigger()}
        <span class="text-sm font-medium">Sampling defaults</span>
    {/snippet}

    <div class="mt-1">
        {@render numberRow('Temperature', config.temperature, 'default', (value) => update({ temperature: value }), '0.01')}
        {@render numberRow('Top P', config.topP, 'default', (value) => update({ topP: value }), '0.01')}
        {@render numberRow('Top K', config.topK, 'default', (value) => update({ topK: value }))}
        {@render numberRow('Min P', config.minP, 'default', (value) => update({ minP: value }), '0.01')}
        {@render numberRow('Repeat penalty', config.repeatPenalty, 'default', (value) => update({ repeatPenalty: value }), '0.01')}
        {@render numberRow('Repeat last N', config.repeatLastN, 'default', (value) => update({ repeatLastN: value }))}

        <p class="pt-2 text-xs text-muted-foreground">
            Defaults for this model. A request that sends its own value still wins. Empty leaves the model's own default.
        </p>
    </div>
</CollapsibleSection>
```

The server rejects `repeatPenalty: 0` and other out-of-range values with a 400.
The browser `min="0"` is a hint only.

## 7. Tests

**`tools/ui/tests/unit/model-load-config.test.ts`**

- Extend the mapping case with the six values and assert the wire keys.
- Keep the defaults case: `LOAD_CONFIG_DEFAULTS` must produce no sampling keys.
- Add a case for explicit zeros (`temperature: '0'`, `minP: '0'`,
  `topK: '0'`), which must survive the empty-value filter.

**`tools/server/tests/unit/test_router.py:132`**

- Extend `test_router_load_config` with `temperature`, `top_p`, `top_k`,
  `min_p`, `repeat_penalty`, `repeat_last_n` and assert the child args with the
  existing `_last_arg_value` helper (`:125`).
- Extend `test_router_load_config_invalid` (`:156-174`) with three cases:
  `{"repeat_penalty": "0"}` (the child would exit at spawn),
  `{"temperature": "abc"}` (parse), `{"top_k": "-1"}` (range).
  All must return 400 without spawning a child.
- A value of `0` for `temperature`, `top_p`, `min_p`, and `top_k` must be
  accepted and forwarded, not treated as empty.

The invalid cases are cheap; the valid case reuses the already downloaded
`ggml-org/tinygemma3-GGUF:Q8_0` fixture.

## 8. Docs

`POST /models/load` in `tools/server/README.md:2258` documents only `model`.
`load_config` as a whole is undocumented, not just the new keys. Add a short
`load_config` block to that section:

- values are strings, not JSON numbers; a non-string is silently ignored by
  `json_value` (`tools/server/server-common.h:44-52`)
- empty or omitted emits no flag
- list the six keys, their flags, and their ranges
- note that the flags are applied per load and are not kept across an
  automatic reload

## 9. Deferred

### 9.1 Advanced sampling fields

`dynatemp_*`, `xtc_*`, `typ_p`, `presence_penalty`, `frequency_penalty`, and
the `dry_*` group are left out of v1. The server and UI patterns above extend
to them mechanically. Add them when a user asks; each one needs the same
range decision as the six above (`--dry-base` under 1 is silently ignored by
the child, `--presence-penalty` is finite with no bounds, and so on).

### 9.2 Per-request overlay (old Phase 4)

This is the cheaper option if external clients do not need defaults: no server
change, no API surface, and it survives reloads. Do not add it in v1.

The earlier draft assumed the WebUI always sends global sampling values and
that they would mask the load-time flags. That is not true: the global values
are `undefined` unless the user changes them, and the request omits them.
The load flags therefore already reach WebUI chats.

An overlay would only change behaviour for users who explicitly set a global
override, and it would flip the existing precedence without any visible
indication in Settings. If this is wanted later:

- add the same six keys to a literal map in `getApiOptions`
  (`tools/ui/src/lib/stores/chat/index.svelte.ts:368`)
- update the Settings source indicator so the user can see that the
  per-model value is in effect

That is a separate product decision, not a load-path fix.

### 9.3 `samplers`

Keep out of v1. It is a free-form `;`-separated string and needs a different
validation path. Note the caveat: the sampler chain is built from
`params.samplers` (`common/sampling.cpp:348`), and a GGUF may replace that
sequence through metadata (`common/common.cpp:1129-1137`). If the model's
sequence omits a sampler, the matching per-parameter flag has no effect. Most
models use the default chain, so the six fields work in practice.

## 10. Risks and limitations

- **Lost on automatic reload.** See 3.3. The form note and the README should
  say "applied when the model is loaded" rather than "saved for the model".
- **GGUF metadata interaction.** Empty fields preserve model metadata; set
  fields override it. This is the intended behaviour but should be documented.
- **Child spawn failures are opaque.** The router reports "Failed to load
  model"; the real reason is in the child log. The strict `repeat_penalty`
  check removes the most likely user-caused failure.
- **String-only wire format.** Direct API callers must send strings. The README
  note is the mitigation; accepting numbers would be a separate change to
  `json_value` usage.
- **Single-model mode.** `load_config` is router-only
  (`server.cpp:274`). The form is shared, so values set there have no effect
  outside router mode. This matches the existing `ctx_size` behaviour and is
  not a new problem.

## 11. Out of scope

- Persisting per-model load config in the router.
- `samplers`, `backend_sampling`, `max_tokens`.
- Mirostat, top-n-sigma, adaptive sampling.
- Any change to the chat request path.

## 12. Verification

```sh
cmake --build build --target llama-server

cd tools/ui
npm run check
npm run test:unit -- --run tests/unit/model-load-config.test.ts

cd ../..
python -m pytest tools/server/tests/unit/test_router.py -k load_config
```

The router test starts the server and downloads the tiny test model, so it
needs a working build and network access, same as the existing test.

Estimated diff: about 130 lines including tests and docs. Phase 1 is roughly
45 lines; Phases 2-3 are roughly 45.
