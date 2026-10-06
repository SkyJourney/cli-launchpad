use std::sync::atomic::{AtomicBool, Ordering};

/// One-shot authorization for the application's final exit request.
#[derive(Default)]
pub struct AppExitGate {
    authorized: AtomicBool,
}

impl AppExitGate {
    pub fn authorize(&self) {
        self.authorized.store(true, Ordering::Release);
    }

    pub fn consume_authorization(&self) -> bool {
        self.authorized.swap(false, Ordering::AcqRel)
    }
}

#[cfg(test)]
mod tests {
    use super::AppExitGate;

    #[test]
    fn exit_authorization_is_consumed_exactly_once() {
        let gate = AppExitGate::default();

        assert!(!gate.consume_authorization());
        gate.authorize();
        assert!(gate.consume_authorization());
        assert!(!gate.consume_authorization());
    }
}
