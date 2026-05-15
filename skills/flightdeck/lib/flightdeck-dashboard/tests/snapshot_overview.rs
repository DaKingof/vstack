mod common;

use std::path::PathBuf;

use flightdeck_dashboard::app::command::SnapshotSource;
use flightdeck_dashboard::app::model::{Model, Tab};
use flightdeck_dashboard::app::motion::{self, MotionLevel};
use flightdeck_dashboard::state::snapshot::DashboardSnapshot;
use flightdeck_dashboard::state::tracked_entries::{PRE_PURGE_BANNER, PRE_PURGE_STATE_MESSAGE};

fn render_fixture(name: &'static str) -> String {
    common::render_model(&common::model_for_fixture(name, MotionLevel::Off))
}

#[test]
fn empty_fixture_overview() {
    insta::assert_snapshot!("overview_empty", render_fixture("empty"));
}

#[test]
fn one_adhoc_fixture_overview() {
    insta::assert_snapshot!("overview_one_adhoc", render_fixture("one-adhoc"));
}

#[test]
fn one_issue_fixture_overview() {
    insta::assert_snapshot!("overview_one_issue", render_fixture("one-issue"));
}

#[test]
fn mixed_fixture_overview() {
    insta::assert_snapshot!("overview_mixed", render_fixture("mixed"));
}

#[test]
fn terminated_fixture_overview() {
    insta::assert_snapshot!("overview_terminated", render_fixture("terminated"));
}

#[test]
fn paused_fixture_overview() {
    insta::assert_snapshot!("overview_paused", render_fixture("paused"));
}

#[test]
fn pre_purge_banner() {
    let snapshot = DashboardSnapshot::empty_with_error(
        "HT",
        PathBuf::from("tmp/flightdeck-state-HT.json"),
        common::fixed_now(),
        PRE_PURGE_STATE_MESSAGE,
        true,
    );
    let model = Model::new(
        snapshot,
        SnapshotSource::File(PathBuf::from("tmp/flightdeck-state-HT.json")),
        MotionLevel::Off,
        common::fixed_now,
    );
    let rendered = common::render_model(&model);
    assert!(rendered.contains(PRE_PURGE_BANNER));
    insta::assert_snapshot!("overview_pre_purge_banner", rendered);
}

#[test]
fn motion_effects_overview_start_and_settled() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Full);
    model.current_tab = Tab::Overview;
    insta::assert_snapshot!("overview_motion_t0", common::render_model(&model));
    model.animate_frame = 8;
    motion::prune_effects(&mut model.active_effects, model.animate_frame);
    insta::assert_snapshot!("overview_motion_settled", common::render_model(&model));
}
