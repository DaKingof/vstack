use crate::app::model::{EffectInstance, Model, MotionLevel};
use crate::state::snapshot::TrackedSession;

pub const MAX_ACTIVE_EFFECTS: usize = 32;

const BRAILLE_FRAMES: [&str; 8] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
const TAB_SWITCH_FRAMES: u64 = 3;
const HELP_FADE_FRAMES: u64 = 3;
const ERROR_FLASH_FRAMES: u64 = 4;
const SELECTION_HALO_FRAMES: u64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EffectKind {
    TabSwitchForward,
    TabSwitchBackward,
    HelpOverlay,
    ErrorFlash,
    SelectionHalo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EffectTarget {
    Global,
    Tab(crate::app::model::Tab),
    Row(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Effect {
    pub kind: EffectKind,
    pub duration_frames: u64,
    pub rich_motion_only: bool,
}

impl Effect {
    #[must_use]
    pub const fn for_kind(kind: EffectKind) -> Self {
        match kind {
            EffectKind::TabSwitchForward | EffectKind::TabSwitchBackward => Self {
                kind,
                duration_frames: TAB_SWITCH_FRAMES,
                rich_motion_only: true,
            },
            EffectKind::HelpOverlay => Self {
                kind,
                duration_frames: HELP_FADE_FRAMES,
                rich_motion_only: true,
            },
            EffectKind::ErrorFlash => Self {
                kind,
                duration_frames: ERROR_FLASH_FRAMES,
                rich_motion_only: false,
            },
            EffectKind::SelectionHalo => Self {
                kind,
                duration_frames: SELECTION_HALO_FRAMES,
                rich_motion_only: true,
            },
        }
    }

    #[must_use]
    pub fn is_active(self, instance: EffectInstance, frame: u64) -> bool {
        frame.saturating_sub(instance.started_frame) <= self.duration_frames
    }
}

pub fn push_effect(model: &mut Model, kind: EffectKind, target: EffectTarget) {
    let effect = Effect::for_kind(kind);
    if model.motion == MotionLevel::Off
        || (effect.rich_motion_only && !model.motion.allows_rich_motion())
    {
        return;
    }

    if let Some(instance) = model
        .active_effects
        .iter_mut()
        .find(|instance| instance.kind == kind && instance.target == target)
    {
        instance.started_frame = model.animate_frame;
        return;
    }

    if model.active_effects.len() >= MAX_ACTIVE_EFFECTS {
        evict_oldest(&mut model.active_effects);
    }

    model.active_effects.push(EffectInstance {
        kind,
        target,
        started_frame: model.animate_frame,
    });
}

pub fn prune_effects(model: &mut Model) {
    let frame = model.animate_frame;
    model
        .active_effects
        .retain(|instance| Effect::for_kind(instance.kind).is_active(*instance, frame));
}

#[must_use]
pub fn has_active_effects(model: &Model) -> bool {
    if model.motion == MotionLevel::Off {
        return false;
    }
    model
        .active_effects
        .iter()
        .any(|instance| Effect::for_kind(instance.kind).is_active(*instance, model.animate_frame))
        || model
            .snapshot
            .sessions
            .iter()
            .any(|session| session.state.is_transient())
}

#[must_use]
pub fn spinner(model: &Model, session: &TrackedSession) -> &'static str {
    if model.motion == MotionLevel::Off || !session.state.is_transient() {
        return " ";
    }
    let idx = (model.animate_frame as usize) % BRAILLE_FRAMES.len();
    BRAILLE_FRAMES[idx]
}

#[must_use]
pub fn tab_switch_hint(model: &Model) -> &'static str {
    if !model.motion.allows_rich_motion() {
        return "";
    }
    if has_kind(model, EffectKind::TabSwitchForward) {
        "slide→fade"
    } else if has_kind(model, EffectKind::TabSwitchBackward) {
        "slide←fade"
    } else {
        ""
    }
}

#[must_use]
pub fn help_alpha_label(model: &Model) -> &'static str {
    if !model.motion.allows_rich_motion() {
        return "static";
    }
    if has_kind(model, EffectKind::HelpOverlay) {
        "crossfade"
    } else {
        "settled"
    }
}

fn has_kind(model: &Model, kind: EffectKind) -> bool {
    model
        .active_effects
        .iter()
        .any(|instance| instance.kind == kind)
}

fn evict_oldest(active_effects: &mut Vec<EffectInstance>) {
    let Some((idx, _)) = active_effects
        .iter()
        .enumerate()
        .min_by_key(|(_, instance)| instance.started_frame)
    else {
        return;
    };
    active_effects.remove(idx);
}
