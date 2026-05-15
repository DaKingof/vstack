use crate::state::snapshot::TrackedSession;

pub const MAX_ACTIVE_EFFECTS: usize = 32;

const TAB_SWITCH_FRAMES: u64 = 3;
const HELP_FADE_FRAMES: u64 = 3;
const ERROR_FLASH_FRAMES: u64 = 4;
const SELECTION_HALO_FRAMES: u64 = 2;
const ACTIVITY_ROW_ENTER_FRAMES: u64 = 1;
const ACTIVITY_FLASH_FRAMES: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MotionLevel {
    Full,
    Reduced,
    Off,
}

impl MotionLevel {
    #[must_use]
    pub fn from_env() -> Self {
        if std::env::var_os("NO_MOTION").is_some() || std::env::var_os("NO_COLOR").is_some() {
            return Self::Off;
        }
        match std::env::var("FLIGHTDECK_DASHBOARD_MOTION") {
            Ok(value) if value.eq_ignore_ascii_case("off") => Self::Off,
            Ok(value) if value.eq_ignore_ascii_case("reduced") => Self::Reduced,
            _ => Self::Full,
        }
    }

    #[must_use]
    pub const fn allows_motion(self) -> bool {
        !matches!(self, Self::Off)
    }

    #[must_use]
    pub const fn allows_rich_motion(self) -> bool {
        matches!(self, Self::Full)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EffectKind {
    TabSwitchForward,
    TabSwitchBackward,
    HelpOverlay,
    ErrorFlash,
    SelectionHalo,
    ActivityRowEnter,
    ActivityImportantFlash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EffectTarget {
    Global,
    Tab(usize),
    Row(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectInstance {
    pub kind: EffectKind,
    pub target: EffectTarget,
    pub started_frame: u64,
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
            EffectKind::ActivityRowEnter => Self {
                kind,
                duration_frames: ACTIVITY_ROW_ENTER_FRAMES,
                rich_motion_only: true,
            },
            EffectKind::ActivityImportantFlash => Self {
                kind,
                duration_frames: ACTIVITY_FLASH_FRAMES,
                rich_motion_only: true,
            },
        }
    }

    #[must_use]
    pub fn is_active(self, instance: EffectInstance, frame: u64) -> bool {
        frame.saturating_sub(instance.started_frame) <= self.duration_frames
    }
}

pub fn push_effect(
    active_effects: &mut Vec<EffectInstance>,
    motion: MotionLevel,
    animate_frame: u64,
    kind: EffectKind,
    target: EffectTarget,
) {
    let effect = Effect::for_kind(kind);
    if motion == MotionLevel::Off || (effect.rich_motion_only && !motion.allows_rich_motion()) {
        return;
    }

    if let Some(instance) = active_effects
        .iter_mut()
        .find(|instance| instance.kind == kind && instance.target == target)
    {
        instance.started_frame = animate_frame;
        return;
    }

    if active_effects.len() >= MAX_ACTIVE_EFFECTS {
        evict_oldest(active_effects);
    }

    active_effects.push(EffectInstance {
        kind,
        target,
        started_frame: animate_frame,
    });
}

pub fn prune_effects(active_effects: &mut Vec<EffectInstance>, animate_frame: u64) {
    active_effects
        .retain(|instance| Effect::for_kind(instance.kind).is_active(*instance, animate_frame));
}

#[must_use]
pub fn has_active_effects(
    active_effects: &[EffectInstance],
    motion: MotionLevel,
    animate_frame: u64,
    sessions: &[TrackedSession],
) -> bool {
    if motion == MotionLevel::Off {
        return false;
    }
    active_effects
        .iter()
        .any(|instance| Effect::for_kind(instance.kind).is_active(*instance, animate_frame))
        || sessions.iter().any(|session| session.state.is_transient())
}

#[must_use]
pub fn has_kind(active_effects: &[EffectInstance], kind: EffectKind) -> bool {
    active_effects.iter().any(|instance| instance.kind == kind)
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
