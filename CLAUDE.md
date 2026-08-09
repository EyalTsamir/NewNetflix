# CLAUDE.md

## Response language
**Always respond in English in chat, even when the user writes in Hebrew.** Non-negotiable. The user frequently types in Hebrew for convenience but wants Claude's replies in English, always.

This rule scopes to conversational replies only. It does **not** apply to file content — inside the source file, Hebrew comments and Hebrew user-facing UI strings stay Hebrew (see project conventions).

## Project scope
This is a **Netflix-only** Tampermonkey userscript. The word "Universal" in the filename is historical residue from an earlier intent — the project is deliberately narrow-scoped to Netflix. Do not propose extending to Disney+, YouTube, HBO, or any other platform unless explicitly asked.

Full architecture, code style, patterns, and naming conventions are documented in [.github/copilot-instructions.md](.github/copilot-instructions.md). Read it before making non-trivial edits.

## Critical constraint: single file only
The user installs the script by **copy-pasting the entire file contents** into the Tampermonkey Dashboard. This means:

- **Never** split the script into multiple files, modules, or imports.
- **Never** introduce a build step, bundler, or external dependency.
- Everything new goes into the same `.user.js` file, as a new section demarcated by a `// =========` header.
- Because the user re-pastes the whole file on every change, keep it trim: no dead code, no commented-out experiments, no orphaned TODO markers.

## Workflow for code changes
1. Claude edits the file on disk directly.
2. User copy-pastes the full contents into the Tampermonkey Dashboard editor (replacing everything).
3. User saves (`Ctrl+S`) and hard-refreshes the Netflix tab (`Ctrl+Shift+R`).

## Do not touch
- **Hardcoded OpenAI API key** — intentional. The key is scoped to a project with a $5 billing cap, so leakage is low-risk and the user prefers zero-config installation. Do not propose extracting it to `GM_setValue`, env vars, a prompt, or anywhere else.
- **BIDI / RTL handling inside `toSentenceCase()`** (step 0 — the punctuation-drift fix) — this was a hard-won bug fix after real pain. Do not "clean up" or refactor this block. If you think there's a better approach, **ask first**.

## Change discipline
- For anything beyond a small localized fix, describe the approach and wait for confirmation before implementing.
- For aesthetic changes (renames, reorderings, comment rewrites), always propose first and wait for approval.
- Terse, direct output is preferred — no multi-paragraph preambles about what you're about to do. One sentence of intent, then the work.

## Adding proper nouns to `PROPER_NOUNS_LIST`
The list was AI-generated in bulk. When adding new names:
- Place them inside the matching category block (first names, surnames, cities, etc.). The grouping exists for human maintainability.
- If a new name is also a common English word (e.g., "May", "Hope", "Will"), add the lowercase form to `AMBIGUOUS_WORDS` to prevent false capitalization in the sentence-case normalizer.

## Testing
No automated tests. Manual verification in-browser only:
1. Copy-paste updated script into Tampermonkey, save, hard-refresh Netflix.
2. Play any show with English subtitles — custom overlay should render (not Netflix's native captions).
3. Click a word → dictionary popup appears with definitions.
4. Click the translate (🌐) button → Hebrew translation popup with historical context appears.
5. Open settings (⚙) → sliders adjust live, persist across reload.

The user verifies manually. If you cannot verify a UI change yourself, say so explicitly rather than claiming it works.
