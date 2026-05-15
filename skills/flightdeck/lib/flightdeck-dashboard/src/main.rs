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
use flightdeck_dashboard::app::model::{utc_now, Model, MotionLevel};
use flightdeck_dashboard::app::view::fx;
use flightdeck_dashboard::app::{update, view};
use flightdeck_dashboard::cli::{Cli, Command};
use flightdeck_dashboard::fixtures;
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
        Command::Tui(args) => run_tui(args.demo_name()).await,
        Command::Daemon(_) => not_implemented("daemon"),
        Command::Status(_) => not_implemented("status"),
        Command::Supervise(_) => not_implemented("supervise"),
        Command::Launch(_) => not_implemented("launch"),
    }
}

async fn run_tui(demo_name: &str) -> Result<()> {
    let demo_name = fixtures::canonical_name(demo_name)?;
    let snapshot = fixtures::load_demo_snapshot(demo_name, utc_now())?;
    let source = SnapshotSource::Demo(demo_name);
    let mut model = Model::new(snapshot, source, MotionLevel::from_env(), utc_now);
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        tracing::info!(
            demo = demo_name,
            "non-terminal dashboard smoke render skipped"
        );
        return Ok(());
    }

    let mut terminal = TerminalGuard::enter()?;
    run_app_loop(terminal.terminal_mut()?, &mut model).await
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
            _ = anim.tick(), if fx::has_active_effects(model) => {
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
