use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "flightdeck-dashboard")]
#[command(about = "Standalone terminal dashboard for Flightdeck sessions")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Render the dashboard TUI.
    Tui(TuiArgs),
    /// Start the future dashboard daemon.
    Daemon(StubArgs),
    /// Print future dashboard daemon status.
    Status(StubArgs),
    /// Back-compat alias for future daemon supervision.
    Supervise(StubArgs),
    /// Launch the dashboard window from Flightdeck startup.
    Launch(StubArgs),
}

#[derive(Debug, Args)]
pub struct TuiArgs {
    /// Render a compiled-in demo fixture. Optional NAME defaults to mixed.
    #[arg(long, value_name = "NAME", num_args = 0..=1, default_missing_value = "mixed")]
    pub demo: Option<String>,
    /// Read a concrete Flightdeck master-state JSON file.
    #[arg(long, value_name = "PATH")]
    pub state_file: Option<PathBuf>,
    /// Read state for a Flightdeck tmux session.
    #[arg(long, value_name = "NAME")]
    pub session: Option<String>,
}

#[derive(Debug, Args)]
pub struct StubArgs {}

impl TuiArgs {
    #[must_use]
    pub fn demo_name(&self) -> &str {
        self.demo.as_deref().unwrap_or("mixed")
    }

    #[must_use]
    pub fn wants_live_state(&self) -> bool {
        self.state_file.is_some() || self.session.is_some() || std::env::var_os("TMUX").is_some()
    }
}
