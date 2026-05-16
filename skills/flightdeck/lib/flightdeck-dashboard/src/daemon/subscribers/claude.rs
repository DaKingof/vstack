use super::SubscriberHandle;

#[must_use]
pub fn not_yet_implemented() -> SubscriberHandle {
    SubscriberHandle::completed("claude")
}
