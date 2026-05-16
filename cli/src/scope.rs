//! CLI scope selection: project, global, or both.
//!
//! Commands that operate on lock files take a `--scope project|global|all`
//! flag. The legacy `--global`/`-g` flag is kept as a shorthand for
//! `--scope global`. When both are passed and disagree, `--scope` wins.

use anyhow::{Result, anyhow};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeFilter {
    Project,
    Global,
    All,
}

impl ScopeFilter {
    /// Resolve the scope from clap inputs.
    ///
    /// `--scope` takes priority over `--global`. If neither is set, returns
    /// the supplied default (typically `All` for read-only commands and
    /// `Project` for destructive ones).
    pub fn resolve(scope: Option<&str>, global_flag: bool, default: ScopeFilter) -> Result<Self> {
        if let Some(s) = scope {
            return parse(s);
        }
        if global_flag {
            return Ok(ScopeFilter::Global);
        }
        Ok(default)
    }

    /// Iterate the boolean `global` values this filter selects.
    /// `Project` → `[false]`, `Global` → `[true]`, `All` → `[false, true]`.
    pub fn globals(&self) -> &'static [bool] {
        match self {
            ScopeFilter::Project => &[false],
            ScopeFilter::Global => &[true],
            ScopeFilter::All => &[false, true],
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            ScopeFilter::Project => "project",
            ScopeFilter::Global => "global",
            ScopeFilter::All => "all",
        }
    }
}

fn parse(s: &str) -> Result<ScopeFilter> {
    match s.trim().to_ascii_lowercase().as_str() {
        "project" | "p" | "local" => Ok(ScopeFilter::Project),
        "global" | "g" | "user" => Ok(ScopeFilter::Global),
        "all" | "both" | "*" => Ok(ScopeFilter::All),
        other => Err(anyhow!(
            "unknown scope '{other}': expected project | global | all"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_scope_flag() {
        assert_eq!(
            ScopeFilter::resolve(Some("global"), false, ScopeFilter::All).unwrap(),
            ScopeFilter::Global
        );
        assert_eq!(
            ScopeFilter::resolve(Some("project"), false, ScopeFilter::All).unwrap(),
            ScopeFilter::Project
        );
        assert_eq!(
            ScopeFilter::resolve(Some("all"), false, ScopeFilter::All).unwrap(),
            ScopeFilter::All
        );
    }

    #[test]
    fn scope_flag_wins_over_global_flag() {
        // Conflicting inputs: --scope project --global -> project
        assert_eq!(
            ScopeFilter::resolve(Some("project"), true, ScopeFilter::All).unwrap(),
            ScopeFilter::Project
        );
    }

    #[test]
    fn global_flag_alone_means_global() {
        assert_eq!(
            ScopeFilter::resolve(None, true, ScopeFilter::All).unwrap(),
            ScopeFilter::Global
        );
    }

    #[test]
    fn default_when_neither_set() {
        assert_eq!(
            ScopeFilter::resolve(None, false, ScopeFilter::Project).unwrap(),
            ScopeFilter::Project
        );
        assert_eq!(
            ScopeFilter::resolve(None, false, ScopeFilter::All).unwrap(),
            ScopeFilter::All
        );
    }

    #[test]
    fn rejects_unknown_scope() {
        assert!(ScopeFilter::resolve(Some("xyz"), false, ScopeFilter::All).is_err());
    }

    #[test]
    fn parses_aliases() {
        assert_eq!(parse("p").unwrap(), ScopeFilter::Project);
        assert_eq!(parse("local").unwrap(), ScopeFilter::Project);
        assert_eq!(parse("g").unwrap(), ScopeFilter::Global);
        assert_eq!(parse("user").unwrap(), ScopeFilter::Global);
        assert_eq!(parse("both").unwrap(), ScopeFilter::All);
        assert_eq!(parse("*").unwrap(), ScopeFilter::All);
    }

    #[test]
    fn globals_iter() {
        assert_eq!(ScopeFilter::Project.globals(), &[false]);
        assert_eq!(ScopeFilter::Global.globals(), &[true]);
        assert_eq!(ScopeFilter::All.globals(), &[false, true]);
    }
}
