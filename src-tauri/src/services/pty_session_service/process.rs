use std::{sync::Arc, thread, time::Duration};

use portable_pty::Child as PtyChild;

use super::session::ManagedSession;
use crate::platform::execution_process::ProcessTree;

/// Why `tree_terminate` failed. The two cases are kept apart because the call
/// sites report them with different texts.
pub(super) enum TreeTerminateError {
    Poisoned,
    Failed(String),
}

impl ManagedSession {
    /// Ask the process tree to terminate. `process_tree == None` is Ok.
    pub(super) fn tree_terminate(&self) -> Result<(), TreeTerminateError> {
        match self.process_tree.lock() {
            Ok(tree) => tree
                .as_ref()
                .map(ProcessTree::terminate)
                .transpose()
                .map(|_| ())
                .map_err(|error| TreeTerminateError::Failed(error.to_string())),
            Err(_) => Err(TreeTerminateError::Poisoned),
        }
    }

    /// Force-kill the process tree; a poisoned lock or a missing tree is ignored.
    pub(super) fn tree_force_kill(&self) {
        if let Ok(tree) = self.process_tree.lock() {
            if let Some(tree) = tree.as_ref() {
                let _ = tree.force_kill();
            }
        }
    }

    /// Kill the leader process through its `ChildKiller`; errors are ignored.
    pub(super) fn leader_kill(&self) {
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }

    /// Force-kill the tree, then the leader; errors are ignored.
    pub(super) fn force_terminate(&self) {
        self.tree_force_kill();
        self.leader_kill();
    }
}

/// Terminate-then-escalate policy of this module. The wait between the two
/// steps happens with no session lock held.
pub(super) struct Terminator {
    grace: Duration,
}

impl Terminator {
    /// The monitor thread waits this long between terminate and force_kill.
    pub(super) const MONITOR: Terminator = Terminator {
        grace: Duration::from_millis(100),
    };
    /// A user-requested termination escalates after this long.
    pub(super) const USER: Terminator = Terminator {
        grace: Duration::from_millis(750),
    };

    /// terminate -> wait `grace` (no lock held) -> force_kill (tree only).
    pub(super) fn stop_tree(&self, session: &ManagedSession, sleep: &dyn Fn(Duration)) {
        let _ = session.tree_terminate();
        sleep(self.grace);
        session.tree_force_kill();
    }

    /// Spawn the named delayed-escalation thread used by a user termination.
    pub(super) fn escalate_later(&self, session: Arc<ManagedSession>) -> std::io::Result<()> {
        let grace = self.grace;
        thread::Builder::new()
            .name(format!("pty-force-{}", session.session_id))
            .spawn(move || {
                thread::sleep(grace);
                session.force_terminate();
            })
            .map(|_| ())
    }
}

pub(super) fn stop_spawned_child(
    process_tree: &ProcessTree,
    child: &mut Box<dyn PtyChild + Send + Sync>,
) {
    let _ = process_tree.terminate();
    let _ = process_tree.force_kill();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::*;
    use crate::services::pty_session_service::PtySessionManager;

    #[test]
    fn terminator_waits_outside_every_session_lock() {
        let manager = PtySessionManager::default();
        let inserted = manager.insert_test_session("main", None);
        let session = manager
            .registry_handle()
            .get(&inserted.session_id)
            .expect("registered session");
        let observed = std::cell::Cell::new(0_usize);

        Terminator::MONITOR.stop_tree(&session, &|_: Duration| {
            assert!(session.process_tree.try_lock().is_ok());
            assert!(session.killer.try_lock().is_ok());
            assert!(session.route_and_handoff.try_lock().is_ok());
            observed.set(observed.get() + 1);
        });

        assert_eq!(observed.get(), 1);
        assert!(session.process_tree.try_lock().is_ok());
    }

    #[test]
    fn tree_terminate_distinguishes_a_poisoned_lock_from_a_failed_terminate() {
        let manager = PtySessionManager::default();
        let registry = manager.registry_handle();

        let without_tree = manager.insert_test_session("main", None);
        let session_a = registry
            .get(&without_tree.session_id)
            .expect("registered session");
        assert!(matches!(session_a.tree_terminate(), Ok(())));

        let poisoned = manager.insert_test_session("main", None);
        let session_b = registry
            .get(&poisoned.session_id)
            .expect("registered session");
        let poisoner = Arc::clone(&session_b);
        let joined = thread::spawn(move || {
            let _guard = poisoner.process_tree.lock().expect("lock before poison");
            panic!("poison the process tree lock");
        })
        .join();
        assert!(joined.is_err());

        assert!(matches!(
            session_b.tree_terminate(),
            Err(TreeTerminateError::Poisoned)
        ));
        // A poisoned lock is ignored silently by the force primitives.
        session_b.tree_force_kill();
        session_b.leader_kill();
    }

    #[test]
    fn force_terminate_kills_the_leader_even_without_a_process_tree() {
        let manager = PtySessionManager::default();
        let inserted = manager.insert_test_session("main", None);
        let session = manager
            .registry_handle()
            .get(&inserted.session_id)
            .expect("registered session");

        session.force_terminate();
        assert_eq!(inserted.kills.load(Ordering::SeqCst), 1);
        session.force_terminate();
        assert_eq!(inserted.kills.load(Ordering::SeqCst), 2);
        session.leader_kill();
        assert_eq!(inserted.kills.load(Ordering::SeqCst), 3);
    }
}
