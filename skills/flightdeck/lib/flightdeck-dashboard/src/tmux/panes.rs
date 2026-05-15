use std::collections::HashSet;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const DEFAULT_TMUX_PROBE_TTL_SECS: u64 = 5;
const TMUX_PROBE_TTL_ENV: &str = "TMUX_PROBE_TTL";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PaneSnapshot {
    panes: HashSet<String>,
    pub loaded: bool,
    pub error: Option<String>,
}

impl PaneSnapshot {
    #[must_use]
    pub fn contains(&self, pane_id: &str) -> bool {
        self.panes.contains(pane_id)
    }

    #[must_use]
    pub const fn is_loaded(&self) -> bool {
        self.loaded && self.error.is_none()
    }

    #[must_use]
    pub fn from_panes(panes: impl IntoIterator<Item = String>) -> Self {
        Self {
            panes: panes.into_iter().collect(),
            loaded: true,
            error: None,
        }
    }
}

#[derive(Debug, Clone)]
struct CachedPanes {
    captured_at: Instant,
    snapshot: PaneSnapshot,
}

static CACHE: OnceLock<Mutex<Option<CachedPanes>>> = OnceLock::new();

#[must_use]
pub fn current() -> PaneSnapshot {
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = cache.lock() {
        if let Some(cached) = guard.as_ref() {
            if cached.captured_at.elapsed() <= probe_ttl() {
                return cached.snapshot.clone();
            }
        }
        let snapshot = probe_panes();
        *guard = Some(CachedPanes {
            captured_at: Instant::now(),
            snapshot: snapshot.clone(),
        });
        snapshot
    } else {
        probe_panes()
    }
}

pub fn probe_panes() -> PaneSnapshot {
    match Command::new("tmux")
        .args(["list-panes", "-a", "-F", "#{pane_id}"])
        .output()
    {
        Ok(output) if output.status.success() => {
            parse_panes(&String::from_utf8_lossy(&output.stdout))
        }
        Ok(output) => PaneSnapshot {
            panes: HashSet::new(),
            loaded: true,
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_owned()),
        },
        Err(error) => PaneSnapshot {
            panes: HashSet::new(),
            loaded: true,
            error: Some(error.to_string()),
        },
    }
}

#[must_use]
pub fn parse_panes(output: &str) -> PaneSnapshot {
    PaneSnapshot::from_panes(
        output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned),
    )
}

fn probe_ttl() -> Duration {
    let seconds = std::env::var(TMUX_PROBE_TTL_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_TMUX_PROBE_TTL_SECS);
    Duration::from_secs(seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_panes_records_live_ids() {
        let snapshot = parse_panes("%1\n%20\n");
        assert!(snapshot.contains("%1"));
        assert!(snapshot.contains("%20"));
        assert!(!snapshot.contains("%2"));
    }
}
