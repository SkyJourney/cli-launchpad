//! serde 源码扫描 lint：带 `Serialize` 的类型里，含 `_` 的字段名必须声明 camelCase 重命名。
//!
//! 只用字符串操作实现，不依赖 `regex`。算法：先把注释、字符串字面量（含原始字符串）、
//! 字符字面量替换成空格得到“掩码文本”（长度与位置不变），结构分析（花括号配对、条目识别）
//! 都在掩码文本上做；属性文本取自原文，因为 `rename_all = "camelCase"` 的值在字符串里。

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SerdeLintViolation {
    pub file: String,
    pub item: String,
    pub detail: String,
}

pub(crate) fn scan_serialize_items(source: &str, file: &str) -> Vec<SerdeLintViolation> {
    let original: Vec<char> = source.chars().collect();
    let masked = mask_non_code(&original);
    let mut violations = Vec::new();
    let mut attrs = String::new();
    let mut index = 0;

    while index < masked.len() {
        let current = masked[index];
        if current.is_whitespace() {
            index += 1;
            continue;
        }
        if current == '#' {
            let open = if masked.get(index + 1) == Some(&'!') {
                index + 2
            } else {
                index + 1
            };
            if masked.get(open) == Some(&'[') {
                if let Some(close) = matching(&masked, open, '[', ']') {
                    attrs.extend(&original[open..=close]);
                    attrs.push('\n');
                    index = close + 1;
                    continue;
                }
            }
        }
        if !is_ident_start(current) {
            attrs.clear();
            index += 1;
            continue;
        }

        let word_end = ident_end(&masked, index);
        let mut keyword_start = index;
        let mut keyword_end = word_end;
        if text(&masked, index, word_end) == "pub" {
            let mut cursor = skip_whitespace(&masked, word_end);
            if masked.get(cursor) == Some(&'(') {
                if let Some(close) = matching(&masked, cursor, '(', ')') {
                    cursor = skip_whitespace(&masked, close + 1);
                }
            }
            if masked.get(cursor).is_some_and(|c| is_ident_start(*c)) {
                keyword_start = cursor;
                keyword_end = ident_end(&masked, cursor);
            }
        }
        let keyword = text(&masked, keyword_start, keyword_end);

        match keyword.as_str() {
            "struct" | "enum" => {
                let consumed = scan_item(
                    &masked,
                    &original,
                    keyword_end,
                    keyword == "enum",
                    &attrs,
                    file,
                    &mut violations,
                );
                attrs.clear();
                index = consumed.max(keyword_end);
            }
            "mod" if attrs_are_cfg_test(&attrs) => {
                // 测试模块整体剔除；`mod x;` 没有花括号，只清空属性。
                let name_start = skip_whitespace(&masked, keyword_end);
                let name_end = ident_end(&masked, name_start);
                let after_name = skip_whitespace(&masked, name_end);
                attrs.clear();
                index = if masked.get(after_name) == Some(&'{') {
                    matching(&masked, after_name, '{', '}').map_or(masked.len(), |close| close + 1)
                } else {
                    after_name
                };
            }
            _ => {
                attrs.clear();
                index = keyword_end;
            }
        }
    }
    violations
}

fn scan_item(
    masked: &[char],
    original: &[char],
    after_keyword: usize,
    is_enum: bool,
    attrs: &str,
    file: &str,
    violations: &mut Vec<SerdeLintViolation>,
) -> usize {
    let name_start = skip_whitespace(masked, after_keyword);
    let name_end = ident_end(masked, name_start);
    if name_end == name_start {
        return after_keyword;
    }
    let name = text(masked, name_start, name_end);

    // 名称之后第一个 `{`、`;`、`(`：不是 `{` 的（元组结构体、单元结构体）跳过。
    let mut cursor = name_end;
    while cursor < masked.len() && !matches!(masked[cursor], '{' | ';' | '(') {
        cursor += 1;
    }
    if masked.get(cursor) != Some(&'{') {
        return cursor;
    }
    let Some(close) = matching(masked, cursor, '{', '}') else {
        return masked.len();
    };
    if !derives_serialize(attrs) {
        return close + 1;
    }

    if is_enum {
        for (start, end) in top_level_segments(masked, cursor + 1, close) {
            let (variant_attrs, variant_start) = leading_attributes(masked, original, start, end);
            let variant_name_start = skip_whitespace(masked, variant_start);
            let variant_name_end = ident_end(masked, variant_name_start);
            if variant_name_end == variant_name_start {
                continue;
            }
            let after = skip_whitespace(masked, variant_name_end);
            if after >= end || masked[after] != '{' {
                continue;
            }
            let Some(variant_close) = matching(masked, after, '{', '}') else {
                continue;
            };
            let flagged = flagged_fields(masked, original, after + 1, variant_close);
            if flagged.is_empty()
                || has_assignment(attrs, "rename_all_fields", "camelCase")
                || has_assignment(&variant_attrs, "rename_all", "camelCase")
            {
                continue;
            }
            violations.push(SerdeLintViolation {
                file: file.to_string(),
                item: format!("{name}::{}", text(masked, variant_name_start, variant_name_end)),
                detail: format!(
                    "字段 {} 含下划线，枚举变体缺少 rename_all_fields = \"camelCase\"（或字段级 rename）",
                    flagged.join("、")
                ),
            });
        }
    } else {
        let flagged = flagged_fields(masked, original, cursor + 1, close);
        if !flagged.is_empty() && !has_assignment(attrs, "rename_all", "camelCase") {
            violations.push(SerdeLintViolation {
                file: file.to_string(),
                item: name,
                detail: format!(
                    "字段 {} 含下划线，结构体缺少 rename_all = \"camelCase\"（或字段级 rename）",
                    flagged.join("、")
                ),
            });
        }
    }
    close + 1
}

/// `[start, end)` 内含 `_` 且没有字段级 `rename`/`skip`/`flatten` 的字段名。
fn flagged_fields(masked: &[char], original: &[char], start: usize, end: usize) -> Vec<String> {
    let mut flagged = Vec::new();
    for (segment_start, segment_end) in top_level_segments(masked, start, end) {
        let (field_attrs, field_start) =
            leading_attributes(masked, original, segment_start, segment_end);
        let mut cursor = skip_whitespace(masked, field_start);
        if cursor >= segment_end || !is_ident_start(masked[cursor]) {
            continue;
        }
        let mut word_end = ident_end(masked, cursor);
        if text(masked, cursor, word_end) == "pub" {
            cursor = skip_whitespace(masked, word_end);
            if masked.get(cursor) == Some(&'(') {
                if let Some(close) = matching(masked, cursor, '(', ')') {
                    cursor = skip_whitespace(masked, close + 1);
                }
            }
            if cursor >= segment_end || !is_ident_start(masked[cursor]) {
                continue;
            }
            word_end = ident_end(masked, cursor);
        }
        let field_name = text(masked, cursor, word_end);
        let after = skip_whitespace(masked, word_end);
        let is_field = masked.get(after) == Some(&':') && masked.get(after + 1) != Some(&':');
        if !is_field || !field_name.contains('_') {
            continue;
        }
        let exempt = has_word(&field_attrs, "rename")
            || has_word(&field_attrs, "skip")
            || has_word(&field_attrs, "skip_serializing")
            || has_word(&field_attrs, "flatten");
        if !exempt {
            flagged.push(field_name);
        }
    }
    flagged
}

/// 把 `[start, end)` 按顶层逗号切段（括号、方括号、花括号、泛型尖括号内的逗号不算）。
fn top_level_segments(masked: &[char], start: usize, end: usize) -> Vec<(usize, usize)> {
    let mut segments = Vec::new();
    let mut depth = 0i32;
    let mut segment_start = start;
    let mut index = start;
    while index < end {
        match masked[index] {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            '<' => depth += 1,
            '>' => {
                // `->` 与 `=>` 的 `>` 不是泛型闭合。
                let arrow = index > start && matches!(masked[index - 1], '-' | '=');
                if !arrow {
                    depth -= 1;
                }
            }
            ',' if depth == 0 => {
                segments.push((segment_start, index));
                segment_start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    if segment_start < end {
        segments.push((segment_start, end));
    }
    segments
}

/// 读取 `[start, end)` 开头连续的 `#[...]`，返回（属性原文, 属性之后的位置）。
fn leading_attributes(
    masked: &[char],
    original: &[char],
    start: usize,
    end: usize,
) -> (String, usize) {
    let mut attrs = String::new();
    let mut cursor = skip_whitespace(masked, start);
    while cursor + 1 < end && masked[cursor] == '#' && masked[cursor + 1] == '[' {
        let Some(close) = matching(masked, cursor + 1, '[', ']') else {
            break;
        };
        attrs.extend(&original[cursor + 1..=close]);
        attrs.push('\n');
        cursor = skip_whitespace(masked, close + 1);
    }
    (attrs, cursor)
}

fn derives_serialize(attrs: &str) -> bool {
    let chars: Vec<char> = attrs.chars().collect();
    let pattern: Vec<char> = "derive".chars().collect();
    let mut index = 0;
    while index + pattern.len() <= chars.len() {
        let hit = chars[index..index + pattern.len()] == pattern[..]
            && (index == 0 || !is_ident_char(chars[index - 1]));
        if hit {
            let open = skip_whitespace(&chars, index + pattern.len());
            if chars.get(open) == Some(&'(') {
                if let Some(close) = matching(&chars, open, '(', ')') {
                    let inner: String = chars[open + 1..close].iter().collect();
                    if has_word(&inner, "Serialize") {
                        return true;
                    }
                }
            }
        }
        index += 1;
    }
    false
}

fn attrs_are_cfg_test(attrs: &str) -> bool {
    attrs.split('\n').any(|line| {
        let compact: String = line.chars().filter(|c| !c.is_whitespace()).collect();
        compact == "[cfg(test)]"
    })
}

/// `key = "value"`（key 必须是完整单词，所以 `rename_all` 不会匹配 `rename_all_fields`）。
fn has_assignment(attrs: &str, key: &str, value: &str) -> bool {
    let chars: Vec<char> = attrs.chars().collect();
    let key_chars: Vec<char> = key.chars().collect();
    let mut index = 0;
    while index + key_chars.len() <= chars.len() {
        if chars[index..index + key_chars.len()] == key_chars[..] {
            let before_ok = index == 0 || !is_ident_char(chars[index - 1]);
            let after = index + key_chars.len();
            let after_ok = chars.get(after).is_none_or(|c| !is_ident_char(*c));
            if before_ok && after_ok {
                let equals = skip_whitespace(&chars, after);
                if chars.get(equals) == Some(&'=') {
                    let quote = skip_whitespace(&chars, equals + 1);
                    let expected: Vec<char> = format!("\"{value}\"").chars().collect();
                    if chars.get(quote..quote + expected.len()) == Some(&expected[..]) {
                        return true;
                    }
                }
            }
        }
        index += 1;
    }
    false
}

fn has_word(haystack: &str, word: &str) -> bool {
    let chars: Vec<char> = haystack.chars().collect();
    let needle: Vec<char> = word.chars().collect();
    let mut index = 0;
    while index + needle.len() <= chars.len() {
        if chars[index..index + needle.len()] == needle[..] {
            let before_ok = index == 0 || !is_ident_char(chars[index - 1]);
            let after_ok = chars
                .get(index + needle.len())
                .is_none_or(|c| !is_ident_char(*c));
            if before_ok && after_ok {
                return true;
            }
        }
        index += 1;
    }
    false
}

/// 把注释、字符串（含原始字符串）、字符字面量替换成空格（保留换行），长度与位置不变。
fn mask_non_code(chars: &[char]) -> Vec<char> {
    let mut masked = chars.to_vec();
    let blank = |masked: &mut Vec<char>, from: usize, to: usize| {
        for slot in masked.iter_mut().take(to.min(chars.len())).skip(from) {
            if *slot != '\n' {
                *slot = ' ';
            }
        }
    };
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        let next = chars.get(index + 1).copied();
        if current == '/' && next == Some('/') {
            let start = index;
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            blank(&mut masked, start, index);
            continue;
        }
        if current == '/' && next == Some('*') {
            let start = index;
            let mut depth = 1usize;
            index += 2;
            while index < chars.len() && depth > 0 {
                if chars[index] == '/' && chars.get(index + 1) == Some(&'*') {
                    depth += 1;
                    index += 2;
                } else if chars[index] == '*' && chars.get(index + 1) == Some(&'/') {
                    depth -= 1;
                    index += 2;
                } else {
                    index += 1;
                }
            }
            blank(&mut masked, start, index);
            continue;
        }
        if let Some(end) = raw_string_end(chars, index) {
            blank(&mut masked, index, end);
            index = end;
            continue;
        }
        if current == '"' {
            let start = index;
            index += 1;
            while index < chars.len() {
                if chars[index] == '\\' {
                    index += 2;
                    continue;
                }
                if chars[index] == '"' {
                    index += 1;
                    break;
                }
                index += 1;
            }
            blank(&mut masked, start, index);
            continue;
        }
        if current == '\'' {
            if next == Some('\\') {
                // 转义字符字面量：`'\''`、`'\n'`、`'\u{1F600}'`。
                let start = index;
                let mut cursor = index + 3;
                while cursor < chars.len() && chars[cursor] != '\'' {
                    cursor += 1;
                }
                index = (cursor + 1).min(chars.len());
                blank(&mut masked, start, index);
                continue;
            }
            if chars.get(index + 2) == Some(&'\'') {
                blank(&mut masked, index, index + 3);
                index += 3;
                continue;
            }
            // 生命周期或标签，不是字面量。
        }
        index += 1;
    }
    masked
}

/// 从 `index` 开始若是原始字符串（`r"…"`、`r#"…"#`，可带 `b` 前缀），返回结束位置（含）之后一位。
fn raw_string_end(chars: &[char], index: usize) -> Option<usize> {
    let mut cursor = index;
    if chars.get(cursor) == Some(&'b') && chars.get(cursor + 1) == Some(&'r') {
        cursor += 1;
    }
    if chars.get(cursor) != Some(&'r') {
        return None;
    }
    if index > 0 && is_ident_char(chars[index - 1]) {
        return None;
    }
    cursor += 1;
    let mut hashes = 0;
    while chars.get(cursor) == Some(&'#') {
        hashes += 1;
        cursor += 1;
    }
    if chars.get(cursor) != Some(&'"') {
        return None;
    }
    cursor += 1;
    while cursor < chars.len() {
        if chars[cursor] == '"' {
            let closing = (0..hashes).all(|offset| chars.get(cursor + 1 + offset) == Some(&'#'));
            if closing {
                return Some(cursor + 1 + hashes);
            }
        }
        cursor += 1;
    }
    Some(chars.len())
}

fn matching(chars: &[char], open_index: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    for (offset, character) in chars[open_index..].iter().enumerate() {
        if *character == open {
            depth += 1;
        } else if *character == close {
            depth -= 1;
            if depth == 0 {
                return Some(open_index + offset);
            }
        }
    }
    None
}

fn is_ident_start(character: char) -> bool {
    character.is_ascii_alphabetic() || character == '_'
}

fn is_ident_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

fn ident_end(chars: &[char], start: usize) -> usize {
    let mut index = start;
    while index < chars.len() && is_ident_char(chars[index]) {
        index += 1;
    }
    index
}

fn skip_whitespace(chars: &[char], start: usize) -> usize {
    let mut index = start;
    while index < chars.len() && chars[index].is_whitespace() {
        index += 1;
    }
    index
}

fn text(chars: &[char], start: usize, end: usize) -> String {
    chars[start..end.min(chars.len())].iter().collect()
}
