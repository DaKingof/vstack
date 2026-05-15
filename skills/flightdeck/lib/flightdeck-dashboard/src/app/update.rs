use super::command::Cmd;
use super::keymap::{self, Action};
use super::model::{ModalState, Model};
use super::msg::Msg;
use super::view::fx::{self, EffectKind, EffectTarget};

const PAGE_STEP: usize = 10;

pub fn update(model: &mut Model, msg: Msg) -> Vec<Cmd> {
    match msg {
        Msg::Tick => {
            model.refresh_now();
            vec![Cmd::Render]
        }
        Msg::AnimateTick => {
            model.animate_frame = model.animate_frame.saturating_add(1);
            fx::prune_effects(model);
            vec![Cmd::Render]
        }
        Msg::KeyPressed(key) => handle_key(model, &key),
        Msg::Resize(_, _) => vec![Cmd::Render],
        Msg::SnapshotUpdated(snapshot) => {
            model.snapshot = *snapshot;
            model.refresh_now();
            model.clamp_selection();
            vec![Cmd::Render]
        }
        Msg::Error(error) => {
            model.error = Some(error);
            fx::push_effect(model, EffectKind::ErrorFlash, EffectTarget::Global);
            vec![Cmd::Render]
        }
        Msg::Quit => {
            model.quit_requested = true;
            vec![Cmd::Render]
        }
    }
}

fn handle_key(model: &mut Model, key: &crossterm::event::KeyEvent) -> Vec<Cmd> {
    let Some(action) = keymap::action_for(key) else {
        return Vec::new();
    };

    if model.show_help
        && !matches!(
            action,
            Action::ToggleHelp | Action::Quit | Action::CloseModal
        )
    {
        return Vec::new();
    }

    match action {
        Action::NextTab => {
            model.current_tab = model.current_tab.next();
            let target = EffectTarget::Tab(model.current_tab);
            fx::push_effect(model, EffectKind::TabSwitchForward, target);
            vec![Cmd::Render]
        }
        Action::PreviousTab => {
            model.current_tab = model.current_tab.previous();
            let target = EffectTarget::Tab(model.current_tab);
            fx::push_effect(model, EffectKind::TabSwitchBackward, target);
            vec![Cmd::Render]
        }
        Action::MoveDown => {
            move_selection(model, 1);
            vec![Cmd::Render]
        }
        Action::MoveUp => {
            move_selection(model, -1);
            vec![Cmd::Render]
        }
        Action::PageDown => {
            move_selection(model, PAGE_STEP as isize);
            vec![Cmd::Render]
        }
        Action::PageUp => {
            move_selection(model, -(PAGE_STEP as isize));
            vec![Cmd::Render]
        }
        Action::First => {
            model.set_selected_index(0);
            let target = EffectTarget::Row(model.selected_index());
            fx::push_effect(model, EffectKind::SelectionHalo, target);
            vec![Cmd::Render]
        }
        Action::Last => {
            model.set_selected_index(model.max_selection_index());
            let target = EffectTarget::Row(model.selected_index());
            fx::push_effect(model, EffectKind::SelectionHalo, target);
            vec![Cmd::Render]
        }
        Action::OpenDetail => vec![Cmd::LogAction(format!(
            "detail requested for tab={} row={}",
            model.current_tab.label(),
            model.selected_index()
        ))],
        Action::OpenFilter => {
            model.ui.filter_open = true;
            vec![
                Cmd::LogAction(String::from("filter input opened")),
                Cmd::Render,
            ]
        }
        Action::Reload => vec![Cmd::RequestSnapshot(model.snapshot_source.clone())],
        Action::ToggleCompact => {
            model.ui.compact = !model.ui.compact;
            vec![Cmd::Render]
        }
        Action::ToggleHelp => {
            model.show_help = !model.show_help;
            model.modal = if model.show_help {
                ModalState::Help
            } else {
                ModalState::None
            };
            fx::push_effect(model, EffectKind::HelpOverlay, EffectTarget::Global);
            vec![Cmd::Render]
        }
        Action::Quit => {
            model.quit_requested = true;
            vec![Cmd::Render]
        }
        Action::CloseModal => {
            model.show_help = false;
            model.modal = ModalState::None;
            model.ui.filter_open = false;
            vec![Cmd::Render]
        }
    }
}

fn move_selection(model: &mut Model, delta: isize) {
    let current = model.selected_index();
    let next = current
        .saturating_add_signed(delta)
        .min(model.max_selection_index());
    model.set_selected_index(next);
    let target = EffectTarget::Row(model.selected_index());
    fx::push_effect(model, EffectKind::SelectionHalo, target);
}
