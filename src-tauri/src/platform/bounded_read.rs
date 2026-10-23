//! Bounded whole-file reads. A file over the limit is reported as `file.too_large`.

use std::io::Read;

use anyhow::Result;

use crate::domain_errors::FileError;

/// Reads at most `maximum_bytes` bytes. One byte more is `FileError::TooLarge`.
pub fn read_bounded(reader: impl Read, maximum_bytes: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(maximum_bytes.min(64 * 1024) as usize);
    reader
        .take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum_bytes {
        return Err(FileError::TooLarge {
            max_bytes: maximum_bytes,
        }
        .into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppError;
    use std::io::Cursor;

    #[test]
    fn reads_content_up_to_the_limit() {
        assert_eq!(
            read_bounded(Cursor::new(vec![b'x'; 10]), 10).unwrap().len(),
            10
        );
        assert!(read_bounded(Cursor::new(Vec::<u8>::new()), 10)
            .unwrap()
            .is_empty());
        // 反向：上限为 0 时空内容读取成功。
        assert!(read_bounded(Cursor::new(Vec::<u8>::new()), 0)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_content_one_byte_over_the_limit_as_file_too_large() {
        let error = read_bounded(Cursor::new(vec![b'x'; 11]), 10).unwrap_err();
        let value = serde_json::to_value(AppError::from(error)).unwrap();
        assert_eq!(value["code"], "file.too_large");
        assert_eq!(value["params"]["maxBytes"], 10);
        // 反向：恰好 10 字节不报错。
        assert!(read_bounded(Cursor::new(vec![b'x'; 10]), 10).is_ok());
    }
}
