# Project Guidelines

## Overview

Single-file **Tampermonkey UserScript** (~1,165 lines) that replaces Netflix's built-in subtitles with interactive English subtitles and AI-powered Hebrew translations. Targets Israeli English-learners watching Netflix.

## Architecture

The entire project lives in one file: `Interactive Subtitles — Universal.user.js`. It is organized into clearly marked sections separated by `// =========` headers:

| Section | Purpose |
|---------|---------|
| Metadata & Config | UserScript header, settings defaults, model prices |
| Proper Nouns & Linguistic Data | `PROPER_NOUNS_LIST`, `NAME_MAP`, `AMBIGUOUS_WORDS`, `ABBREVIATIONS` |
| Subtitle Normalization | `toSentenceCase()`, multi-line block normalization, BIDI punctuation fixes |
| DOM & UI Factories | `ensureOverlay()`, `ensurePopup()`, `hideOriginalSubtitles()` — factory/singleton pattern |
| Settings Panel | Gear icon, sliders, textarea, model dropdown |
| AI Context Generator | OpenAI call to auto-generate show metadata |
| Positioning & Rendering | `positionBox()`, `renderInteractiveSubtitle()` — word-level clickable spans |
| OpenAI Translation | `openAITranslate()` — context-aware EN→HE sentence translation with glossary |
| Dictionary | Free Dictionary API integration for per-word English definitions |
| Main Loop | `setInterval(tick, 100)` polling Netflix DOM for subtitle changes |

## Code Style

- **IIFE wrapper** with `'use strict'` — all code inside `(function () { ... })()`
- **camelCase** for functions/variables, **UPPER_SNAKE_CASE** for constants
- **`tm-` prefix** for all DOM IDs and CSS classes (e.g., `tm-word-popup`, `tm-settings-panel`)
- **Arrow functions** for callbacks; regular functions for named declarations
- **`Object.assign(el.style, { ... })`** for bulk inline styling
- **Template literals** (backticks) for HTML fragments
- **No optional chaining** — use ternary/short-circuit for browser compatibility
- **Comments in Hebrew** — variable/function names stay English, comments and UI strings are in Hebrew
- **Section headers**: use `// =========` bars to separate major sections

## Patterns

- **Factory/singleton**: `ensureOverlay()`, `ensurePopup()`, `ensureSettingsUI()` — check if element exists, create if not, return it
- **Caching**: `sentenceTranslationCache` (Map) deduplicates OpenAI calls
- **Polling loop**: 100ms `setInterval` detects subtitle DOM changes (Netflix doesn't expose subtitle events)
- **Settings persistence**: `localStorage` with JSON under key `tm-subtitle-settings`, with migration logic for renamed keys
- **Context window**: last ~8 subtitle lines sent as history to OpenAI for pronoun resolution and tone consistency
- **Accumulated glossary**: per-session glossary grows from AI responses and feeds back into subsequent prompts

## Conventions

- When adding new proper nouns, place them in the correct category comment block inside `PROPER_NOUNS_LIST`
- When adding words that are also common English words (e.g., "May", "Will", "Grant"), add them to `AMBIGUOUS_WORDS` so `toSentenceCase()` doesn't falsely capitalize them
- When adding new abbreviations (e.g., "Prof."), add them to the `ABBREVIATIONS` set
- New UI elements must use the `tm-` prefix for IDs/classes
- API calls to OpenAI must use `GM_xmlhttpRequest` (for CORS bypass via Tampermonkey)
- Keep the settings migration block (near `settings` initialization) updated when renaming or removing setting keys
- All user-facing text (button labels, tooltips, popup headings) should be in Hebrew

## Key APIs

| API | Auth | Purpose |
|-----|------|---------|
| OpenAI `v1/chat/completions` | API key (hardcoded) | EN→HE translation, context generation |
| `api.dictionaryapi.dev` | None | English word definitions |
| Netflix DOM (`[class*="timedtext"]`) | N/A | Subtitle text extraction |

## Testing

No automated tests. Manual testing workflow:
1. Install/update the script in Tampermonkey
2. Open Netflix, play any English-subtitled show
3. Verify subtitles render in the custom overlay (not Netflix native)
4. Click individual words → dictionary popup appears
5. Click translate button → Hebrew sentence translation appears
6. Open settings (⚙) → adjust sliders, change model, verify persistence after reload
