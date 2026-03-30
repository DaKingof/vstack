---
title: Cold Function Annotation
impact: HIGH
impactDescription: Error handlers in hot loops pollute I-cache, increasing misses on critical paths
tags: layout, cold, icache, branch-weight, hot-path
---

## Cold Function Annotation

**Impact: HIGH (error handlers in hot loops pollute I-cache, increasing misses on critical paths)**

Mark error/rejection/diagnostic functions in hot-path-adjacent code with `#[cold]` to keep them out of hot I-cache regions.

**When to apply**:
- Error handlers called from hot loops
- Rejection paths in high-frequency validation or processing
- Diagnostic/trace functions that execute only on anomalies

**When NOT to apply**:
- `#[cfg]`-gated paths — already compiled out in production, `#[cold]` has no effect
- Functions called frequently (even if they handle "errors" that occur often)
- Functions already in cold modules with no hot-path callers

**LLVM semantics**: `#[cold]` maps to LLVM's `cold` attribute, which influences branch weighting — blocks post-dominated by cold calls get low weight, moving them out of hot I-cache regions.

**Incorrect (error handler inlined into hot loop):**

```rust
fn process_tick(tick: &Tick) -> Result<(), Error> {
    if !tick.is_valid() {
        // This error path is rarely taken but LLVM may inline it,
        // polluting the I-cache for the hot path
        return Err(build_validation_error(tick));
    }
    // hot path...
    Ok(())
}
```

**Correct (cold annotation moves error path out of hot I-cache):**

```rust
fn process_tick(tick: &Tick) -> Result<(), Error> {
    if !tick.is_valid() {
        return Err(handle_invalid(tick));
    }
    // hot path...
    Ok(())
}

#[cold]
fn handle_invalid(tick: &Tick) -> Error {
    build_validation_error(tick)
}
```

**Verification**: `perf stat -e L1-icache-load-misses` before/after on affected benchmark.
