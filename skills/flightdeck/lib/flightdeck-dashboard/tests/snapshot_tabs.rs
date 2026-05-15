mod common;

use flightdeck_dashboard::app::model::{ModalState, Tab};

#[test]
fn mixed_overview_tab() {
    insta::assert_snapshot!(
        "tab_overview",
        common::render_model(&common::model_for_tab(Tab::Overview))
    );
}

#[test]
fn mixed_live_feed_tab() {
    insta::assert_snapshot!(
        "tab_live_feed",
        common::render_model(&common::model_for_tab(Tab::LiveFeed))
    );
}

#[test]
fn mixed_conversations_tab() {
    insta::assert_snapshot!(
        "tab_conversations",
        common::render_model(&common::model_for_tab(Tab::Conversations))
    );
}

#[test]
fn mixed_merges_tab() {
    insta::assert_snapshot!(
        "tab_merges",
        common::render_model(&common::model_for_tab(Tab::Merges))
    );
}

#[test]
fn mixed_decisions_tab() {
    insta::assert_snapshot!(
        "tab_decisions",
        common::render_model(&common::model_for_tab(Tab::Decisions))
    );
}

#[test]
fn mixed_daemon_tab() {
    insta::assert_snapshot!(
        "tab_daemon",
        common::render_model(&common::model_for_tab(Tab::Daemon))
    );
}

#[test]
fn help_overlay() {
    let mut model = common::model_for_tab(Tab::Overview);
    model.show_help = true;
    model.modal = ModalState::Help;
    insta::assert_snapshot!("help_overlay", common::render_model(&model));
}
