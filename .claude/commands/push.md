# /push — Review staged files and push

You are performing a push workflow for the NewNetflix project. Follow these steps carefully and in order.

There is no build step, no CI, and no test suite in this project — it is a single-file Tampermonkey userscript that the user installs by copy-pasting. Do NOT invent a build, lint, or test step.

## Step 0: GitHub account safety — check every time, before doing anything else

This machine has **two** GitHub accounts logged into `gh`: `EyalTsamir` (this project's owner) and `Ronen3D` (a different project's owner, unrelated to NewNetflix). NewNetflix must **only ever** be pushed to **EyalTsamir**. Never let it end up on `Ronen3D`.

1. Run `git remote -v`.
2. **If `origin` already exists:** confirm the URL host/owner is `github.com/EyalTsamir/...`. If it's `Ronen3D` or anything else, **STOP** and ask the user before doing anything further — do not push, do not change the remote yourself. (This has happened before: `origin` shipped pointing at `Ronen3D/NewNetflix`, a repo that doesn't exist.)
3. Confirm the credential helper resolves to EyalTsamir, not whichever account Git Credential Manager has cached. This repo pins it locally in `.git/config`:
   ```
   credential.https://github.com.helper=
   credential.https://github.com.helper=!gh auth git-credential
   ```
   The empty first value resets the system-level `manager` helper so `gh` wins. If those two lines are missing, restore them before pushing, and verify with `gh api user --jq '.login'` that the active account is `EyalTsamir`.
4. **If no `origin` exists**, this is first-time setup. Confirm the repo name and visibility with the user, then create it with the owner **explicit** in the name, never relying on whichever account happens to be active: `gh repo create EyalTsamir/NewNetflix --source=. --remote=origin --private`.

## Step 0.5: The repo is private on purpose — keep it that way

Both userscripts contain a hardcoded `OPENAI_API_KEY`. Per [CLAUDE.md](../../CLAUDE.md) this is intentional and must not be extracted. But on a **public** repo, GitHub secret scanning reports the key to OpenAI and it gets auto-revoked, breaking the script. So:

- Never make this repo public, and never suggest it, without the user explicitly asking.
- Never propose moving the key out of the file as part of a push.

## Step 1: Stage ALL modified files

1. Run `git status` to see all modified, staged, and untracked files.
2. Stage **all** modified and previously-staged files — not just files changed in the current conversation. The push captures the full state of the working tree.
3. **Exclude** (unstage with `git reset HEAD <file>`) only files that are clearly: temporary files, debug artifacts, log files, screenshots, or other unintended changes.
4. **If uncertain** about any file — ask the user before proceeding. Do not silently exclude or include ambiguous files.
5. Run `git diff --cached --stat` for an overview of what will be committed.

Note: this repo has `core.autocrlf` behavior that produces `LF will be replaced by CRLF` warnings on every `git add` of the `.user.js` files. That warning is expected and harmless — do not try to "fix" it or treat it as a failure.

## Step 2: Generate commit message and commit

1. Review all staged changes (read the diffs, not just file names) and identify distinct **change topics** — logical themes that group related changes regardless of which files they touch.
2. Match the style of existing commits in `git log`:
   ```
   <Short imperative summary line, no period>

   - <change topic, one line>
   - <change topic, one line>
   ```
   - Title line: concise, imperative mood, under ~70 characters.
   - Body: a flat bullet list (`-`), one line per logical change, feature-level not file-level. Skip the body entirely for small, single-purpose commits.
   - Write in **English**, even though the script's comments and UI strings are Hebrew.
   - Describe the change in terms of what the **viewer** experiences (subtitles, popups, settings panel, audio), not internal function names, wherever a user-visible effect exists. If a change is purely internal with no observable effect, say so plainly rather than overstating it.
   - When the same fix lands in both `Netflix Interactive Subtitles.user.js` and `Disney+ Interactive Subtitles.user.js`, say so once at the end rather than duplicating every bullet.
3. Present the commit message to the user for approval before committing — output it as plain text in the chat response (a fenced code block), not embedded inside an AskUserQuestion option. Ask for approval as a separate, short yes/no question after the message is already visible.
4. Once approved, commit with a `Co-Authored-By: Claude <model> <noreply@anthropic.com>` trailer, then push to `origin main` (after re-confirming Step 0's remote check).

## Important notes

- Never push this repo to the `Ronen3D` account or any remote other than `github.com/EyalTsamir/...` — see Step 0.
- Do not write scratch/temp files anywhere (especially not into `.git/`) as part of this workflow — if a multi-line commit message is needed, pass it via a Bash heredoc (`git commit -F - <<'EOF' ... EOF`), not a temp file.
- Do NOT bump `SCRIPT_VERSION` as part of `/push`. It's bumped deliberately when the user wants a visible version change in the settings panel, not on every push.
- Always ask the user before proceeding if anything is unclear or ambiguous.
- Reply in **English** in chat per [CLAUDE.md](../../CLAUDE.md), even when the user writes in Hebrew.
