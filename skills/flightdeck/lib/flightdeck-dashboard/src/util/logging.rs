use std::env;
use std::path::PathBuf;

use color_eyre::eyre::{eyre, Result};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::fmt::writer::BoxMakeWriter;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

const DEFAULT_FILTER: &str = "flightdeck_dashboard=info,flightdeck_dashboard::app=info";

pub fn init_file_logging() -> Result<Option<WorkerGuard>> {
    let Some(log_dir) = prepare_log_dir() else {
        eprintln!(
            "Warning: flightdeck-dashboard file logging disabled; no writable state directory found"
        );
        return Ok(None);
    };

    let appender = tracing_appender::rolling::daily(log_dir, "flightdeck-dashboard.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = env_filter();
    let subscriber = tracing_subscriber::registry().with(filter).with(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(BoxMakeWriter::new(writer)),
    );
    tracing::subscriber::set_global_default(subscriber)
        .map_err(|_| eyre!("failed to install tracing subscriber"))?;
    Ok(Some(guard))
}

fn env_filter() -> EnvFilter {
    match env::var("RUST_LOG") {
        Ok(value) => match EnvFilter::try_new(value) {
            Ok(filter) => filter,
            Err(error) => {
                eprintln!(
                    "Warning: invalid RUST_LOG for flightdeck-dashboard ({error}); using {DEFAULT_FILTER}"
                );
                EnvFilter::new(DEFAULT_FILTER)
            }
        },
        Err(env::VarError::NotPresent) => EnvFilter::new(DEFAULT_FILTER),
        Err(env::VarError::NotUnicode(_)) => {
            eprintln!(
                "Warning: invalid non-unicode RUST_LOG for flightdeck-dashboard; using {DEFAULT_FILTER}"
            );
            EnvFilter::new(DEFAULT_FILTER)
        }
    }
}

fn prepare_log_dir() -> Option<PathBuf> {
    log_dir_candidates()
        .into_iter()
        .find(|candidate| create_private_dir(candidate).is_ok())
}

fn log_dir_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::with_capacity(3);
    if let Some(dir) = env_path("XDG_STATE_HOME") {
        candidates.push(dir.join("flightdeck"));
    }
    if let Some(dir) = env_path("XDG_RUNTIME_DIR") {
        candidates.push(dir.join("flightdeck"));
    }
    if let Some(home) = env_path("HOME") {
        candidates.push(home.join(".local/state/flightdeck"));
    }
    candidates
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name).and_then(|value| {
        if value.is_empty() {
            None
        } else {
            Some(PathBuf::from(value))
        }
    })
}

#[cfg(unix)]
fn create_private_dir(path: &PathBuf) -> std::io::Result<()> {
    use std::fs::DirBuilder;
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    let mut builder = DirBuilder::new();
    builder.recursive(true).mode(0o700).create(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn create_private_dir(path: &PathBuf) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}
