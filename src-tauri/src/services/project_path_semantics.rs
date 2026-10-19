//! Cache of the probed path semantics of a project root (PD-10).
//!
//! Keyed by the project id and the lexical key of its stored path snapshot, so a
//! changed path is a cache miss and never reuses an old answer. `Sensitive` and
//! `Insensitive` stay cached until invalidated (project removed, backup restored);
//! `Unknown` expires after `UNKNOWN_RETRY_MS` so a transient failure is retried.
//! The probe never runs while the cache lock is held.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::platform::case_sensitivity::{
    CaseSensitivity, CaseSensitivityProbe, NativeCaseSensitivityProbe, PathSemantics, Tri,
};
use crate::platform::path_identity::ProjectPathKey;
use crate::services::project_directory::ProjectDirectory;
use crate::{blocking, budgets};

/// Rollback switch (main report 4.7.2.9): `false` forces every project to
/// `Sensitive`, which turns the whole feature off without touching any other code.
pub const FOLD_PROJECT_FILE_CASE: bool = true;
/// How long an `Unknown` answer is trusted before the probe runs again.
pub const UNKNOWN_RETRY_MS: u64 = 60_000;

pub trait SemanticsClock: Send + Sync {
    fn now_ms(&self) -> u64;
}

pub struct SystemClock;

impl SemanticsClock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0)
    }
}

struct Entry {
    semantics: PathSemantics,
    /// `None`: valid until invalidated.
    expires_at_ms: Option<u64>,
}

type Key = (i64, ProjectPathKey);

pub struct CaseSensitivityCache {
    entries: Mutex<HashMap<Key, Entry>>,
    clock: Arc<dyn SemanticsClock>,
    fold_enabled: bool,
}

impl Default for CaseSensitivityCache {
    fn default() -> Self {
        Self::new()
    }
}

impl CaseSensitivityCache {
    pub fn new() -> Self {
        Self::with_clock_and_fold(Arc::new(SystemClock), FOLD_PROJECT_FILE_CASE)
    }

    pub fn with_clock_and_fold(clock: Arc<dyn SemanticsClock>, fold_enabled: bool) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            clock,
            fold_enabled,
        }
    }

    fn forced() -> PathSemantics {
        PathSemantics {
            case: CaseSensitivity::Sensitive,
            normalization_insensitive: Tri::No,
        }
    }

    fn key(directory_id: i64, directory_path: &str) -> Key {
        (directory_id, ProjectPathKey::of(directory_path))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Key, Entry>> {
        // A poisoned map only holds plain values; the probe result stays usable.
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lookup(&self, key: &Key) -> Option<PathSemantics> {
        let now = self.clock.now_ms();
        let entries = self.lock();
        let entry = entries.get(key)?;
        match entry.expires_at_ms {
            Some(expires_at) if now >= expires_at => None,
            _ => Some(entry.semantics),
        }
    }

    /// The semantics of `root`, probing at most once per project until the answer is invalidated
    /// (or, for `Unknown`, expires).
    pub fn semantics_for(
        &self,
        directory_id: i64,
        directory_path: &str,
        root: &ProjectDirectory,
        probe: &dyn CaseSensitivityProbe,
    ) -> PathSemantics {
        if !self.fold_enabled {
            return Self::forced();
        }
        let key = Self::key(directory_id, directory_path);
        if let Some(cached) = self.lookup(&key) {
            return cached;
        }
        let semantics = probe.probe(root.dir());
        self.store(key, semantics)
    }

    /// Records a probe answer. A slow probe that finishes after a faster one must not downgrade
    /// a known answer to `Unknown`; the known answer wins and is returned.
    fn store(&self, key: Key, semantics: PathSemantics) -> PathSemantics {
        let expires_at_ms = match semantics.case {
            CaseSensitivity::Unknown => Some(self.clock.now_ms() + UNKNOWN_RETRY_MS),
            _ => None,
        };
        let mut entries = self.lock();
        if semantics.case == CaseSensitivity::Unknown {
            if let Some(existing) = entries.get(&key) {
                if existing.expires_at_ms.is_none() {
                    return existing.semantics;
                }
            }
        }
        entries.insert(
            key,
            Entry {
                semantics,
                expires_at_ms,
            },
        );
        semantics
    }

    /// Reads a cached answer only: no probing and no filesystem access, so it is safe under the
    /// database lock. A miss or an expired `Unknown` returns `None`.
    pub fn peek(&self, directory_id: i64, directory_path: &str) -> Option<PathSemantics> {
        if !self.fold_enabled {
            return Some(Self::forced());
        }
        self.lookup(&Self::key(directory_id, directory_path))
    }

    /// The project was removed or its path changed.
    pub fn invalidate_project(&self, directory_id: i64) {
        self.lock().retain(|(id, _), _| *id != directory_id);
    }

    /// A backup was restored: ids may now name other projects.
    pub fn invalidate_all(&self) {
        self.lock().clear();
    }
}

/// Probes on the blocking pool inside `budgets::CASE_PROBE`. A timeout or a failure is not an
/// error for the caller: the answer is `Unknown`, which never folds.
pub async fn probe_semantics(
    cache: Arc<CaseSensitivityCache>,
    directory_id: i64,
    directory_path: String,
    root: Arc<ProjectDirectory>,
) -> PathSemantics {
    probe_semantics_with(
        cache,
        directory_id,
        directory_path,
        root,
        Arc::new(NativeCaseSensitivityProbe),
        budgets::CASE_PROBE,
    )
    .await
}

async fn probe_semantics_with(
    cache: Arc<CaseSensitivityCache>,
    directory_id: i64,
    directory_path: String,
    root: Arc<ProjectDirectory>,
    probe: Arc<dyn CaseSensitivityProbe>,
    budget: std::time::Duration,
) -> PathSemantics {
    // A cached answer is memory only: it never waits for the blocking pool, so a busy pool
    // cannot turn a known answer into `Unknown`.
    if let Some(cached) = cache.peek(directory_id, &directory_path) {
        return cached;
    }
    let outcome = blocking("project_path_semantics.probe", budget, move || {
        Ok(cache.semantics_for(directory_id, &directory_path, &root, probe.as_ref()))
    })
    .await;
    match outcome {
        Ok(semantics) => semantics,
        Err(error) => {
            log::debug!(
                "项目路径语义探测未完成，按未知处理：{}",
                json!(error)["code"].as_str().unwrap_or("unknown")
            );
            PathSemantics::UNKNOWN
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    use super::{CaseSensitivityCache, SemanticsClock, UNKNOWN_RETRY_MS};
    use crate::platform::case_sensitivity::{
        CaseSensitivity, FixedCaseSensitivityProbe, PathSemantics, Tri,
    };
    use crate::services::project_directory::ProjectDirectory;

    struct FakeClock(AtomicU64);

    impl FakeClock {
        fn new() -> Arc<Self> {
            Arc::new(Self(AtomicU64::new(1_000)))
        }

        fn advance(&self, milliseconds: u64) {
            self.0.fetch_add(milliseconds, Ordering::SeqCst);
        }
    }

    impl SemanticsClock for FakeClock {
        fn now_ms(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    fn insensitive() -> PathSemantics {
        PathSemantics {
            case: CaseSensitivity::Insensitive,
            normalization_insensitive: Tri::No,
        }
    }

    fn sensitive() -> PathSemantics {
        PathSemantics {
            case: CaseSensitivity::Sensitive,
            normalization_insensitive: Tri::Unknown,
        }
    }

    fn project() -> (tempfile::TempDir, ProjectDirectory) {
        let root = tempfile::tempdir().unwrap();
        let directory = ProjectDirectory::open(root.path()).unwrap();
        (root, directory)
    }

    #[test]
    fn probes_once_per_project_and_caches_by_id_and_path_snapshot() {
        let clock = FakeClock::new();
        let cache = CaseSensitivityCache::with_clock_and_fold(clock, true);
        let (_root, directory) = project();
        let probe = FixedCaseSensitivityProbe::new(insensitive());

        assert_eq!(
            cache.semantics_for(1, "/work/a", &directory, &probe),
            insensitive()
        );
        assert_eq!(
            cache.semantics_for(1, "/work/a", &directory, &probe),
            insensitive()
        );
        assert_eq!(probe.calls(), 1);

        // A different project id or a different path snapshot is a different key.
        cache.semantics_for(2, "/work/a", &directory, &probe);
        assert_eq!(probe.calls(), 2);
        cache.semantics_for(1, "/work/b", &directory, &probe);
        assert_eq!(probe.calls(), 3);

        // `peek` reads the cache only.
        assert_eq!(cache.peek(1, "/work/a"), Some(insensitive()));
        assert_eq!(cache.peek(9, "/work/a"), None);
        assert_eq!(cache.peek(1, "/work/never-seen"), None);
        assert_eq!(probe.calls(), 3);

        // Paths that differ only in case: one key where the project root rule folds case
        // (Windows), two keys elsewhere.
        let before = probe.calls();
        cache.semantics_for(1, "/WORK/A", &directory, &probe);
        if cfg!(windows) {
            assert_eq!(probe.calls(), before, "Windows root paths fold case");
        } else {
            assert_eq!(probe.calls(), before + 1, "other platforms keep case");
        }
    }

    #[test]
    fn unknown_results_expire_after_sixty_seconds_and_known_results_do_not() {
        let clock = FakeClock::new();
        let cache = CaseSensitivityCache::with_clock_and_fold(clock.clone(), true);
        let (_root, directory) = project();

        let unknown = FixedCaseSensitivityProbe::new(PathSemantics::UNKNOWN);
        cache.semantics_for(1, "/p", &directory, &unknown);
        clock.advance(UNKNOWN_RETRY_MS - 1_000);
        cache.semantics_for(1, "/p", &directory, &unknown);
        assert_eq!(unknown.calls(), 1, "still fresh after 59 seconds");
        assert_eq!(cache.peek(1, "/p"), Some(PathSemantics::UNKNOWN));
        clock.advance(2_000);
        assert_eq!(cache.peek(1, "/p"), None, "expired Unknown is a miss");
        cache.semantics_for(1, "/p", &directory, &unknown);
        assert_eq!(unknown.calls(), 2, "probed again after 61 seconds");

        for known in [insensitive(), sensitive()] {
            let probe = FixedCaseSensitivityProbe::new(known);
            cache.semantics_for(7, "/known", &directory, &probe);
            clock.advance(60 * 60 * 1_000);
            cache.semantics_for(7, "/known", &directory, &probe);
            assert_eq!(probe.calls(), 1, "a known answer does not expire");
            cache.invalidate_project(7);
        }
    }

    #[test]
    fn invalidation_clears_removed_changed_and_restored_projects() {
        let cache = CaseSensitivityCache::with_clock_and_fold(FakeClock::new(), true);
        let (_root, directory) = project();
        let probe = FixedCaseSensitivityProbe::new(insensitive());
        cache.semantics_for(1, "/one", &directory, &probe);
        cache.semantics_for(2, "/two", &directory, &probe);
        assert_eq!(probe.calls(), 2);

        cache.invalidate_project(1);
        cache.semantics_for(1, "/one", &directory, &probe);
        cache.semantics_for(2, "/two", &directory, &probe);
        assert_eq!(probe.calls(), 3, "only project 1 is probed again");

        cache.invalidate_all();
        cache.semantics_for(1, "/one", &directory, &probe);
        cache.semantics_for(2, "/two", &directory, &probe);
        assert_eq!(probe.calls(), 5, "both are probed again after a restore");
    }

    #[test]
    fn disabling_folding_forces_sensitive_semantics() {
        let cache = CaseSensitivityCache::with_clock_and_fold(FakeClock::new(), false);
        let (_root, directory) = project();
        let probe = FixedCaseSensitivityProbe::new(insensitive());
        let forced = PathSemantics {
            case: CaseSensitivity::Sensitive,
            normalization_insensitive: Tri::No,
        };
        assert_eq!(cache.semantics_for(1, "/p", &directory, &probe), forced);
        assert_eq!(cache.peek(1, "/p"), Some(forced));
        assert_eq!(probe.calls(), 0, "the probe is never called while disabled");
    }

    #[tokio::test]
    async fn a_cached_answer_is_returned_without_probing() {
        let cache = Arc::new(CaseSensitivityCache::with_clock_and_fold(
            FakeClock::new(),
            true,
        ));
        let (_root, directory) = project();
        // A value no native probe produces (normalization `Yes` on any host here).
        let cached = PathSemantics {
            case: CaseSensitivity::Insensitive,
            normalization_insensitive: Tri::Yes,
        };
        let probe = FixedCaseSensitivityProbe::new(cached);
        cache.semantics_for(3, "/cached", &directory, &probe);

        let answer = super::probe_semantics(
            Arc::clone(&cache),
            3,
            "/cached".to_string(),
            Arc::new(directory),
        )
        .await;
        assert_eq!(answer, cached);
        assert_eq!(probe.calls(), 1);
    }

    #[test]
    fn a_late_unknown_does_not_replace_a_known_answer() {
        let cache = CaseSensitivityCache::with_clock_and_fold(FakeClock::new(), true);
        let (_root, directory) = project();
        let known = FixedCaseSensitivityProbe::new(insensitive());
        cache.semantics_for(1, "/p", &directory, &known);
        // Simulate a probe that was already running when the answer was cached.
        let late = FixedCaseSensitivityProbe::new(PathSemantics::UNKNOWN);
        cache.store(CaseSensitivityCache::key(1, "/p"), late.semantics);
        assert_eq!(cache.peek(1, "/p"), Some(insensitive()));
    }

    /// A probe that takes longer than any budget a test would wait for.
    struct SlowProbe(std::time::Duration);

    impl crate::platform::case_sensitivity::CaseSensitivityProbe for SlowProbe {
        fn probe(&self, _root: &cap_std::fs::Dir) -> PathSemantics {
            std::thread::sleep(self.0);
            insensitive()
        }
    }

    #[tokio::test]
    async fn probe_semantics_answers_unknown_when_the_probe_exceeds_its_budget() {
        let cache = Arc::new(CaseSensitivityCache::with_clock_and_fold(
            FakeClock::new(),
            true,
        ));
        let (_root, directory) = project();
        let directory = Arc::new(directory);

        // The probe is slower than the budget: the caller gets Unknown, not an error.
        let slow = super::probe_semantics_with(
            Arc::clone(&cache),
            1,
            "/slow".to_string(),
            Arc::clone(&directory),
            Arc::new(SlowProbe(std::time::Duration::from_millis(400))),
            std::time::Duration::from_millis(30),
        )
        .await;
        assert_eq!(slow, PathSemantics::UNKNOWN);

        // Reverse: with enough budget the same probe's answer comes back.
        let fast = super::probe_semantics_with(
            Arc::clone(&cache),
            2,
            "/fast".to_string(),
            directory,
            Arc::new(SlowProbe(std::time::Duration::from_millis(1))),
            std::time::Duration::from_secs(5),
        )
        .await;
        assert_eq!(fast, insensitive());
    }
}
