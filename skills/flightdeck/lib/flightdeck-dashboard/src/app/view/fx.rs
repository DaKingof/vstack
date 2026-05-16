use crate::app::model::Model;
use crate::app::motion::{self, EffectKind, MotionLevel};
use crate::state::snapshot::TrackedSession;

const BRAILLE_FRAMES: [&str; 8] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];

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
    if motion::has_kind(&model.active_effects, EffectKind::TabSwitchForward) {
        "slide→fade"
    } else if motion::has_kind(&model.active_effects, EffectKind::TabSwitchBackward) {
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
    if motion::has_kind(&model.active_effects, EffectKind::HelpOverlay) {
        "crossfade"
    } else {
        "settled"
    }
}
