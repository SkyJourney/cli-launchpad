use std::sync::atomic::{AtomicBool, Ordering};

use crate::models::app_setting::CloseBehavior;
use crate::models::window_kind::{window_kind_of, WindowKind};
use crate::services::content_window_grants::ContentWindowGrantRegistry;
use crate::services::pty_session_service::PtySessionManager;

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

/// 一次应用退出请求的处理结论；调用方根据它执行阻止、显示主窗与通知前端等副作用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitRequestDecision {
    /// 放行：已有一次性授权，或没有任何需要询问的损失。
    AllowExit,
    /// 有主窗：阻止退出，显示主窗并把活动数量带给前端。
    PreventAndAskMain {
        pty_count: usize,
        execution_task_count: usize,
    },
    /// 没有主窗但仍有运行中的 PTY：只阻止，无处可问。
    PreventWithoutMain,
}

/// 纯决策：只消费一次性授权，不产生任何副作用。
/// 主窗缺失时不检查文件窗的脏状态，也不检查执行任务（现行行为，N5）。
pub fn decide_exit_request(
    gate: &AppExitGate,
    active_pty_count: usize,
    execution_task_count: usize,
    main_window_present: bool,
) -> ExitRequestDecision {
    if gate.consume_authorization() {
        return ExitRequestDecision::AllowExit;
    }
    if main_window_present {
        return ExitRequestDecision::PreventAndAskMain {
            pty_count: active_pty_count,
            execution_task_count,
        };
    }
    if active_pty_count > 0 {
        ExitRequestDecision::PreventWithoutMain
    } else {
        ExitRequestDecision::AllowExit
    }
}

/// 窗口收到关闭请求时的处理结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainCloseDecision {
    /// 不是主窗：不处理。
    NotMainWindow,
    /// 主窗：阻止关闭并隐藏到托盘。
    HideToTray,
    /// 主窗：阻止关闭并发起应用退出请求，仍经过退出确认。
    RequestAppExit,
}

/// 纯决策：窗口类别通过注册表判断，不比较字符串字面量。
pub fn decide_close_request(
    window_label: &str,
    close_behavior: CloseBehavior,
) -> MainCloseDecision {
    if window_kind_of(window_label) != Some(WindowKind::Main) {
        return MainCloseDecision::NotMainWindow;
    }
    match close_behavior {
        CloseBehavior::MinimizeToTray => MainCloseDecision::HideToTray,
        CloseBehavior::Quit => MainCloseDecision::RequestAppExit,
    }
}

/// 窗口销毁后需要通知前端的清理结果。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DestroyedWindowCleanup {
    pub file_grant_revoked: bool,
    pub owner_lost_session_ids: Vec<String>,
}

/// 窗口销毁清理：内容窗只撤销自己的文件授权，终端窗回收其拥有的会话；
/// 其他类别或非法标签返回空结果。函数不依赖应用句柄，通知前端由调用方负责。
pub fn cleanup_destroyed_window(
    label: &str,
    grants: &ContentWindowGrantRegistry,
    sessions: &PtySessionManager,
) -> Result<DestroyedWindowCleanup, String> {
    let mut cleanup = DestroyedWindowCleanup::default();
    match window_kind_of(label) {
        Some(WindowKind::WorkspaceContent) => {
            cleanup.file_grant_revoked = grants.revoke(label).map_err(|error| error.to_string())?;
        }
        Some(WindowKind::Terminal) => {
            cleanup.owner_lost_session_ids = sessions.reclaim_window(label);
        }
        _ => {}
    }
    Ok(cleanup)
}

#[cfg(test)]
mod tests {
    use super::AppExitGate;
    use super::{
        cleanup_destroyed_window, decide_close_request, decide_exit_request,
        DestroyedWindowCleanup, ExitRequestDecision, MainCloseDecision,
    };
    use crate::models::app_setting::CloseBehavior;
    use crate::services::content_window_grants::{
        ContentWindowFileGrant, ContentWindowGrantRegistry,
    };
    use crate::services::pty_session_service::PtySessionManager;

    const FILE_L1: &str = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";
    const FILE_L2: &str = "workspace-content-9f1b6a52-3c47-4d5e-8a1b-2c3d4e5f6a7b";
    const TERM_T1: &str = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
    const TERM_T2: &str = "terminal-9f1b6a52-3c47-4d5e-8a1b-2c3d4e5f6a7b";
    const SOURCE: &str = include_str!("app_lifecycle.rs");
    const LIB_RS: &str = include_str!("../lib.rs");

    fn file_grant() -> ContentWindowFileGrant {
        ContentWindowFileGrant {
            directory_id: 1,
            directory_path: "C:/project".into(),
            relative_path: "a.txt".into(),
        }
    }

    #[test]
    fn exit_request_decision_matrix() {
        use ExitRequestDecision::{AllowExit, PreventAndAskMain, PreventWithoutMain};
        // (已授权, PTY 数, 执行任务数, 主窗存在, 期望)
        let rows = [
            (true, 3, 0, true, AllowExit),
            (
                false,
                0,
                0,
                true,
                PreventAndAskMain {
                    pty_count: 0,
                    execution_task_count: 0,
                },
            ),
            (
                false,
                3,
                0,
                true,
                PreventAndAskMain {
                    pty_count: 3,
                    execution_task_count: 0,
                },
            ),
            (false, 2, 0, false, PreventWithoutMain),
            // 主窗缺失时不检查文件窗脏状态（N5）。
            (false, 0, 0, false, AllowExit),
            // 只有执行任务也必须询问（PD-01）。
            (
                false,
                0,
                2,
                true,
                PreventAndAskMain {
                    pty_count: 0,
                    execution_task_count: 2,
                },
            ),
            (
                false,
                1,
                2,
                true,
                PreventAndAskMain {
                    pty_count: 1,
                    execution_task_count: 2,
                },
            ),
            // 授权后不再询问。
            (true, 0, 2, true, AllowExit),
            // 执行任务不阻止无主窗退出，终止由目标 041 兜底。
            (false, 0, 2, false, AllowExit),
        ];
        for (index, (authorized, pty, tasks, main_present, expected)) in
            rows.into_iter().enumerate()
        {
            let gate = AppExitGate::default();
            if authorized {
                gate.authorize();
            }
            assert_eq!(
                decide_exit_request(&gate, pty, tasks, main_present),
                expected,
                "row {}",
                index + 1
            );
        }

        // 一次性：授权只放行一次。
        let gate = AppExitGate::default();
        gate.authorize();
        assert_eq!(decide_exit_request(&gate, 3, 0, true), AllowExit);
        assert_eq!(
            decide_exit_request(&gate, 3, 0, true),
            PreventAndAskMain {
                pty_count: 3,
                execution_task_count: 0
            }
        );
        // 反向断言：未授权的 gate 经过任何决策之后仍然没有授权。
        let gate = AppExitGate::default();
        let _ = decide_exit_request(&gate, 0, 0, true);
        let _ = decide_exit_request(&gate, 2, 1, false);
        assert!(!gate.consume_authorization());
    }

    #[test]
    fn exit_decision_function_does_not_terminate_anything() {
        let start = SOURCE.find("pub fn decide_exit_request").unwrap();
        let rest = &SOURCE[start..];
        let end = rest.find("pub fn decide_close_request").unwrap();
        let body = &rest[..end];
        for forbidden in ["terminate", "cancel", "emit", "exit("] {
            assert!(
                !body.contains(forbidden),
                "decide_exit_request must stay pure: found {forbidden}"
            );
        }
        assert!(body.contains("consume_authorization"));

        // 反向断言：关闭决策同样是纯函数。
        let close_start = SOURCE.find("pub fn decide_close_request").unwrap();
        let close_rest = &SOURCE[close_start..];
        let close_end = close_rest.find("pub fn cleanup_destroyed_window").unwrap();
        let close_body = &close_rest[..close_end];
        for forbidden in ["terminate", "cancel", "emit", "exit("] {
            assert!(
                !close_body.contains(forbidden),
                "decide_close_request must stay pure: found {forbidden}"
            );
        }
    }

    #[test]
    fn main_close_request_decisions() {
        assert_eq!(
            decide_close_request("main", CloseBehavior::MinimizeToTray),
            MainCloseDecision::HideToTray
        );
        assert_eq!(
            decide_close_request("main", CloseBehavior::Quit),
            MainCloseDecision::RequestAppExit
        );
        assert_eq!(
            decide_close_request(TERM_T1, CloseBehavior::Quit),
            MainCloseDecision::NotMainWindow
        );
        assert_eq!(
            decide_close_request(FILE_L1, CloseBehavior::MinimizeToTray),
            MainCloseDecision::NotMainWindow
        );
        // 大小写与空白敏感。
        assert_eq!(
            decide_close_request("MAIN", CloseBehavior::Quit),
            MainCloseDecision::NotMainWindow
        );
        assert_eq!(
            decide_close_request("", CloseBehavior::Quit),
            MainCloseDecision::NotMainWindow
        );
        assert_eq!(
            decide_close_request("main ", CloseBehavior::Quit),
            MainCloseDecision::NotMainWindow
        );
    }

    #[test]
    fn destroyed_file_window_revokes_only_its_grant() {
        let registry = ContentWindowGrantRegistry::default();
        registry.grant(FILE_L1, file_grant()).unwrap();
        registry.grant(FILE_L2, file_grant()).unwrap();
        let sessions = PtySessionManager::default();

        assert_eq!(
            cleanup_destroyed_window(FILE_L1, &registry, &sessions),
            Ok(DestroyedWindowCleanup {
                file_grant_revoked: true,
                owner_lost_session_ids: vec![],
            })
        );
        assert!(registry.get(FILE_L1).is_err());
        assert!(registry.get(FILE_L2).is_ok());

        // 幂等：同一窗口再次销毁不会再撤销。
        assert!(
            !cleanup_destroyed_window(FILE_L1, &registry, &sessions)
                .unwrap()
                .file_grant_revoked
        );
        // 反向断言：主窗与终端窗的销毁不会撤销任何文件授权。
        for label in ["main", TERM_T1] {
            assert_eq!(
                cleanup_destroyed_window(label, &registry, &sessions),
                Ok(DestroyedWindowCleanup::default())
            );
            assert!(registry.get(FILE_L2).is_ok());
        }
        // 窗口复用：撤销之后可以重新授权。
        assert!(registry.grant(FILE_L1, file_grant()).is_ok());
    }

    #[test]
    fn destroyed_non_terminal_or_invalid_windows_return_no_lost_sessions() {
        let registry = ContentWindowGrantRegistry::default();
        let sessions = PtySessionManager::default();

        for label in [TERM_T1, TERM_T2] {
            let cleanup = cleanup_destroyed_window(label, &registry, &sessions).unwrap();
            assert!(cleanup.owner_lost_session_ids.is_empty());
            assert!(!cleanup.file_grant_revoked);
        }
        for label in [
            "main",
            "terminal-invalid",
            "",
            "workspace-content-not-a-uuid",
        ] {
            assert_eq!(
                cleanup_destroyed_window(label, &registry, &sessions),
                Ok(DestroyedWindowCleanup::default()),
                "{label:?}"
            );
        }
        assert_eq!(sessions.active_count(), 0);
    }

    #[test]
    #[ignore = "待 m6-024 的 SEAM-04"]
    fn destroyed_terminal_owner_window_returns_owner_lost_sessions() {
        // 完整规格（来自测试规格 RS-T10），由 m6-024 在 SEAM-04（测试用 PTY 会话构造）
        // 落地后补全并删除 #[ignore]：
        // 前置：T1、T2 是两个合法的 terminal-<uuid>；会话 S1 所有者 T1，S2 所有者 T2，
        //   S3 所有者 main，各带一个 recording_channel()。
        // 步骤与断言：
        // 1. cleanup_destroyed_window(T1, …) 返回 owner_lost_session_ids == [S1.id]、
        //    file_grant_revoked == false；
        // 2. S1 的路由 window_label == "main"、owner_lost == true、channel.is_none()；
        // 3. S2、S3 的路由不变；
        // 4. 对 main 调用返回空列表；
        // 5. 对非法标签 terminal-invalid 调用返回空列表且不 panic。
        todo!("由 m6-024 在 SEAM-04 落地后补全并删除 #[ignore]")
    }

    #[test]
    fn lib_rs_delegates_exit_and_window_events_to_decision_functions() {
        let start = LIB_RS.find("fn handle_run_event").unwrap();
        let end = LIB_RS.find("fn show_main_window").unwrap();
        let run_event = &LIB_RS[start..end];
        assert!(run_event.contains("decide_exit_request("));
        assert!(!run_event.contains("consume_authorization"));
        assert!(run_event.contains("executionTaskCount"));
        assert!(LIB_RS.contains("cleanup_destroyed_window("));
        assert!(LIB_RS.contains("decide_close_request("));
        // 反向断言：旧的内联逻辑不能回来。
        assert!(!LIB_RS.contains(".reclaim_window("));
        assert!(!LIB_RS.contains("grants.revoke("));
        assert!(!LIB_RS.contains("window.label() != \"main\""));
    }

    #[test]
    fn exit_authorization_is_consumed_exactly_once() {
        let gate = AppExitGate::default();

        assert!(!gate.consume_authorization());
        gate.authorize();
        assert!(gate.consume_authorization());
        assert!(!gate.consume_authorization());
    }
}
