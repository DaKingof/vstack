mod common;

use flightdeck_dashboard::app::model::{MotionLevel, Tab};
use flightdeck_dashboard::app::view::fx;

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
fn motion_effects_overview_start_and_settled() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Full);
    model.current_tab = Tab::Overview;
    insta::assert_snapshot!("overview_motion_t0", common::render_model(&model));
    model.animate_frame = 8;
    fx::prune_effects(&mut model);
    insta::assert_snapshot!("overview_motion_settled", common::render_model(&model));
}
