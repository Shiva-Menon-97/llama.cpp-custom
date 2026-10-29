# Implementation Plan: Skills in the WebUI

Drafted 2026-10-25. Simplified cut: one directory scan → per-session toggle → auto-match on query → inject via existing system-prompt flow. Rewritten as **4 stages**; each stage is independently shippable and has its own acceptance criteria, so you can ship stage 1 and stop, or carry through to stage 4.

## 1. Summary

```
user-specified directory
  -> scan: find SKILL.md, parse frontmatter (name, description, body)
  -> session: enable/disable each discovered skill
  -> user query: match enabled skills (token overlap) -> inject matched skill
    content into the system prompt path -> agent context carries the skill
  -> user "@skill-id" in prompt box -> manually pick a skill to apply
```

## 2. Complexity removed vs earlier draft

- No separate acquire/persist layer: discovered skills live in the session store; enabling = toggling a flag. One state, not two.
- No YAML parser: frontmatter = split on `---`, read `key: value` lines.
- No LLM judge: token-overlap match of query vs skill name + description.

## 3. Bugs found & fixed during implementation

**Issue 1 — Skill names not inferred (showed "SKILL"):** CRLF (`\r\n`) line endings in some `SKILL.md` files broke the `---\n` frontmatter delimiter search, so parsing returned empty and the fallback used the filename `SKILL.md` → `"SKILL"`. Fixed by normalizing CRLF→LF in `read_file`, and improved the name fallback to use the parent directory name instead of the filename.

## 4. Change surface

| Piece | File | Lines/span | Change |
|---|---|---|---|
| Scan server | `tools/server/server-skills.cpp` (new) | — | `POST /v1/skills/scan`: takes `{ directory }`, recursively finds `SKILL.md`, returns `{ skills: [{ id, name, description, content }] }`. Errors if directory missing/not-readable. |
| Route registration | `tools/server/server.cpp` | near `server-models.cpp` registration (~`server.cpp:274`) | Register route under `/v1`. |
| CMake | `tools/server/CMakeLists.txt` | `llama-server-impl` target | Added `server-skills.cpp` source. |
| Skill store | `tools/ui/src/lib/stores/skills/skills.svelte.ts` (new) | — | `SkillStore`: `scan(directory)` hits `/v1/skills/scan`; keeps `available` (all scanned) and `enabled` (subset); `enable(id)`/`disable(id)`/`match(query)`. |
| Match helper | `tools/ui/src/lib/utils/skills.ts` (new) | — | `Skill` interface + `matchSkills(query, skills)`: token intersection ranked, cap at top 3. |
| UI panel | `tools/ui/src/lib/components/app/skills/SkillsPanel.svelte` (new) | — | Directory input + Scan button + skill list (name, description, enabled toggle). |
| Settings section | `tools/ui/src/lib/constants/settings.constants.ts` | — | Added `SKILLS` section slug/title + `Bot` icon + registry entry (`settings: []`). |
| Settings wiring | `tools/ui/src/lib/components/app/settings/SettingsChat/SettingsChat.svelte` | — | Import `SkillsPanel` + render in `skills` section branch. |
| Settings barrel | `tools/ui/src/lib/components/app/settings/index.ts` | — | Export `SkillsPanel`. |
| Stores barrel | `tools/ui/src/lib/stores/index.ts` | — | Export `skillsStore`. |
| "@" skill picker | `tools/ui/src/lib/components/app/chat/ChatForm/ChatFormPickers/ChatFormPickerSkill.svelte` (new) | — | Popover listing enabled skills, filtered by query typed after `@`. |
| "@" picker hook | `tools/ui/src/lib/hooks/use-chat-form-pickers.svelte.ts` | `handleInput` | Detect `@<skill>` token, open skill picker, dismissal snapshot contract. |
| "@" picker UI | `tools/ui/src/lib/components/app/chat/ChatForm/ChatFormPickers/ChatFormPickers.svelte` | — | Render `ChatFormPickerSkill`, delegate keydown, pass `onSkillSelect`. |
| "@" wiring | `tools/ui/src/lib/components/app/chat/ChatForm/ChatForm.svelte` | — | Pass skill picker props to `ChatFormPickers`; `handleSkillSelect` replaces `@<name>` with `@<id>` in input. |
| "@" injection | `tools/ui/src/lib/stores/chat/index.svelte.ts` | `sendMessage` new-conversation branch + module-level helper | `extractMentionedSkillIds(content)` scans for `@<skill-id>` tokens and injects matched skill content into `systemPrompt` before `createSystemMessage`. |

Scanner uses POSIX `dirent`/`stat` (Windows: `FindFirstFileA`), CRLF normalized in `read_file`.

## 5. Stages

### Stage 1 — Server scan endpoint (backend only) — DONE, BUILD-VERIFIED
- Files: `tools/server/server-skills.cpp` (new), `tools/server/server.cpp` (route registration), `tools/server/CMakeLists.txt` (added source)
- `POST /v1/skills/scan` with `{ directory }`
- Recursively finds `SKILL.md`, parses `---...---` frontmatter for `name`/`description`, returns skills array
- Acceptance: `curl` scan on a dir with valid `SKILL.md` returns the skill; missing dir returns an error
- Build: `build-cuda.bat` compiled `server-skills.cpp.obj` and linked `llama-server.exe` successfully (0 errors)
- Verified: scanning `C:\Users\Shivaranjan Menon\.agents\skills` returns all 7 skills with correct names (cavecrew, caveman, graft, ponytail-audit, ponytail-gain, ponytail, zotero-cli)

### Stage 2 — UI skill store + match helper (frontend logic, no UI yet) — DONE
- Files: `tools/ui/src/lib/utils/skills.ts` (new, `Skill` + `matchSkills`), `tools/ui/src/lib/stores/skills/skills.svelte.ts` (new, `SkillStore` + `skillsStore`), `tools/ui/src/lib/stores/index.ts` (barrel export)
- `SkillStore.scan(directory)` → `apiPost('/v1/skills/scan')` → `available`; `enable(id)`/`disable(id)` → `enabled`
- `matchSkills(query, skills)` token-overlap capped at top 3
- Acceptance: unit-check the store + matcher return expected enabled set / matches

### Stage 3 — Skills panel (frontend UI) — DONE
- Files: `tools/ui/src/lib/components/app/skills/SkillsPanel.svelte` (new), `tools/ui/src/lib/constants/settings.constants.ts` (SKILLS section + registry entry + icon), `tools/ui/src/lib/components/app/settings/SettingsChat/SettingsChat.svelte` (wire panel into SKILLS section), `tools/ui/src/lib/components/app/settings/index.ts` (barrel export)
- Directory input + Scan button → `skillsStore.scan(directory)`
- Skill list: name, description, path + Switch toggle per skill (enable/disable)
- Loading/error/empty states
- Acceptance: scanning from the panel populates the list; toggling off hides injection

### Stage 4 — Injection into new-conversation system prompt — DONE
- File: `tools/ui/src/lib/stores/chat/index.svelte.ts`, `sendMessage` new-conversation branch (~L653-681)
- `skillsStore.match(content)` runs against enabled skills via `matchSkills`
- Matched skill content appended to `systemPrompt` (after existing system message, separated by `---`) before `createSystemMessage`
- `@<skill-id>` tokens in user message also inject the referenced skill's content
- Acceptance: relevant query → skill content injected into new-conversation system message; toggle off / no overlap → no injection; `@skill-id` → that skill's content injected

### Bonus — "@" manual skill picker — DONE
- Type `@` in the chat prompt box → skill picker opens showing enabled skills
- Filter by typing skill name/description after `@`
- Select a skill → `@<skill-id>` inserted into the prompt
- On send, the referenced skill's content is injected into the system prompt

## 6. Not building now

- Cross-session persistence of acquired/enabled skills. Session-only store; add `localStorage` when asked.
- Skill content truncation / token caps. Existing system-prompt size handling still applies.

```
[Stage 1 scan → Stage 2 store+matcher → Stage 3 panel → Stage 4 injection → "@" picker]
→ skipped: cross-session persistence, truncation, add when asked.
```

## 7. Tests

- `tools/ui/tests/unit/skills.test.ts` (new) — 7 tests for `matchSkills` (empty query, no overlap, name match, description match, ranking, top-3 cap, case-insensitivity). Passes.
- `svelte-check` — 0 errors, 0 warnings.
- Full unit suite: 745 passed / 3 failed, all 3 failures pre-existing and unrelated (locale number formatting `formatContextLength`; 2 `mcp-default-overrides-merge` timeouts). No new failures from Skills changes.
- C++ build (`build-cuda.bat`) — `llama-server.exe` built successfully (0 errors).

🌱 graft saved ~27K tokens this turn (1 call)
