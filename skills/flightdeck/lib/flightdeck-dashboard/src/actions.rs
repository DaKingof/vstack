use std::path::PathBuf;

use tokio::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteAction {
    PruneStaleEntry { entry_id: String },
    FocusWindow { pane_target: String },
}

impl WriteAction {
    #[must_use]
    pub fn success_message(&self) -> String {
        match self {
            Self::PruneStaleEntry { entry_id } => format!("Pruned {entry_id}"),
            Self::FocusWindow { pane_target } => format!("Focused {pane_target}"),
        }
    }
}

pub async fn run(action: WriteAction) -> Result<String, String> {
    let success = action.success_message();
    let output = match &action {
        WriteAction::PruneStaleEntry { entry_id } => {
            let mut command = Command::new(pane_registry_bin());
            command.args(["remove", entry_id]);
            command.output().await
        }
        WriteAction::FocusWindow { pane_target } => {
            let mut command = Command::new("tmux");
            command.args(["select-window", "-t", pane_target]);
            command.output().await
        }
    }
    .map_err(|error| error.to_string())?;

    if output.status.success() {
        return Ok(success);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

#[must_use]
pub fn pane_registry_args(entry_id: &str) -> Vec<String> {
    vec![String::from("remove"), entry_id.to_owned()]
}

#[must_use]
pub fn focus_args(pane_target: &str) -> Vec<String> {
    vec![
        String::from("select-window"),
        String::from("-t"),
        pane_target.to_owned(),
    ]
}

fn pane_registry_bin() -> PathBuf {
    std::env::var("FLIGHTDECK_SKILL_DIR")
        .ok()
        .map(|skill_dir| PathBuf::from(skill_dir).join("scripts/pane-registry"))
        .unwrap_or_else(|| PathBuf::from("pane-registry"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_stale_entry_builds_registry_remove_args() {
        assert_eq!(pane_registry_args("HT-9000"), ["remove", "HT-9000"]);
    }

    #[test]
    fn focus_window_builds_tmux_select_args() {
        assert_eq!(focus_args("VS:3.1"), ["select-window", "-t", "VS:3.1"]);
    }
}
