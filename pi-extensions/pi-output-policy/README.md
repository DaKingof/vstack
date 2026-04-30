# pi-output-policy

OMP-style large-output policy for Pi tool results.

- Preserves full oversized output under `~/.pi/agent/vstack/pi-output-policy/sessions/<session-id>/artifacts/` when possible, never in the project `.pi/` directory.
- Uses head truncation for search/listing tools and tail truncation for command/log tools.
- Leaves file `read` tool results unmodified by default; enable `truncateReadOutputs` to apply head truncation to reads.
- Leaves edit/write tool results and diff details unmodified by default; enable `truncateMutationOutputs` to apply truncation to file mutations.
- Adds explicit truncation notices with size, line, direction, and artifact path details.
- Keeps shell-output minimization disabled by default; enable `shellMinimizer.enabled` to compress noisy command logs.
- Keeps details payload sanitization disabled by default so extension state, subagent details, and diffs are preserved; enable `sanitizeDetails` for stricter UI safety caps.

Limit: Pi's built-in tools may already truncate before `tool_result`; this extension can only preserve the result text it receives. Custom tools that return full large text benefit most from spill preservation.
