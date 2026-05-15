use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use futures::FutureExt;

use crate::actions::{self, WriteAction};
use crate::daemon::rpc::DaemonStatus as RuntimeDaemonStatus;
use crate::state::snapshot::{DaemonStatus as SnapshotDaemonStatus, EventImportance};
use crate::watcher::WatcherEvent;

use super::command::Cmd;
use super::hitmap::{ClickAction, ScrollSource};
use super::keymap::{self, Action};
use super::model::{ActionStatus, ConfirmDialog, ModalState, Model, Tab};
use super::motion::{self, EffectKind, EffectTarget};
use super::msg::Msg;

const PAGE_STEP: usize = 10;

pub fn update(model: &mut Model, msg: Msg) -> Vec<Cmd> {
    match msg {
        Msg::Tick => {
            model.refresh_now();
            vec![Cmd::ProbePanes, Cmd::Render]
        }
        Msg::AnimateTick => {
            model.animate_frame = model.animate_frame.saturating_add(1);
            motion::prune_effects(&mut model.active_effects, model.animate_frame);
            vec![Cmd::Render]
        }
        Msg::KeyPressed(key) => handle_key(model, &key),
        Msg::Click(action) => handle_click(model, action),
        Msg::Resize(_, _) => vec![Cmd::Render],
        Msg::SnapshotUpdated {
            snapshot,
            source_state,
        } => handle_snapshot_updated(model, *snapshot, source_state),
        Msg::EventReceived(event) => {
            let important = event.importance >= EventImportance::Important;
            model.push_event(event);
            push_effect(model, EffectKind::ActivityRowEnter, EffectTarget::Row(0));
            if important {
                push_effect(
                    model,
                    EffectKind::ActivityImportantFlash,
                    EffectTarget::Row(0),
                );
            }
            vec![Cmd::Render]
        }
        Msg::WatcherEvent(WatcherEvent::Reload) => request_reload(model),
        Msg::DaemonStatus(status) => {
            model.snapshot.daemon = daemon_status_chip(&status);
            vec![Cmd::Render]
        }
        Msg::CostUpdated(totals) => {
            if model.cost_totals == totals {
                Vec::new()
            } else {
                model.cost_totals = totals;
                vec![Cmd::Render]
            }
        }
        Msg::PaneSnapshotUpdated(snapshot) => {
            if model.tmux_panes == snapshot {
                Vec::new()
            } else {
                model.set_tmux_panes(snapshot);
                vec![Cmd::Render]
            }
        }
        Msg::ActionCompleted(result) => {
            match result {
                Ok(message) => {
                    model.status_message = Some(ActionStatus {
                        message,
                        success: true,
                    });
                    model.error = None;
                }
                Err(error) => {
                    model.status_message = Some(ActionStatus {
                        message: error.clone(),
                        success: false,
                    });
                    model.error = Some(error);
                    push_effect(model, EffectKind::ErrorFlash, EffectTarget::Global);
                }
            }
            vec![Cmd::Render]
        }
        Msg::Error(error) => {
            model.error = Some(error);
            push_effect(model, EffectKind::ErrorFlash, EffectTarget::Global);
            finish_reload(model, true)
        }
        Msg::Quit => {
            model.quit_requested = true;
            vec![Cmd::Render]
        }
    }
}

fn handle_snapshot_updated(
    model: &mut Model,
    snapshot: crate::state::snapshot::DashboardSnapshot,
    source_state: super::model::ReadSourceState,
) -> Vec<Cmd> {
    let pending_reload = finish_reload(model, false);
    if model.snapshot.structural_eq(&snapshot) && model.read_source_state == source_state {
        model.snapshot_diff_drops = model.snapshot_diff_drops.saturating_add(1);
        return pending_reload;
    }
    let pause_edge = model.snapshot.paused_for_user.is_none() && snapshot.paused_for_user.is_some();
    model.snapshot = snapshot;
    model.read_source_state = source_state;
    model.refresh_now();
    model.refresh_tabs_enabled();
    model.initialize_overview_selection();
    let mut commands = vec![Cmd::ProbePanes, Cmd::Render];
    if pause_edge && model.motion.allows_rich_motion() {
        commands.push(Cmd::PauseSideEffects);
    }
    commands.extend(pending_reload);
    commands
}

fn finish_reload(model: &mut Model, render: bool) -> Vec<Cmd> {
    let mut commands = Vec::new();
    if model.reload_coalescer.finish() {
        commands.push(Cmd::ReloadFromSource(model.snapshot_source.clone()));
    }
    if render {
        commands.push(Cmd::Render);
    }
    commands
}

fn request_reload(model: &mut Model) -> Vec<Cmd> {
    if model.reload_coalescer.request() {
        vec![Cmd::ReloadFromSource(model.snapshot_source.clone())]
    } else {
        Vec::new()
    }
}

fn handle_key(model: &mut Model, key: &KeyEvent) -> Vec<Cmd> {
    if model.ui.filter_open {
        return handle_filter_key(model, key);
    }

    let Some(action) = keymap::action_for(key) else {
        return Vec::new();
    };

    if model.modal == ModalState::ConfirmAction && action == Action::OpenDetail {
        return confirm_action(model);
    }

    if model.modal != ModalState::None
        && !matches!(
            action,
            Action::MoveDown
                | Action::MoveUp
                | Action::OpenDetail
                | Action::ToggleHelp
                | Action::OpenThemePicker
                | Action::Quit
                | Action::CloseModal
        )
    {
        return Vec::new();
    }

    match action {
        Action::NextTab => {
            model.current_tab = model.next_tab();
            let target = EffectTarget::Tab(model.selected_tab_position());
            push_effect(model, EffectKind::TabSwitchForward, target);
            vec![Cmd::Render]
        }
        Action::PreviousTab => {
            model.current_tab = model.previous_tab();
            let target = EffectTarget::Tab(model.selected_tab_position());
            push_effect(model, EffectKind::TabSwitchBackward, target);
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
            model.mark_overview_selection_initialized();
            let target = EffectTarget::Row(model.selected_index());
            push_effect(model, EffectKind::SelectionHalo, target);
            vec![Cmd::Render]
        }
        Action::Last => {
            model.set_selected_index(model.max_selection_index());
            model.mark_overview_selection_initialized();
            let target = EffectTarget::Row(model.selected_index());
            push_effect(model, EffectKind::SelectionHalo, target);
            vec![Cmd::Render]
        }
        Action::OpenDetail => open_detail(model),
        Action::OpenFilter => open_filter(model),
        Action::PromptPrune => prompt_prune_selected(model),
        Action::PromptFocus => prompt_focus_selected(model),
        Action::Reload => request_reload(model),
        Action::ToggleNoise => {
            model.ui.hide_noise = !model.ui.hide_noise;
            vec![Cmd::Render]
        }
        Action::ToggleCompact => {
            model.ui.compact = !model.ui.compact;
            vec![Cmd::Render]
        }
        Action::ToggleHelp => {
            if model.modal == ModalState::Help {
                close_overlay(model);
            } else {
                model.show_help = true;
                model.modal = ModalState::Help;
                push_effect(model, EffectKind::HelpOverlay, EffectTarget::Global);
            }
            vec![Cmd::Render]
        }
        Action::OpenThemePicker => {
            model.modal = ModalState::ThemePicker;
            vec![Cmd::Render]
        }
        Action::Quit => {
            model.quit_requested = true;
            vec![Cmd::Render]
        }
        Action::CloseModal => {
            if model.modal == ModalState::None {
                model.feed_filter.clear();
            } else {
                close_overlay(model);
            }
            vec![Cmd::Render]
        }
    }
}

fn handle_click(model: &mut Model, action: ClickAction) -> Vec<Cmd> {
    match action {
        ClickAction::SelectTab(tab) => {
            if model.tabs_enabled.contains(&tab) {
                model.current_tab = tab;
                close_overlay(model);
            }
            vec![Cmd::Render]
        }
        ClickAction::SelectRow(index) => {
            let was_selected = index == model.selected_index();
            model.set_selected_index(index);
            model.mark_overview_selection_initialized();
            if was_selected && !matches!(model.modal, ModalState::FilterInput) {
                return open_detail(model);
            }
            vec![Cmd::Render]
        }
        ClickAction::SelectCostRow(index) => {
            model.current_tab = Tab::Overview;
            model.set_selected_index(index);
            model.mark_overview_selection_initialized();
            vec![Cmd::Render]
        }
        ClickAction::PromptPrune(index) => prompt_prune(model, index),
        ClickAction::PromptFocus(index) => prompt_focus(model, index),
        ClickAction::ConfirmAction => confirm_action(model),
        ClickAction::OpenDetail => open_detail(model),
        ClickAction::JumpToPaused => {
            if let Some(entry_id) = model
                .snapshot
                .paused_for_user
                .as_ref()
                .and_then(|pause| pause.entry_id.as_deref())
            {
                if let Some(index) = model
                    .snapshot
                    .sessions
                    .iter()
                    .position(|session| session.id == entry_id)
                {
                    model.current_tab = Tab::Overview;
                    model.set_selected_index(index);
                    model.mark_overview_selection_initialized();
                    model.modal = ModalState::SessionDetail;
                }
            }
            vec![Cmd::Render]
        }
        ClickAction::ToggleNoiseFilter => {
            model.ui.hide_noise = !model.ui.hide_noise;
            vec![Cmd::Render]
        }
        ClickAction::ToggleCompact => {
            model.ui.compact = !model.ui.compact;
            vec![Cmd::Render]
        }
        ClickAction::OpenFilter => open_filter(model),
        ClickAction::ClearFilter => {
            model.feed_filter.clear();
            model.ui.filter_open = false;
            model.modal = ModalState::None;
            vec![Cmd::Render]
        }
        ClickAction::OpenHelp | ClickAction::OpenLegend => {
            model.show_help = true;
            model.modal = ModalState::Help;
            vec![Cmd::Render]
        }
        ClickAction::OpenThemePicker => {
            model.modal = ModalState::ThemePicker;
            vec![Cmd::Render]
        }
        ClickAction::SelectTheme(theme) => {
            model.theme = theme;
            vec![Cmd::Render]
        }
        ClickAction::CloseOverlay => {
            close_overlay(model);
            vec![Cmd::Render]
        }
        ClickAction::Quit => {
            model.quit_requested = true;
            vec![Cmd::Render]
        }
        ClickAction::ScrollUp(source) => {
            handle_scroll(model, source, -1);
            vec![Cmd::Render]
        }
        ClickAction::ScrollDown(source) => {
            handle_scroll(model, source, 1);
            vec![Cmd::Render]
        }
        ClickAction::NoOp => Vec::new(),
    }
}

fn open_detail(model: &mut Model) -> Vec<Cmd> {
    match model.current_tab {
        Tab::Overview => model.modal = ModalState::SessionDetail,
        Tab::Decisions if model.decision_count() > 0 => model.modal = ModalState::DecisionDetail,
        Tab::LiveFeed if model.live_feed_row_count() > 0 => model.modal = ModalState::EventDetail,
        _ => {
            return vec![Cmd::LogAction(format!(
                "detail requested for tab={} row={}",
                model.current_tab.label(),
                model.selected_index()
            ))]
        }
    }
    vec![Cmd::Render]
}

fn prompt_prune_selected(model: &mut Model) -> Vec<Cmd> {
    prompt_prune(model, model.selected_index())
}

fn prompt_focus_selected(model: &mut Model) -> Vec<Cmd> {
    prompt_focus(model, model.selected_index())
}

fn prompt_prune(model: &mut Model, index: usize) -> Vec<Cmd> {
    let Some(session) = model.snapshot.sessions.get(index) else {
        return Vec::new();
    };
    let entry_id = session.id.clone();
    let title = session.title.clone();
    let pane_id = session.pane_id.clone();
    let is_stale = model.session_is_stale(session);
    let Some(pane_id) = pane_id else {
        set_status(model, "Selected entry has no tmux pane id", false);
        return vec![Cmd::Render];
    };
    if let Some(error) = model.tmux_panes.error.clone() {
        set_status(model, format!("tmux pane probe failed: {error}"), false);
        return vec![Cmd::Render];
    }
    if !model.tmux_panes.is_loaded() {
        set_status(model, "Pane list not loaded; retry in a moment", false);
        return vec![Cmd::ProbePanes, Cmd::Render];
    }
    if !is_stale {
        set_status(model, "Pane is still alive; prune disabled", false);
        return vec![Cmd::Render];
    }
    model.confirm = Some(ConfirmDialog {
        title: String::from("Prune stale entry?"),
        body: format!(
            "{entry_id} · {title}\n\npane {pane_id} is no longer in tmux. The registry entry will be removed.\n\nThis does NOT delete the worktree, branch, or PR."
        ),
        destructive: true,
        primary_label: String::from("Prune"),
        secondary_label: String::from("Cancel"),
        action: WriteAction::PruneStaleEntry { entry_id },
    });
    model.modal = ModalState::ConfirmAction;
    vec![Cmd::Render]
}

fn prompt_focus(model: &mut Model, index: usize) -> Vec<Cmd> {
    let Some(session) = model.snapshot.sessions.get(index) else {
        return Vec::new();
    };
    let entry_id = session.id.clone();
    let title = session.title.clone();
    let window = session.window.as_deref().unwrap_or("session").to_owned();
    let Some(pane_target) = session.pane_target.clone() else {
        set_status(model, "Selected entry has no tmux target", false);
        return vec![Cmd::Render];
    };
    let action = WriteAction::FocusWindow {
        pane_target: pane_target.clone(),
    };
    if quick_focus_enabled() {
        return vec![run_write_action(action)];
    }
    model.confirm = Some(ConfirmDialog {
        title: String::from("Focus this session?"),
        body: format!("{entry_id} · {title}\n\nSwitch tmux to window '{window}' ({pane_target})."),
        destructive: false,
        primary_label: String::from("Focus"),
        secondary_label: String::from("Cancel"),
        action,
    });
    model.modal = ModalState::ConfirmAction;
    vec![Cmd::Render]
}

fn confirm_action(model: &mut Model) -> Vec<Cmd> {
    let Some(dialog) = model.confirm.take() else {
        close_overlay(model);
        return vec![Cmd::Render];
    };
    model.modal = ModalState::None;
    model.ui.filter_open = false;
    vec![run_write_action(dialog.action), Cmd::Render]
}

fn run_write_action(action: WriteAction) -> Cmd {
    Cmd::Spawn(
        async move {
            match actions::run(action).await {
                Ok(message) => Msg::ActionCompleted(Ok(message)),
                Err(error) => Msg::ActionCompleted(Err(error)),
            }
        }
        .boxed(),
    )
}

fn set_status(model: &mut Model, message: impl Into<String>, success: bool) {
    model.status_message = Some(ActionStatus {
        message: message.into(),
        success,
    });
}

fn quick_focus_enabled() -> bool {
    std::env::var("FLIGHTDECK_DASHBOARD_QUICK_FOCUS")
        .ok()
        .is_some_and(|value| value.trim() == "1")
}

fn open_filter(model: &mut Model) -> Vec<Cmd> {
    model.feed_filter.begin_edit();
    model.ui.filter_open = true;
    model.modal = ModalState::FilterInput;
    vec![
        Cmd::LogAction(String::from("filter input opened")),
        Cmd::Render,
    ]
}

fn close_overlay(model: &mut Model) {
    model.show_help = false;
    model.modal = ModalState::None;
    model.ui.filter_open = false;
    model.event_detail = None;
    model.confirm = None;
}

fn handle_scroll(model: &mut Model, source: ScrollSource, delta: isize) {
    match (source, model.current_tab) {
        (ScrollSource::Sessions | ScrollSource::DetailRail, Tab::Overview)
        | (ScrollSource::Activity, Tab::LiveFeed)
        | (ScrollSource::Decisions, Tab::Decisions)
        | (ScrollSource::Conversations, Tab::Conversations)
        | (ScrollSource::Costs, Tab::Costs) => move_selection(model, delta),
        _ => {}
    }
}

fn handle_filter_key(model: &mut Model, key: &KeyEvent) -> Vec<Cmd> {
    match key.code {
        KeyCode::Enter => {
            if model.feed_filter.commit() {
                model.ui.filter_open = false;
                model.modal = ModalState::None;
            }
            vec![Cmd::Render]
        }
        KeyCode::Esc => {
            close_overlay(model);
            model.feed_filter.error = None;
            vec![Cmd::Render]
        }
        KeyCode::Backspace => {
            model.feed_filter.input.pop();
            model.feed_filter.error = None;
            vec![Cmd::Render]
        }
        KeyCode::Char('n') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            model.ui.hide_noise = !model.ui.hide_noise;
            vec![Cmd::Render]
        }
        KeyCode::Char(ch) if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT => {
            model.feed_filter.input.push(ch);
            model.feed_filter.error = None;
            vec![Cmd::Render]
        }
        _ => Vec::new(),
    }
}

fn move_selection(model: &mut Model, delta: isize) {
    let current = model.selected_index();
    let next = current
        .saturating_add_signed(delta)
        .min(model.max_selection_index());
    model.set_selected_index(next);
    model.mark_overview_selection_initialized();
    let target = EffectTarget::Row(model.selected_index());
    push_effect(model, EffectKind::SelectionHalo, target);
}

fn daemon_status_chip(status: &RuntimeDaemonStatus) -> SnapshotDaemonStatus {
    let label = if status.running {
        status.pid.map_or_else(
            || String::from("daemon: rust"),
            |pid| format!("daemon: rust pid={pid}"),
        )
    } else {
        String::from("daemon: stopped")
    };
    SnapshotDaemonStatus {
        label,
        healthy: Some(status.running),
        pid: status.pid,
        last_heartbeat_at: status.last_change_at,
    }
}

fn push_effect(model: &mut Model, kind: EffectKind, target: EffectTarget) {
    motion::push_effect(
        &mut model.active_effects,
        model.motion,
        model.animate_frame,
        kind,
        target,
    );
}
