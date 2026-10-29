# Memory-related model loading options

This document describes the options that control how llama.cpp loads model
weights and allocates runtime memory: model loading modes (mmap, mlock, direct
I/O), lazy tensor reads, KV cache quantization, Flash Attention, KV cache
offload, and the related MoE/NUMA/offload knobs.

All CLI names, defaults, and help text below are taken from the current source
tree. Line references point at the authoritative definitions.

## Quick reference

| Area | CLI option | Env var | API field |
| --- | --- | --- | --- |
| Loading mode | `-lm, --load-mode` | `LLAMA_ARG_LOAD_MODE` | `llama_model_params.load_mode` |
| Lazy tensors | `-lzm, --lazy-mode` | `LLAMA_ARG_LAZY_MODE` | `llama_model_params.lazy_mode` |
| KV cache K type | `-ctk, --cache-type-k` | `LLAMA_ARG_CACHE_TYPE_K` | `llama_context_params.type_k` |
| KV cache V type | `-ctv, --cache-type-v` | `LLAMA_ARG_CACHE_TYPE_V` | `llama_context_params.type_v` |
| Flash Attention | `-fa, --flash-attn` | `LLAMA_ARG_FLASH_ATTN` | `llama_context_params.flash_attn_type` |
| KV offload | `-kvo, --kv-offload` / `-nkvo, --no-kv-offload` | `LLAMA_ARG_KV_OFFLOAD` | `llama_context_params.offload_kqv` |
| Unified KV | `-kvu, --kv-unified` / `-no-kvu, --no-kv-unified` | `LLAMA_ARG_KV_UNIFIED` | `llama_context_params.kv_unified` |
| Full SWA cache | `--swa-full` | `LLAMA_ARG_SWA_FULL` | `llama_context_params.swa_full` |
| NUMA | `--numa` | `LLAMA_ARG_NUMA` | `llama_numa_init()` |
| MoE experts on CPU | `-cmoe, --cpu-moe`, `-ncmoe, --n-cpu-moe` | `LLAMA_ARG_CPU_MOE`, `LLAMA_ARG_N_CPU_MOE` | `tensor_buft_overrides` |
| MoE expert GPU cache | `--moe-cache-mib` | `LLAMA_ARG_MOE_CACHE_MIB` | `llama_context_params.moe_cache_size` |
| Tensor buffer override | `-ot, --override-tensor` | `LLAMA_ARG_OVERRIDE_TENSOR` | `tensor_buft_overrides` |
| Bypass host buffer | `--no-host` | `LLAMA_ARG_NO_HOST` | `llama_model_params.no_host` |
| Weight repacking | `--repack` / `-nr, --no-repack` | `LLAMA_ARG_REPACK` | `llama_model_params.use_extra_bufts` |
| Op offload | `--op-offload` / `--no-op-offload` | - | `llama_context_params.op_offload` |
| Tensor check | `--check-tensors` | - | `llama_model_params.check_tensors` |

## 1. Model loading mode (`--load-mode`)

This fork replaces the upstream `--mmap` / `--mlock` / `--no-mmap` flags with a
single `--load-mode` option. The mode is stored in `llama_model_params.load_mode`
and defined by `enum llama_load_mode` in `include/llama.h:L207-L216`.

| Value | Meaning |
| --- | --- |
| `auto` (default) | mmap, unless a device does not support it |
| `none` | no special loading mode (plain buffered reads) |
| `mmap` | memory-map the model |
| `mlock` | force the system to keep the model in RAM (no swapping/compression) |
| `mmap+mlock` | mmap plus lock the mapped pages in RAM |
| `dio` | use Direct I/O if available |

CLI definition: `common/arg.cpp:L2693-L2711` (`-lm, --load-mode MODE`).
Env var: `LLAMA_ARG_LOAD_MODE`.

### How the mode is applied

- `llama_model_loader` maps the mode to two internal booleans
  (`src/llama-model-loader.cpp:L557-L558`):
  - `use_mmap` is true for `MMAP`, `MMAP_MLOCK`, and `AUTO`.
  - `use_direct_io` is true only for `DIRECT_IO`.
- `load_tensors()` derives `use_mlock` from the mode
  (`src/llama-model.cpp:L1562`): true for `MLOCK` and `MMAP_MLOCK`.
- When the mode is `AUTO`, `load_tensors()` probes each device's
  `mmap_support` capability and falls back to `NONE` if any device cannot mmap
  (`src/llama-model.cpp:L1570-L1591`). The same probe downgrades `lazy_mode`
  from `AUTO` to `OFF` when mmap is unavailable.
- mmap requires the GGUF data section to be aligned to the CPU buffer
  alignment; otherwise loading throws
  (`src/llama-model-loader.cpp:L688-L692`).
- If `llama_mmap::SUPPORTED` is false on the platform, `use_mmap` is forced off
  with a warning (`src/llama-model-loader.cpp:L827-L832`).
- The effective mode is logged at load time
  (`src/llama-model.cpp:L1595-L1600`).

### Notes

- With mmap, tensors are placed at their file offsets, so the loader avoids
  allocating a separate host buffer for them
  (`src/llama-model-loader.cpp:L1269-L1273`).
- Tensor overrides that target the CPU buffer emit a warning suggesting
  `--load-mode none` for better performance when mmap is enabled
  (`src/llama-model-loader.cpp:L1240-L1249`).
- The server README notes that mmap may report inaccurate load progress on some
  platforms; use `--load-mode none` if exact progress is needed
  (`tools/server/README.md`).

## 2. Lazy mode (`--lazy-mode`)

Controls on-demand reading of certain large tensors (for example per-layer
embeddings / PLE / engrams) instead of keeping them resident. Defined by
`enum llama_lazy_mode` in `include/llama.h:L218-L222`.

| Value | Meaning |
| --- | --- |
| `on` | read rows of arch-marked tensors from disk on demand (requires mmap) |
| `auto` (default) | like `on`, but only for tensors larger than 4 GiB |
| `off` | always keep such tensors resident |

CLI definition: `common/arg.cpp:L2712-L2724` (`-lzm, --lazy-mode MODE`).
Env var: `LLAMA_ARG_LAZY_MODE`.

Implementation:

- The loader tracks lazy tensors in `llama_model_loader::lazy_read`
  (`src/llama-model-loader.h:L79-L120`).
- `lazy_read::add()` skips tensors at or below 4 GiB unless the mode is `ON`
  (`src/llama-model-loader.cpp:L1088-L1098`).
- Lazy tensors are gathered on the host and get a dedicated ggml context
  (`src/llama-model-loader.h:L110-L114`, `L148-L154`).
- The decision is independent of the load mode so the memory-fit pass behaves
  consistently (`src/llama-model-loader.cpp:L1340-L1345`).
- `AUTO` is downgraded to `OFF` when no device supports mmap
  (`src/llama-model.cpp:L1582-L1591`).

## 3. mmap internals

`struct llama_mmap` is declared in `src/llama-mmap.h:L47-L66`. Its constructor
takes a prefetch size, a NUMA flag, and a list of lazy byte ranges
(`src/llama-mmap.h:L52-L53`).

Platform behavior (`src/llama-mmap.cpp:L482-L529`):

- Linux: `posix_fadvise(POSIX_FADV_SEQUENTIAL)` is requested, and `MAP_POPULATE`
  is added unless lazy ranges are present (populating would fault them in).
- Prefetch ranges are advised with `POSIX_MADV_WILLNEED`; lazy ranges are
  advised with `POSIX_MADV_RANDOM`.
- NUMA mode disables prefetch and advises the whole mapping `POSIX_MADV_RANDOM`.
- `unmap_fragment()` releases page-aligned sub-ranges
  (`src/llama-mmap.cpp:L543-L577`).

`llama_prefetch()` (`src/llama-mmap.cpp:L837-L914`) issues `MADV_WILLNEED` on
Linux and `PrefetchVirtualMemory` on Windows, coalescing adjacent ranges so the
reads can be issued concurrently.

## 4. mlock internals

`struct llama_mlock` is declared in `src/llama-mmap.h:L68-L80`. It locks memory
incrementally via `init()` and `grow_to()` so a partially locked buffer still
makes progress.

- `grow_to()` rounds the target up to the platform lock granularity and locks
  only the newly added region (`src/llama-mmap.cpp:L803-L817`).
- Linux uses `mlock`/`munlock` with a page-size granularity and prints an
  `RLIMIT_MEMLOCK` hint on failure (`src/llama-mmap.cpp:L698-L741`).
- Windows uses `VirtualLock`/`VirtualUnlock`, growing the working set on retry
  (`src/llama-mmap.cpp:L742-L782`).
- Other platforms report mlock as unsupported
  (`src/llama-mmap.cpp:L783-L794`).
- `llama_supports_mlock()` reports platform support
  (`include/llama.h:L571`).

When `use_mlock` is set, `load_tensors()` passes an mlock list to
`init_mappings()` and locks host buffers as they are allocated
(`src/llama-model.cpp:L1870-L1874`, `L1946-L1950`).

## 5. Direct I/O (`dio`)

Direct I/O bypasses the page cache for reads, which can help when the model is
larger than RAM and page-cache pollution is undesirable.

- Enabled only on Linux via `O_DIRECT` when the file is opened read-only
  (`src/llama-mmap.cpp:L184-L196`, `L199-L216`).
- Reads are staged through a bounded, aligned buffer of
  `LLAMA_DIRECT_IO_BUFFER_SIZE` (64 MiB) so a large tensor is not held in memory
  twice (`src/llama-mmap.h:L9-L10`, `src/llama-mmap.cpp:L320-L355`).
- If the kernel rejects the direct read (`EFAULT`/`EINVAL`), the loader falls
  back to buffered I/O transparently (`src/llama-mmap.cpp:L291-L302`).

## 6. KV cache quantization (`--cache-type-k` / `--cache-type-v`)

Quantizing the KV cache reduces its memory footprint at some accuracy cost.

- CLI: `-ctk, --cache-type-k TYPE` (`common/arg.cpp:L2439-L2453`) and
  `-ctv, --cache-type-v TYPE` (`common/arg.cpp:L2452-L2466`).
- Env vars: `LLAMA_ARG_CACHE_TYPE_K`, `LLAMA_ARG_CACHE_TYPE_V`.
- Default for both: `f16` (`common/common.h:L593-L594`).
- Allowed values (`common/arg.cpp:L304-L314`): `f32`, `f16`, `bf16`, `q8_0`,
  `q4_0`, `q4_1`, `iq4_nl`, `q5_0`, `q5_1`.
- API: `llama_context_params.type_k` / `type_v`
  (`include/llama.h:L396-L397`), default `GGML_TYPE_F16`
  (`src/llama-context.cpp:L3966-L3967`).
- Draft model variants: `--spec-draft-type-k` / `--spec-draft-type-v`
  (`common/arg.cpp:L4109-L4136`).

Constraints enforced in `llama_init_from_model()`
(`src/llama-context.cpp:L4020-L4054`):

- MLA models and DeepSeek4 require K and V to use the same type.
- A quantized V cache requires Flash Attention to be enabled (AUTO is upgraded
  to ENABLED, DISABLED is a hard error).
- For a quantized K or V type, the type's block size must divide the per-head
  dimension (`n_embd_head_k` / `n_embd_head_v`).

There is also a runtime guard in the context constructor: a quantized V cache
without Flash Attention throws (`src/llama-context.cpp:L555-L561`).

## 7. Flash Attention (`--flash-attn`)

Flash Attention changes the attention kernel and is a prerequisite for a
quantized V cache and for tensor-parallel split mode.

- CLI: `-fa, --flash-attn [on|off|auto]` (`common/arg.cpp:L1755-L1773`).
- Env var: `LLAMA_ARG_FLASH_ATTN`.
- Default: `auto` (`common/common.h:L504`).
- Enum `llama_flash_attn_type` (`include/llama.h:L192-L196`):
  `AUTO = -1`, `DISABLED = 0`, `ENABLED = 1`.
- API: `llama_context_params.flash_attn_type`
  (`include/llama.h:L381`), default `AUTO`
  (`src/llama-context.cpp:L3955`).

Resolution and interactions:

- `AUTO` is resolved at runtime by probing whether the fused Flash Attention op
  is supported (`src/llama-context.cpp:L314-L319`, `L649-L652`).
- Grok forces Flash Attention off (`src/llama-context.cpp:L4001-L4006`).
- `SPLIT_MODE_TENSOR` requires Flash Attention; `AUTO` is upgraded to `ENABLED`
  and `DISABLED` is a hard error (`src/llama-context.cpp:L4008-L4016`).
- Training (`opt_init`) disables Flash Attention because the op has no backward
  pass (`src/llama-context.cpp:L3715-L3726`).

## 8. KV cache offload (`--kv-offload` / `--no-kv-offload`)

Controls whether the KQV ops and the KV cache are offloaded to the GPU.

- CLI: `-kvo, --kv-offload` / `-nkvo, --no-kv-offload`
  (`common/arg.cpp:L2416-L2423`).
- Env var: `LLAMA_ARG_KV_OFFLOAD`.
- API: `llama_context_params.offload_kqv` (`include/llama.h:L409`), default
  `true` (`src/llama-context.cpp:L3972`).
- Disabling it frees device memory at the cost of slower attention.

## 9. Unified KV cache (`--kv-unified`)

Uses a single KV buffer shared across all sequences instead of per-sequence
buffers.

- CLI: `-kvu, --kv-unified` / `-no-kvu, --no-kv-unified`
  (`common/arg.cpp:L1726-L1733`).
- Env var: `LLAMA_ARG_KV_UNIFIED`.
- API: `llama_context_params.kv_unified` (`include/llama.h:L415-L417`), default
  `false` (`src/llama-context.cpp:L3976`).
- Server helper: `--kv-unified-per-slot N` sizes the shared pool to
  `n_parallel * N` when `-c` is unset (`common/arg.cpp:L1652-L1659`).
- Recommended to disable when `n_seq_max > 1` and sequences do not share a large
  prefix (`include/llama.h:L415-L417`).

## 10. Full-size SWA cache (`--swa-full`)

For sliding-window-attention models, uses a full-size SWA cache instead of a
smaller windowed one.

- CLI: `--swa-full` (`common/arg.cpp:L1692-L1699`).
- Env var: `LLAMA_ARG_SWA_FULL`.
- API: `llama_context_params.swa_full` (`include/llama.h:L412-L414`), default
  `true` (`src/llama-context.cpp:L3975`).
- Setting it to false with `n_seq_max > 1` can hurt performance in some cases
  (`include/llama.h:L413-L414`).

## 11. NUMA (`--numa`)

Attempts NUMA-aware optimizations on multi-socket systems.

- CLI: `--numa TYPE` (`common/arg.cpp:L2725-L2739`).
- Env var: `LLAMA_ARG_NUMA`.
- Values: `distribute` (spread execution over all nodes), `isolate` (spawn
  threads only on the starting node), `numactl` (use the numactl CPU map).
- API: `llama_numa_init(enum ggml_numa_strategy)` (`include/llama.h:L492-L498`).
- NUMA mode disables mmap prefetch and advises the mapping `POSIX_MADV_RANDOM`
  (`src/llama-mmap.cpp:L486`, `L521-L526`).

## 12. MoE and expert memory options

These control where Mixture-of-Experts weights live, which is often the largest
memory lever for MoE models.

- `-cmoe, --cpu-moe`: keep all MoE expert weights in CPU RAM
  (`common/arg.cpp:L2762-L2768`).
- `-ncmoe, --n-cpu-moe N`: keep the MoE expert weights of the first N layers in
  CPU RAM (`common/arg.cpp:L2769-L2778`).
- `-ncffn, --n-cpu-ffn N`: keep the dense FFN weights of the first N layers in
  CPU RAM, for dense models (`common/arg.cpp:L2789-L2799`).
- `--moe-cache-mib N`: GPU cache size in MiB for experts kept in host memory,
  split across GPUs like the layers (`common/arg.cpp:L2779-L2788`). Maps to
  `llama_context_params.moe_cache_size` (`include/llama.h:L399`).
- `-ot, --override-tensor <pattern>=<buft>,...`: force a tensor buffer type
  (`common/arg.cpp:L2756-L2761`).
- Draft-model variants: `--spec-draft-cpu-moe`, `--spec-draft-n-cpu-moe`,
  `--spec-draft-override-tensor` (`common/arg.cpp:L4135-L4157`).

## 13. Other memory-relevant options

- `--no-host`: bypass the host buffer so extra (repacking) buffers can be used
  (`common/arg.cpp:L2432-L2438`); API `llama_model_params.no_host`
  (`include/llama.h:L354`).
- `--repack` / `-nr, --no-repack`: enable/disable weight repacking, which trades
  extra buffers for faster CPU matmul (`common/arg.cpp:L2424-L2431`); API
  `llama_model_params.use_extra_bufts` (`include/llama.h:L353`).
- `--op-offload` / `--no-op-offload`: offload host tensor ops to the device
  (`common/arg.cpp:L2959-L2966`); API `llama_context_params.op_offload`
  (`include/llama.h:L411`).
- `--check-tensors`: validate tensor data for invalid values
  (`common/arg.cpp:L2940-L2946`); API `llama_model_params.check_tensors`
  (`include/llama.h:L352`).
- `no_alloc`: API-only field that loads metadata and simulates allocations
  without allocating buffers (`include/llama.h:L355`). No CLI flag.
- `-ngl, --gpu-layers N`: layers to keep in VRAM, `auto` or `all`
  (`common/arg.cpp:L2801-L2816`).
- `-sm, --split-mode`: `none`, `layer`, `row`, `tensor`
  (`common/arg.cpp:L2819-L2829`).
- `-ts, --tensor-split`: per-GPU offload proportions
  (`common/arg.cpp:L2843-L2853`).
- `-mg, --main-gpu`: GPU for the model or intermediate results
  (`common/arg.cpp:L2870-L2879`).
- `-fit, --fit`: adjust unset args to fit device memory
  (`common/arg.cpp:L2880-L2890`); helpers `--fit-print`, `--fit-target`,
  `--fit-ctx` (`common/arg.cpp:L2894-L2939`).
- `-cram, --cache-ram N`: server prompt-cache size in MiB, `-1` no limit, `0`
  disable (`common/arg.cpp:L1718-L1725`).
- `-ctxcp, --ctx-checkpoints N`: max context checkpoints per slot
  (`common/arg.cpp:L1700-L1707`).
- `-dt, --defrag-thold`: deprecated, no longer needed
  (`common/arg.cpp:L2535-L2542`).

## 14. Key source locations

- Enums and API fields: `include/llama.h` (`llama_load_mode` L207-L216,
  `llama_lazy_mode` L218-L222, `llama_flash_attn_type` L192-L196,
  `llama_model_params` L320-L357, `llama_context_params` L366-L428).
- CLI parsing and help text: `common/arg.cpp`.
- Default values: `common/common.h` (`common_params`).
- Mode application: `src/llama-model.cpp` (`load_tensors`, L1560-L1600).
- Loader internals: `src/llama-model-loader.cpp`, `src/llama-model-loader.h`.
- mmap/mlock/direct I/O: `src/llama-mmap.cpp`, `src/llama-mmap.h`.
- Context validation: `src/llama-context.cpp` (`llama_init_from_model`,
  L4001-L4054).
- Name helpers: `src/llama.cpp` (`llama_flash_attn_type_name` L38-L48,
  `llama_load_mode_name` L50-L60).
- Server docs: `tools/server/README.md`.
