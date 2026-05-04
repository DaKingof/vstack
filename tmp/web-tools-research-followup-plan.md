# pi-web-tools deep-research follow-up plan

This is a continuation handoff for `/mnt/Tertiary/dev/vstack/main/worktrees/web-tools-research-skill` on branch `feature/web-tools-research-skill`.

Do **not** bump package or CLI versions unless the user explicitly asks. Do **not** include the unrelated local change in `pi-extensions/pi-extension-manager/extensions/extension-manager.ts`.

## 0. Current state

Committed work:

- `6599bce feat: add pi web tools deep research`
- `3bfe187 fix: render web research tools compactly`

Done:

- `pi-web-tools` exists and is discoverable as a Pi package.
- `web_search` ownership moved out of `pi-codex-minimal-tools`.
- `web_research` calls Exa Deep Search, writes `findings.md`, and can write raw metadata sidecar JSON.
- Exa key loading supports env, `.env.local`, private config, and `op://` 1Password refs.
- `skills/deep-research/scripts/deep-research` works outside Pi and has tests.
- `researcher` agent exists and is mapped in `vstack.toml`.
- Research workflows now label research issues `agent:researcher` instead of `agent:human`.
- Live Pi smoke test succeeded: `/web-tools doctor` showed Exa key present/deep research available; `web_research` wrote findings and raw metadata with 10 sources.
- Compact renderers exist for `web_research`, `web_search`, and `web_fetch`.

Out of scope unless explicitly requested:

- Browser curator UI. The user wants automatic Exa deep research, not manual search curation UI.

## 1. References to use

Primary local code/docs:

- `pi-extensions/pi-web-tools/`
- `skills/deep-research/`
- `agents/researcher.md`
- `skills/project-management/workflows/research-issue.md`
- `skills/project-management/workflows/research-complete.md`
- `skills/project-management/workflows/research-spike.md`
- `skills/flightdeck/workflows/start.md`
- `skills/orchestration/SKILL.md`
- `vstack.toml`
- `.env.local.example`

External/reference implementation:

- `pi-web-access`: <https://github.com/nicobailon/pi-web-access>
- Pi package page summary: <https://pi.dev/packages/pi-web-access>
  - Key features documented there: Exa/Perplexity/Gemini provider fallback, `fetch_content` fallback chain, GitHub cloning, PDF extraction, YouTube/local video support, Jina Reader/Gemini fallback for blocked pages.

Example report style to emulate:

- `/mnt/Tertiary/dev/hyprtrade/main/docs/research/CC-426/findings.md`
- `/mnt/Tertiary/dev/hyprtrade/main/docs/research/CC-426/prompt.txt`
- `/mnt/Tertiary/dev/hyprtrade/main/docs/research/CC-426/context-study-language.md`

Observed report traits from `CC-426/findings.md`:

- Clean title as a decision/recommendation, not a generic tool dump.
- Starts with a strong 2–3 paragraph recommendation/executive summary.
- Uses topic-specific headings, not a rigid low-information template.
- Includes comparison matrices and architecture details when useful.
- Does **not** bury raw JSON in the main report.

## 2. Product direction

Goal: automatic Exa deep research like ChatGPT/Claude deep research.

Desired workflow:

1. User/orchestrator provides prompt text.
2. Orchestrator/research workflow attaches or references context files.
3. Researcher agent runs Exa deep research automatically.
4. Researcher writes a clean `findings.md` report.
5. Raw metadata/cost/source details go to sidecar JSON or footer metadata, not the main body.
6. Parent workflow verifies findings, comments on the issue, and continues `research-complete`.

Non-goal for now:

- Interactive browser/search curator UI.
- Manual source review loops unless explicitly requested.

## 3. Follow-up phases

### Phase A — tighten Exa deep research quality and modes

Implement settings and tool/script flags that distinguish **lite** vs **full** behavior.

Suggested modes:

| Mode | Intended use | Exa type | Sources/results | Text cap | Timeout | Notes |
|---|---|---|---:|---:|---:|---|
| `lite` | fast spike, quick answer, low cost | `deep-lite` | 10–20 | 8k–12k chars/result | 3–5 min | Current smoke-test style. |
| `standard` | normal workflow research | `deep-reasoning` | 30–60 | 12k–20k | 10 min | Default for researcher issues. |
| `full` | strategic/high-risk decisions | `deep-reasoning` plus additional queries | 100–300+ where useful | 20k+ | 20–45 min | Can make multiple Exa calls, dedupe sources, synthesize. |

Implementation notes:

- Add `researchMode?: 'lite' | 'standard' | 'full'` to Pi `web_research` and the portable script.
- Keep explicit low-level overrides: `type`, `numResults`, `textMaxCharacters`, `additionalQueries`, domains, date filters.
- For `full`, do not assume a single Exa request is enough. Plan for a coordinator loop:
  1. Parse prompt into subquestions.
  2. Generate additional search queries.
  3. Run multiple Exa deep/search calls with domain/date filters.
  4. Dedupe URLs and snippets.
  5. Produce final synthesis.
- Return/source metadata should include: mode, query count, source count, unique source count, elapsed time, Exa request metadata, raw sidecar path.

Acceptance criteria:

- `web_research` supports `researchMode` with documented defaults.
- `scripts/deep-research report --mode lite|standard|full` works.
- Tests verify mode-to-parameter mapping.
- Full mode can exceed 10 sources and supports multi-query aggregation without duplicating URLs.
- Missing/invalid mode fails with a clear error.

### Phase B — improve report generation and output shape

Current template is serviceable but too generic and embeds raw JSON in `findings.md`. Replace it with a cleaner findings renderer that mirrors the `CC-426` style.

Report rules:

- `findings.md` should be human-readable and decision-ready.
- Raw Exa JSON should default to a sidecar file, e.g. `raw-exa.json` or `findings.raw.json`.
- Main report can include a short `## Research Metadata` section with mode/source counts/raw sidecar path, but not full raw JSON.
- Headings should be adapted to the prompt when possible.
- Required minimum sections:
  - Title
  - Executive Summary / Recommendation
  - Key Findings
  - Evidence and Sources
  - Tradeoffs / Alternatives
  - Recommendation / Decision Criteria
  - Risks / Unknowns
  - Revisit Conditions
- Optional sections when prompt asks or evidence supports:
  - Competitor matrix
  - Candidate scoring matrix
  - Architecture recommendation
  - Migration path
  - Proof-of-concept specification
  - Go/No-Go criteria

Implementation options:

1. Deterministic renderer only:
   - Safer and fast, but generic.
2. Exa structured output schema:
   - Ask Exa for structured JSON matching the report schema, then render Markdown.
3. Hybrid:
   - Exa synthesis + deterministic section renderer + optional schema for matrices.

Recommended path:

- Use Exa `outputSchema` for `standard/full` when possible.
- Keep deterministic fallback if schema output is absent.
- Keep raw sidecar always available.

Acceptance criteria:

- `findings.md` no longer embeds full raw JSON by default.
- Raw metadata sidecar is written by default for workflow/researcher execution.
- A generated report from the CC-426 prompt/context shape resembles the clean structure of `docs/research/CC-426/findings.md`.
- Tests assert required headings and absence of raw JSON block unless explicitly requested.
- Tests assert raw sidecar path is returned and written.

### Phase C — make prompt/context ingestion reliable

Ensure orchestration can pass prompt text and context files into Exa/researcher execution exactly like current human deep research workflow.

Current workflow expectation:

- `research-issue.md` creates:
  - `prompt.txt`
  - `context-*.md`
  - `run.sh` or `command.txt`
- Researcher receives a delegation prompt with paths.
- Researcher runs `deep-research` or `web_research`.

Improvements:

- Add explicit `queryFile` and `contextFiles` params to Pi `web_research`, mirroring the script.
- In Pi, `web_research` should resolve `@path` and relative paths against `ctx.cwd`.
- It should read context files itself and append them to the system prompt/query payload, rather than relying on the model to paste file contents.
- Support glob expansion for `context-*.md` carefully, bounded and sorted.
- Add `promptTemplate` or `reportProfile` if needed for project research reports.

Proposed `web_research` params:

```ts
{
  query?: string;
  queryFile?: string;
  contextFiles?: string[];
  contextGlob?: string;
  researchMode?: 'lite' | 'standard' | 'full';
  outputPath?: string;
  rawOutputPath?: string;
  reportProfile?: 'findings' | 'decision' | 'comparison' | 'architecture';
}
```

Acceptance criteria:

- `web_research` can run with only `queryFile`, `contextGlob`, `outputPath`, and `rawOutputPath`.
- Script and Pi tool share equivalent behavior.
- Tests cover path normalization, leading `@`, missing files, context ordering, and glob limits.
- Research workflow `run.sh` uses installed `.agents/skills/deep-research/scripts/deep-research`, not source `skills/...`.
- Researcher delegation remains self-contained.

### Phase D — finish web-access parity that matters for automatic research

Use/adapt ideas from `pi-web-access`, but keep focus on automated research and source ingestion.

Priority order:

1. `web_fetch` content extraction for research source follow-up.
2. GitHub URL extraction/clone for source-code/library research.
3. PDF extraction for whitepapers/docs.
4. Perplexity/Gemini provider fallback only if Exa is unavailable or for media/blocked pages.
5. YouTube/local video support only if research workflows need it.

#### D1. HTML/content extraction chain

Reference behavior from `pi-web-access` package summary:

```text
HTTP fetch → PDF? Extract text
           → HTML? Readability → RSC parser → Jina Reader → Gemini fallback
           → Text/JSON/Markdown? Return directly
```

Implement in `pi-web-tools/src/extract/`:

- `http.ts`: fetch, content-type detection, robots/errors recorded.
- HTML path:
  - Readability extraction via `@mozilla/readability` + `linkedom`.
  - Markdown conversion via `turndown`.
  - Detect cookie notices/empty extraction.
  - Jina Reader fallback.
  - Gemini URL Context fallback if keyed/enabled.
  - Gemini Web fallback only when explicitly opted in.
- Store full extracted content with `get_web_content` IDs.

Acceptance criteria:

- Fetching a normal article returns title, URL, markdown, and contentId.
- Cookie-notice/empty Readability output triggers fallback.
- Jina fallback test uses mocked HTTP.
- Gemini fallback is disabled unless keyed/opted in.
- Large content is truncated in tool output but fully stored/retrievable.

#### D2. PDF extraction

Implement:

- Detect `application/pdf` or `.pdf` URLs.
- Extract text/markdown with `unpdf` or a tested alternative.
- Save original/download metadata if useful.
- Store extracted content.

Acceptance criteria:

- Mock/local PDF fixture extracts text.
- Large PDF is truncated in inline output but full text is stored.
- Errors include URL/status and suggested fallback.

#### D3. GitHub extraction/clone

Reference behavior from `pi-web-access`: GitHub URLs are cloned locally instead of scraped; root URLs return repo tree + README; `/tree/` returns directory listings; `/blob/` returns file contents.

Implement:

- Parse GitHub URLs:
  - repo root
  - tree path
  - blob path
  - commit SHA views
- For small/public repos, clone or use GitHub API.
- For large repos, fallback to GitHub API/path-specific fetch.
- Cache clones under a Pi/package cache directory.
- Respect existing GitHub credentials if available, but public should work unauthenticated.

Acceptance criteria:

- Repo root returns README + tree summary + local clone path/contentId.
- Blob URL returns exact file contents with permalink metadata.
- Tree URL returns bounded listing.
- Large repo path avoids full clone when threshold exceeded.
- Tests cover URL parsing and mocked clone/API behavior.

#### D4. Perplexity/Gemini provider fallback

Current `pi-web-tools` stages these providers. Implement only if needed for fallback robustness.

Provider policy:

- `auto` remains Exa-first.
- `web_research` remains Exa-only unless user explicitly approves non-Exa fallback.
- `web_search` may fallback to Perplexity/Gemini if Exa is missing or fails.
- `web_fetch` may use Gemini for URL/video understanding when enabled.

Acceptance criteria:

- Provider selection tests cover direct provider and fallback order.
- Missing keys produce actionable messages.
- Non-Exa deep research fallback requires explicit opt-in.

#### D5. Video/YouTube/local video support

Defer until requested. If implemented, adapt from `pi-web-access` concepts:

- YouTube: Gemini Web → Gemini API → Perplexity fallback.
- Local video: Gemini Files API; optional `ffmpeg`/`yt-dlp` for frames/thumbnails.
- Keep browser-cookie access opt-in.

Acceptance criteria:

- YouTube URL test with mocked provider returns transcript/visual summary metadata.
- Local video test is opt-in or mocked; no required external binaries in unit tests.
- Clear diagnostics when `ffmpeg`/`yt-dlp` missing.

### Phase E — researcher/orchestration reliability

Improve the automated workflow so it behaves like the current human web deep research flow.

Research issue generation:

- Ensure `research-issue.md` writes `run.sh` with `.agents/skills/deep-research/scripts/deep-research`, not source-relative `skills/...`.
- Include all context files explicitly.
- Include desired mode (`standard` by default, `full` for strategic/pervasive/high-risk research).
- Include raw sidecar path.
- Include output schema/profile when appropriate.

Researcher agent:

- Prefer Pi `web_research` when active.
- Otherwise run `.agents/skills/deep-research/scripts/deep-research`.
- Must verify `findings.md` exists and is clean.
- Must not alter production code.

Completion:

- `research-complete.md` should parse metadata sidecar if available.
- Comments should include source count, mode, raw metadata path.
- Missing findings routes back to researcher delegation.

Acceptance criteria:

- Manual dry-run of `research-issue` produces prompt/context/run command/output paths.
- Delegation prompt is self-contained.
- Researcher can execute from only the provided paths.
- `research-complete` no longer contains stale human/external execution guidance.
- Flightdeck routes research-labeled issues to researcher execution or completion, never normal dev work.

## 4. Testing plan

### Unit/package tests

Run after each `pi-web-tools` change:

```bash
cd pi-extensions/pi-web-tools
npm install
npm run check
```

Expected coverage additions:

- `researchMode` mapping and overrides.
- Exa request aggregation/deduping for `full` mode.
- `queryFile`/`contextFiles`/`contextGlob` path handling.
- Report renderer headings, clean raw sidecar behavior.
- HTML Readability extraction with fixture.
- Jina fallback with mocked HTTP.
- PDF fixture extraction.
- GitHub URL parser and mocked clone/API flow.
- Provider fallback order.

### Skill script tests

```bash
node --test skills/deep-research/tests/*.test.*
```

Add tests for:

- `--mode lite|standard|full`.
- `--query-file` + repeated `--context`.
- `--raw-output` default/explicit behavior.
- `op://` secret failure and success.
- Mocked multi-call full research aggregation.

### CLI/vstack validation

```bash
cd cli
cargo test
TMP=$(mktemp -d)
( cd "$TMP" && /path/to/vstack add /path/to/source --all -y --copy )
```

Verify:

- `pi-web-tools` is discovered.
- `researcher` agent is generated for all harnesses.
- `deep-research` skill is installed.
- `pi-codex-minimal-tools` no longer contributes `web_search`.

### Live opt-in tests

Only run with user-provided API keys and explicit approval:

```bash
EXA_API_KEY=... .agents/skills/deep-research/scripts/deep-research report \
  --mode lite \
  --query-file docs/research/example/prompt.txt \
  --context docs/research/example/context.md \
  --output tmp/deep-research-live.md \
  --raw-output tmp/deep-research-live.raw.json
```

Pi live test:

```text
/web-tools doctor
Use web_research with queryFile @docs/research/.../prompt.txt and contextGlob @docs/research/.../context-*.md. Use mode standard. Write findings to tmp/findings.md and raw metadata to tmp/findings.raw.json.
```

Acceptance:

- Findings are readable and source-backed.
- Raw metadata sidecar exists.
- Tool output is compact.
- No secrets are written to repo files.

## 5. Migration/cleanup notes

- Keep old `pi-codex-minimal-tools.webSearch*` settings ignored; do not crash if present.
- Keep compatibility aliases off by default.
- Do not commit project-local `.pi/packages/` test installs.
- Do not commit live smoke outputs under `tmp/` unless intentionally adding fixtures.
- Remove or de-prioritize curator settings/docs if they distract from Exa-only deep research.
- Browser-cookie/Gemini Web features must remain opt-in.

## 6. Suggested next implementation order

1. Add `researchMode` and clean sidecar-first report renderer.
2. Add `queryFile`/`contextFiles`/`contextGlob` to Pi `web_research` and align script behavior.
3. Update `research-issue.md` run command to use mode/profile/raw sidecar.
4. Implement HTML `web_fetch` extraction with Readability + Jina fallback.
5. Implement GitHub URL parsing/extraction.
6. Implement PDF extraction.
7. Reassess Perplexity/Gemini/video support only after core research/source ingestion is solid.
