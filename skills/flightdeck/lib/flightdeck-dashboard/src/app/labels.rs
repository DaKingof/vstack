use crate::state::snapshot::{SessionKind, SessionState};

#[must_use]
pub fn state_label(state: &str) -> &str {
    match state {
        "prompting" => "Needs input",
        "submitting" => "Submitting",
        "waiting" => "Running",
        "ready" => "Idle",
        "merge-ready" => "Ready to merge",
        "complete" => "Completed",
        "merged" => "Merged",
        "cancelled" => "Cancelled",
        "aborted" => "Aborted",
        "dead" => "Stopped",
        other => other,
    }
}

#[must_use]
pub fn state_count_badge(state: &SessionState) -> &'static str {
    match state {
        SessionState::Prompting => "P",
        SessionState::Submitting => "S",
        SessionState::Waiting => "W",
        SessionState::Ready => "R",
        SessionState::MergeReady => "MR",
        SessionState::Complete => "C",
        SessionState::Merged => "M",
        SessionState::Cancelled => "CA",
        SessionState::Aborted => "AB",
        SessionState::Dead => "D",
        SessionState::Other(_) => "??",
    }
}

#[must_use]
pub fn state_label_for(state: &SessionState) -> &str {
    state_label(state.as_str())
}

#[must_use]
pub fn kind_label(kind: &str) -> &str {
    match kind {
        "adhoc" => "Adhoc",
        "issue" => "Issue",
        "workflow" => "Workflow",
        other => other,
    }
}

#[must_use]
pub fn kind_label_for(kind: &SessionKind) -> &str {
    kind_label(kind.as_str())
}

#[must_use]
pub const fn kind_badge(kind: &SessionKind) -> &'static str {
    match kind {
        SessionKind::Adhoc => "AH",
        SessionKind::Issue => "ISS",
        SessionKind::Workflow => "WF",
        SessionKind::Other(_) => "??",
    }
}
