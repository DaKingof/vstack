#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReloadCoalescer {
    in_flight: bool,
    pending: bool,
}

impl ReloadCoalescer {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            in_flight: false,
            pending: false,
        }
    }

    pub fn request(&mut self) -> bool {
        if self.in_flight {
            self.pending = true;
            return false;
        }
        self.in_flight = true;
        true
    }

    pub fn finish(&mut self) -> bool {
        if !self.in_flight {
            return false;
        }
        if self.pending {
            self.pending = false;
            true
        } else {
            self.in_flight = false;
            false
        }
    }

    #[must_use]
    pub const fn is_in_flight(self) -> bool {
        self.in_flight
    }
}

#[cfg(test)]
mod tests {
    use super::ReloadCoalescer;

    #[test]
    fn coalesces_pending_reload() {
        let mut reload = ReloadCoalescer::new();
        assert!(reload.request());
        assert!(!reload.request());
        assert!(reload.finish());
        assert!(reload.is_in_flight());
        assert!(!reload.finish());
        assert!(!reload.is_in_flight());
    }
}
