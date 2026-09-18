














pub const REDACT_BLOCK: &str = "〔已脱敏 · 个人记忆内容〕";

const SENSITIVE_TAGS: [(&str, &str); 3] = [
    ("<user_profile>", "</user_profile>"),
    ("<project_memory>", "</project_memory>"),
    ("<long_term_memory>", "</long_term_memory>"),
];



pub fn redact_sensitive(text: &str) -> (bool, String) {
    let mut out = text.to_string();
    let mut redacted = false;
    for (open, close) in SENSITIVE_TAGS {
        let (hit, next) = replace_blocks(&out, open, close);
        if hit {
            redacted = true;
            out = next;
        }
    }
    (redacted, out)
}


pub fn redact_owned(s: &str) -> String {
    redact_sensitive(s).1
}



fn replace_blocks(input: &str, open: &str, close: &str) -> (bool, String) {
    let mut result = String::with_capacity(input.len());
    let mut rest = input;
    let mut hit = false;
    loop {
        let Some(s) = find_ascii_ci(rest, open) else {
            result.push_str(rest);
            break;
        };
        let after = &rest[s + open.len()..];
        let Some(e) = find_ascii_ci(after, close) else {
            result.push_str(rest);
            break;
        };
        result.push_str(&rest[..s]);
        result.push_str(REDACT_BLOCK);
        hit = true;
        rest = &rest[s + open.len() + e + close.len()..];
    }
    (hit, result)
}



fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let hb = haystack.as_bytes();
    let nb = needle.as_bytes();
    let last = haystack.len() - needle.len();
    'outer: for i in 0..=last {
        for j in 0..nb.len() {
            if hb[i + j].to_ascii_lowercase() != nb[j].to_ascii_lowercase() {
                continue 'outer;
            }
        }
        return Some(i);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_profile_block_is_redacted() {
        let text = "我注意到<user_profile>用户喜欢简洁回答</user_profile>，于是调整语气。";
        let (hit, out) = redact_sensitive(text);
        assert!(hit);
        assert!(!out.contains("<user_profile>"));
        assert!(out.contains(REDACT_BLOCK));
        assert!(out.contains("我注意到"));
        assert!(out.contains("，于是调整语气。"));
    }

    #[test]
    fn block_spanning_lines_is_redacted() {
        let text = "复述如下：\n<project_memory>\n项目用 Tauri 2 + React 18\n</project_memory>\n以上。";
        let (hit, out) = redact_sensitive(text);
        assert!(hit);
        assert!(!out.contains("<project_memory>"));
        assert!(!out.contains("Tauri 2"));
        assert!(out.contains(REDACT_BLOCK));
    }

    #[test]
    fn tag_case_insensitive() {
        let text = "<USER_PROFILE>画像A</USER_PROFILE> 和 <Long_Term_Memory>画像B</Long_Term_Memory>";
        let (hit, out) = redact_sensitive(text);
        assert!(hit);
        assert_eq!(out.matches(REDACT_BLOCK).count(), 2);
    }

    #[test]
    fn all_three_tags_redacted() {
        let text = concat!(
            "<user_profile>A</user_profile>",
            "<project_memory>B</project_memory>",
            "<long_term_memory>C</long_term_memory>"
        );
        let (hit, out) = redact_sensitive(text);
        assert!(hit);
        assert_eq!(out.matches(REDACT_BLOCK).count(), 3);
        assert_eq!(out, format!("{}{}{}", REDACT_BLOCK, REDACT_BLOCK, REDACT_BLOCK));
    }

    #[test]
    fn multiple_hits_same_tag_all_redacted() {
        let text = "<user_profile>A</user_profile> 中间 <user_profile>B</user_profile> 尾部";
        let (hit, out) = redact_sensitive(text);
        assert!(hit);
        assert_eq!(out.matches(REDACT_BLOCK).count(), 2);
        assert!(out.contains("中间"));
        assert!(out.contains("尾部"));
    }

    #[test]
    fn unclosed_tag_left_untouched() {
        
        let text = "提到 <user_profile> 但没有闭合";
        let (hit, out) = redact_sensitive(text);
        assert!(!hit);
        assert_eq!(out, text);
    }

    #[test]
    fn plain_text_unchanged() {
        let text = "没有敏感内容的普通文本，包含 <code> 与 </user_profile> 字样也无妨。";
        let (hit, out) = redact_sensitive(text);
        assert!(!hit);
        assert_eq!(out, text);
    }

    #[test]
    fn empty_text_noop() {
        let (hit, out) = redact_sensitive("");
        assert!(!hit);
        assert_eq!(out, "");
    }
}
