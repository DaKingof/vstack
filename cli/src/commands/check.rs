use crate::config::{self, LockEntry, LockFile};
use anyhow::Result;

pub fn run() -> Result<()> {
    // Check CLI version
    let local_version = env!("CARGO_PKG_VERSION");
    let local_hash = env!("VSTACK_GIT_HASH");
    eprintln!("vstack {} ({})", local_version, local_hash);

    if let Some(remote_version) = crate::commands::update::get_remote_version() {
        if remote_version != local_version {
            eprintln!(
                "  CLI update available: {} → {}  (run: vstack update)",
                local_version, remote_version
            );
        } else {
            eprintln!("  CLI is up to date.");
        }
    }

    // Check installed items
    for global in [false, true] {
        let lock_path = config::lock_file_path(global);
        let lock = LockFile::load(&lock_path)?;

        let scope = if global { "global" } else { "project" };

        // Scan disk for skills that should be in the lock but aren't
        let disk_skills = config::scan_installed_skills_on_disk(global);
        let lock_names: std::collections::HashSet<&str> =
            lock.entries.keys().map(|s| s.as_str()).collect();
        let orphaned: Vec<&str> = disk_skills
            .iter()
            .filter(|d| !lock_names.contains(d.name.as_str()))
            .map(|d| d.name.as_str())
            .collect();

        // Check for lock entries whose files are missing from disk
        let disk_skill_names: std::collections::HashSet<&str> =
            disk_skills.iter().map(|d| d.name.as_str()).collect();
        let phantom: Vec<&str> = lock
            .entries
            .iter()
            .filter(|(_, e)| {
                e.kind == config::ItemKind::Skill && !disk_skill_names.contains(e.name.as_str())
            })
            .filter(|(_, e)| {
                // Only report if the canonical dir is truly gone
                let canonical = if global {
                    config::global_state_dir().join("skills").join(&e.name)
                } else {
                    config::project_root()
                        .join(".agents")
                        .join("skills")
                        .join(&e.name)
                };
                !canonical.exists()
            })
            .map(|(name, _)| name.as_str())
            .collect();

        if lock.entries.is_empty() && orphaned.is_empty() {
            continue;
        }

        eprintln!("\n{scope} scope: {} item(s)", lock.entries.len());

        let mut outdated = 0;
        for entry in lock.entries.values() {
            let status = check_staleness(entry);
            if status == "outdated" {
                outdated += 1;
            }
            let icon = match status {
                "ok" => "✓",
                "outdated" => "!",
                _ => "?",
            };
            eprintln!(
                "  {icon} {} ({}){}",
                entry.name,
                entry.kind,
                if status == "outdated" {
                    "  ← outdated"
                } else {
                    ""
                }
            );
        }

        if outdated > 0 {
            eprintln!("\n  {outdated} outdated — run `vstack add` to update");
        }

        if !orphaned.is_empty() {
            eprintln!(
                "\n  {} installed on disk but missing from lock:",
                orphaned.len()
            );
            for name in &orphaned {
                eprintln!("    ? {name} (skill)");
            }
            eprintln!("  Run `vstack add` to recover these entries.");
        }

        if !phantom.is_empty() {
            eprintln!(
                "\n  {} in lock but missing from disk:",
                phantom.len()
            );
            for name in &phantom {
                eprintln!("    ✗ {name} (skill)");
            }
            eprintln!("  Run `vstack add` to clean up, or `vstack remove` to remove.");
        }
    }

    Ok(())
}

fn check_staleness(entry: &LockEntry) -> &'static str {
    if config::is_source_changed(entry) {
        "outdated"
    } else {
        "ok"
    }
}
