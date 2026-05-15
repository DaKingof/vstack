use std::io::{self, IsTerminal, Stdout};
use std::time::Duration;

use clap::Parser;
use color_eyre::eyre::{eyre, Result};
use crossterm::cursor::Show;
use crossterm::event::{DisableMouseCapture, EnableMouseCapture, Event, EventStream, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use flightdeck_dashboard::app::command::SnapshotSource;
use flightdeck_dashboard::app::effects::Effects;
use flightdeck_dashboard::app::model::{utc_now, Model};
use flightdeck_dashboard::app::motion::{self, MotionLevel};
use flightdeck_dashboard::app::{update, view};
use flightdeck_dashboard::cli::{Cli, Command, TuiArgs};
use flightdeck_dashboard::fixtures;
use flightdeck_dashboard::state::snapshot::DashboardSnapshot;
use flightdeck_dashboard::state::tracked_entries::{self, ArchiveError, SnapshotError};
use flightdeck_dashboard::util::logging;
use futures::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;

const ANIMATION_TICK_MS: u64 = 80;
const CLOCK_TICK_MS: u64 = 1_000;

#[tokio::main]
async fn main() -> Result<()> {
    color_eyre::install()?;
    let _log_guard = logging::init_file_logging()?;
    let cli = Cli::parse();
    match cli.command {
        Command::Tui(args) => run_tui(args).await,
        Command::Daemon(_) => not_implemented("daemon"),
        Command::Status(_) => not_implemented("status"),
        Command::Supervise(_) => not_implemented("supervise"),
        Command::Launch(_) => not_implemented("launch"),
    }
}

async fn run_tui(args: TuiArgs) -> Result<()> {
    let initial = initial_snapshot(&args)?;
    let mut model = Model::new(
        initial.snapshot,
        initial.source,
        MotionLevel::from_env(),
        utc_now,
    );
    if let Some(error) = initial.status_error {
        model.error = Some(error);
    }
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        tracing::info!(
            source = ?model.snapshot_source,
            entries = model.snapshot.sessions.len(),
            "non-terminal dashboard smoke render skipped"
        );
        return Ok(());
    }

    let mut terminal = TerminalGuard::enter()?;
    run_app_loop(terminal.terminal_mut()?, &mut model).await
}

struct InitialSnapshot {
    snapshot: DashboardSnapshot,
    source: SnapshotSource,
    status_error: Option<String>,
}

fn initial_snapshot(args: &TuiArgs) -> Result<InitialSnapshot> {
    let now = utc_now();
    if let Some(path) = &args.state_file {
        return Ok(match tracked_entries::snapshot_from_file(path, now) {
            Ok(snapshot) => InitialSnapshot {
                snapshot,
                source: SnapshotSource::File(path.clone()),
                status_error: None,
            },
            Err(SnapshotError::PrePurgeState) => InitialSnapshot {
                snapshot: tracked_entries::snapshot_for_error_path(
                    path,
                    now,
                    SnapshotError::PrePurgeState.to_string(),
                    true,
                ),
                source: SnapshotSource::File(path.clone()),
                status_error: None,
            },
            Err(error) => return Err(error.into()),
        });
    }

    if args.demo.is_some() || !args.wants_live_state() {
        let demo_name = fixtures::canonical_name(args.demo_name())?;
        let snapshot = fixtures::load_demo_snapshot(demo_name, now)?;
        return Ok(InitialSnapshot {
            snapshot,
            source: SnapshotSource::Demo(demo_name),
            status_error: None,
        });
    }

    let resolution = tracked_entries::resolve_session_state(args.session.as_deref())?;
    let source = SnapshotSource::Session(resolution.clone());
    match tracked_entries::read_session_snapshot(&resolution, now) {
        Ok(snapshot) => Ok(InitialSnapshot {
            snapshot,
            source,
            status_error: None,
        }),
        Err(SnapshotError::PrePurgeState) => Ok(InitialSnapshot {
            snapshot: tracked_entries::snapshot_for_error(
                &resolution.session,
                resolution.state_path.clone(),
                now,
                SnapshotError::PrePurgeState.to_string(),
                true,
            ),
            source,
            status_error: None,
        }),
        Err(SnapshotError::Archive(ArchiveError::NoArchives { .. })) => Ok(InitialSnapshot {
            snapshot: DashboardSnapshot::empty_for_session(
                &resolution.session,
                resolution.state_path.clone(),
                now,
            ),
            source,
            status_error: None,
        }),
        Err(error) => Ok(InitialSnapshot {
            snapshot: tracked_entries::snapshot_for_error(
                &resolution.session,
                resolution.state_path.clone(),
                now,
                error.to_string(),
                false,
            ),
            source,
            status_error: Some(error.to_string()),
        }),
    }
}

async fn run_app_loop(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    model: &mut Model,
) -> Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let effects = Effects::new(tx.clone(), model.clock);
    let mut events = EventStream::new();
    let mut anim = tokio::time::interval(Duration::from_millis(ANIMATION_TICK_MS));
    anim.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut clock = tokio::time::interval(Duration::from_millis(CLOCK_TICK_MS));
    clock.set_missed_tick_behavior(MissedTickBehavior::Skip);

    terminal.draw(|frame| view::render(frame, model))?;
    loop {
        tokio::select! {
            biased;
            Some(msg) = rx.recv() => {
                let commands = update(model, msg);
                effects.run_commands(commands);
            }
            maybe_event = events.next() => {
                if let Some(msg) = event_to_msg(maybe_event) {
                    let commands = update(model, msg);
                    effects.run_commands(commands);
                }
            }
            _ = anim.tick(), if motion::has_active_effects(&model.active_effects, model.motion, model.animate_frame, &model.snapshot.sessions) => {
                let commands = update(model, flightdeck_dashboard::app::msg::Msg::AnimateTick);
                effects.run_commands(commands);
            }
            _ = clock.tick() => {
                let commands = update(model, flightdeck_dashboard::app::msg::Msg::Tick);
                effects.run_commands(commands);
            }
            _ = tokio::signal::ctrl_c() => {
                let commands = update(model, flightdeck_dashboard::app::msg::Msg::Quit);
                effects.run_commands(commands);
            }
        }
        terminal.draw(|frame| view::render(frame, model))?;
        if model.quit_requested {
            break;
        }
    }
    Ok(())
}

fn event_to_msg(
    event: Option<std::io::Result<Event>>,
) -> Option<flightdeck_dashboard::app::msg::Msg> {
    match event {
        Some(Ok(Event::Key(key))) if key.kind == KeyEventKind::Press => {
            Some(flightdeck_dashboard::app::msg::Msg::KeyPressed(key))
        }
        Some(Ok(Event::Resize(width, height))) => {
            Some(flightdeck_dashboard::app::msg::Msg::Resize(width, height))
        }
        Some(Ok(_)) | None => None,
        Some(Err(error)) => Some(flightdeck_dashboard::app::msg::Msg::Error(
            error.to_string(),
        )),
    }
}

#[derive(Default)]
struct TerminalGuard {
    terminal: Option<Terminal<CrosstermBackend<Stdout>>>,
    raw_enabled: bool,
    alt_screen: bool,
    mouse_capture: bool,
}

impl TerminalGuard {
    fn enter() -> Result<Self> {
        let mut guard = Self::default();
        if let Err(error) = guard.enter_inner() {
            guard.cleanup();
            return Err(error);
        }
        Ok(guard)
    }

    fn terminal_mut(&mut self) -> Result<&mut Terminal<CrosstermBackend<Stdout>>> {
        self.terminal
            .as_mut()
            .ok_or_else(|| eyre!("terminal not initialized"))
    }

    fn enter_inner(&mut self) -> Result<()> {
        if let Err(error) = enable_raw_mode() {
            return Err(error.into());
        }
        self.raw_enabled = true;

        let mut stdout = io::stdout();
        if let Err(error) = execute!(stdout, EnterAlternateScreen) {
            return Err(error.into());
        }
        self.alt_screen = true;

        if let Err(error) = execute!(stdout, EnableMouseCapture) {
            return Err(error.into());
        }
        self.mouse_capture = true;

        let backend = CrosstermBackend::new(stdout);
        let mut terminal = Terminal::new(backend)?;
        terminal.clear()?;
        self.terminal = Some(terminal);
        Ok(())
    }

    fn cleanup(&mut self) {
        if self.raw_enabled {
            if let Err(error) = disable_raw_mode() {
                tracing::warn!(%error, "failed to disable raw mode");
            }
            self.raw_enabled = false;
        }

        if let Some(terminal) = self.terminal.as_mut() {
            if self.alt_screen {
                if let Err(error) = execute!(terminal.backend_mut(), LeaveAlternateScreen) {
                    tracing::warn!(%error, "failed to leave alternate screen");
                }
                self.alt_screen = false;
            }
            if self.mouse_capture {
                if let Err(error) = execute!(terminal.backend_mut(), DisableMouseCapture) {
                    tracing::warn!(%error, "failed to disable mouse capture");
                }
                self.mouse_capture = false;
            }
            if let Err(error) = execute!(terminal.backend_mut(), Show) {
                tracing::warn!(%error, "failed to show cursor");
            }
        } else {
            let mut stdout = io::stdout();
            if self.alt_screen {
                if let Err(error) = execute!(stdout, LeaveAlternateScreen) {
                    tracing::warn!(%error, "failed to leave alternate screen");
                }
                self.alt_screen = false;
            }
            if self.mouse_capture {
                if let Err(error) = execute!(stdout, DisableMouseCapture) {
                    tracing::warn!(%error, "failed to disable mouse capture");
                }
                self.mouse_capture = false;
            }
            if let Err(error) = execute!(stdout, Show) {
                tracing::warn!(%error, "failed to show cursor");
            }
        }

        self.terminal = None;
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        self.cleanup();
    }
}

fn not_implemented(command: &str) -> Result<()> {
    eprintln!("flightdeck-dashboard {command}: not yet implemented");
    std::process::exit(2);
}
