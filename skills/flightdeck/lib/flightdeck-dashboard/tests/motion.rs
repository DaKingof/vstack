mod common;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use flightdeck_dashboard::app::model::MotionLevel;
use flightdeck_dashboard::app::msg::Msg;
use flightdeck_dashboard::app::update;
use flightdeck_dashboard::app::view::fx;

#[test]
fn repeated_tab_motion_stays_bounded() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Full);
    for _ in 0..100 {
        let commands = update(
            &mut model,
            Msg::KeyPressed(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)),
        );
        assert!(!commands.is_empty());
    }

    assert!(model.active_effects.len() <= fx::MAX_ACTIVE_EFFECTS);
}
