use crate::error_codes::ErrorCode;
use std::{
    io::Write,
    sync::mpsc::{self, Receiver, SyncSender, TrySendError},
    thread,
};

use anyhow::Result;

use crate::AppError;

pub(super) const PTY_INPUT_QUEUE_CAPACITY: usize = 32;
pub(super) const MAX_PTY_INPUT_BYTES: usize = 64 * 1024;

pub(super) fn enqueue_pty_input(sender: &SyncSender<Vec<u8>>, data: &[u8]) -> Result<(), AppError> {
    if data.len() > MAX_PTY_INPUT_BYTES {
        return Err(AppError::coded(
            ErrorCode::PtyInputBackpressure,
            "终端输入片段超过安全上限，请分段粘贴",
        ));
    }
    match sender.try_send(data.to_vec()) {
        Ok(()) => Ok(()),
        Err(TrySendError::Full(_)) => Err(AppError::coded(
            ErrorCode::PtyInputBackpressure,
            "终端输入队列已满，请稍后重试",
        )),
        Err(TrySendError::Disconnected(_)) => Err(AppError::coded(
            ErrorCode::PtyInputUnavailable,
            "终端输入通道已关闭，请重新连接会话",
        )),
    }
}

pub(super) fn pty_input_channel() -> (SyncSender<Vec<u8>>, Receiver<Vec<u8>>) {
    mpsc::sync_channel(PTY_INPUT_QUEUE_CAPACITY)
}

pub(super) fn start_pty_input_writer(
    mut writer: Box<dyn Write + Send>,
    receiver: Receiver<Vec<u8>>,
    session_id: String,
) -> std::io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name(format!("pty-input-{session_id}"))
        .spawn(move || {
            while let Ok(data) = receiver.recv() {
                if let Err(error) = writer.write_all(&data).and_then(|()| writer.flush()) {
                    log::error!("PTY input write failed session_id={session_id} error={error}");
                    break;
                }
            }
        })
}
