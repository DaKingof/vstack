mod common;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use flightdeck_dashboard::app::model::{ModalState, Tab};
use flightdeck_dashboard::app::motion::MotionLevel;
use flightdeck_dashboard::app::msg::Msg;
use flightdeck_dashboard::app::theme::Theme;
use flightdeck_dashboard::app::update;

#[test]
fn theme_picker_jk_cycles_selection_does_not_touch_base() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    let base_selection = model.selection.clone();
    let base_tab = model.current_tab;
    model.modal = ModalState::ThemePicker;
    model.theme_picker_index = model.theme.index();

    update(&mut model, Msg::KeyPressed(key(KeyCode::Char('j'))));

    assert_eq!(model.theme_picker_index, Theme::Dawn.index());
    assert_eq!(model.selection, base_selection);
    assert_eq!(model.current_tab, base_tab);
}

#[test]
fn theme_picker_enter_applies_and_closes() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    model.modal = ModalState::ThemePicker;
    model.theme_picker_index = Theme::Pantera.index();

    update(&mut model, Msg::KeyPressed(key(KeyCode::Enter)));

    assert_eq!(model.theme, Theme::Pantera);
    assert_eq!(model.modal, ModalState::None);
}

#[test]
fn theme_picker_esc_closes_without_applying() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    model.theme = Theme::Moon;
    model.modal = ModalState::ThemePicker;
    model.theme_picker_index = Theme::Pantera.index();

    update(&mut model, Msg::KeyPressed(key(KeyCode::Esc)));

    assert_eq!(model.theme, Theme::Moon);
    assert_eq!(model.modal, ModalState::None);
}

#[test]
fn help_overlay_any_navigation_key_is_noop() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    model.modal = ModalState::Help;
    model.show_help = true;
    let base_selection = model.selection.clone();
    let base_tab = model.current_tab;

    for code in [
        KeyCode::Char('j'),
        KeyCode::Char('k'),
        KeyCode::Up,
        KeyCode::Down,
        KeyCode::Enter,
        KeyCode::Tab,
    ] {
        update(&mut model, Msg::KeyPressed(key(code)));
        assert_eq!(model.selection, base_selection);
        assert_eq!(model.current_tab, base_tab);
        assert_eq!(model.modal, ModalState::Help);
    }
}

#[test]
fn decision_detail_scrolls_body_does_not_touch_decisions_table() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    model.current_tab = Tab::Decisions;
    model.set_selected_index(1);
    let selected = model.selected_index();
    model.modal = ModalState::DecisionDetail;

    update(&mut model, Msg::KeyPressed(key(KeyCode::Down)));

    assert_eq!(model.popup_scroll, 1);
    assert_eq!(model.selected_index(), selected);
}

#[test]
fn filter_input_typing_updates_input_does_not_filter_yet() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    model.feed_filter.begin_edit();
    model.feed_filter.input.clear();
    model.ui.filter_open = true;
    model.modal = ModalState::FilterInput;

    type_filter(&mut model, "ht-");

    assert_eq!(model.feed_filter.input, "ht-");
    assert!(model.feed_filter.pattern.is_empty());
    update(&mut model, Msg::KeyPressed(key(KeyCode::Esc)));
    assert!(model.feed_filter.pattern.is_empty());
    assert_eq!(model.modal, ModalState::None);
}

#[test]
fn filter_input_enter_applies_filter_and_closes() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    model.feed_filter.begin_edit();
    model.feed_filter.input.clear();
    model.ui.filter_open = true;
    model.modal = ModalState::FilterInput;

    type_filter(&mut model, "ht-");
    update(&mut model, Msg::KeyPressed(key(KeyCode::Enter)));

    assert_eq!(model.feed_filter.pattern, "ht-");
    assert_eq!(model.modal, ModalState::None);
    assert!(!model.ui.filter_open);
}

fn type_filter(model: &mut flightdeck_dashboard::app::model::Model, value: &str) {
    for ch in value.chars() {
        update(model, Msg::KeyPressed(key(KeyCode::Char(ch))));
    }
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::empty())
}
