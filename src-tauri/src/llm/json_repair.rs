













pub fn repair_json(input: &str) -> String {
    let mut s = input.to_string();

    
    
    
    
    s = normalize_quotes(&s);

    
    
    
    
    s = escape_control_in_strings(&s);

    
    
    
    s = fix_missing_colons(&s);

    
    s = s.replace(",}", "}").replace(",]", "]");

    s
}







pub fn normalize_quotes(input: &str) -> String {
    let bytes = input.as_bytes();
    
    
    
    
    let mut out: Vec<u8> = Vec::with_capacity(input.len());
    let mut in_str: Option<u8> = None;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match in_str {
            None => {
                if b == b'"' || b == b'\'' {
                    in_str = Some(b);
                    out.push(b'"');
                } else {
                    out.push(b);
                }
                i += 1;
            }
            Some(delim) => {
                if b == b'\\' {
                    
                    out.push(b'\\');
                    if i + 1 < bytes.len() {
                        out.push(bytes[i + 1]);
                        i += 2;
                    } else {
                        i += 1;
                    }
                } else if b == delim {
                    in_str = None;
                    out.push(b'"');
                    i += 1;
                } else {
                    out.push(b);
                    i += 1;
                }
            }
        }
    }
    
    String::from_utf8_lossy(&out).into_owned()
}









pub fn escape_control_in_strings(input: &str) -> String {
    let bytes = input.as_bytes();
    
    let mut out: Vec<u8> = Vec::with_capacity(input.len());
    let mut in_string = false;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            if b == b'\\' {
                
                out.push(b'\\');
                if i + 1 < bytes.len() {
                    out.push(bytes[i + 1]);
                    i += 2;
                } else {
                    i += 1;
                }
                continue;
            }
            if b == b'"' {
                in_string = false;
                out.push(b'"');
                i += 1;
                continue;
            }
            if b == b'\n' {
                out.extend_from_slice(b"\\n");
                i += 1;
                continue;
            }
            if b == b'\r' {
                out.extend_from_slice(b"\\r");
                i += 1;
                continue;
            }
            if b == b'\t' {
                out.extend_from_slice(b"\\t");
                i += 1;
                continue;
            }
            if b < 0x20 {
                
                out.extend_from_slice(format!("\\u{:04x}", b).as_bytes());
                i += 1;
                continue;
            }
            out.push(b);
            i += 1;
        } else if b == b'"' {
            in_string = true;
            out.push(b'"');
            i += 1;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}








pub fn fix_missing_colons(s: &str) -> String {
    let bytes = s.as_bytes();
    
    let mut result: Vec<u8> = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            
            match find_closing_quote(bytes, i + 1) {
                Some(a_close) => {
                    
                    result.extend_from_slice(&bytes[i..=a_close]);

                    
                    let mut j = a_close + 1;
                    while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                        j += 1;
                    }
                    if j < bytes.len() && bytes[j] == b'"' {
                        
                        let b_empty = find_closing_quote(bytes, j + 1) == Some(j + 1);
                        if !b_empty && is_object_key(s, i) {
                            
                            
                            result.extend_from_slice(b": \"");
                            i = j + 1;
                            continue;
                        }
                    }
                    i = a_close + 1;
                    continue;
                }
                None => {
                    
                    result.extend_from_slice(&bytes[i..]);
                    break;
                }
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&result).into_owned()
}


pub fn find_closing_quote(bytes: &[u8], from: usize) -> Option<usize> {
    let mut k = from;
    while k < bytes.len() {
        if bytes[k] == b'\\' {
            k += 2; 
            continue;
        }
        if bytes[k] == b'"' {
            return Some(k);
        }
        k += 1;
    }
    None
}



pub fn is_object_key(s: &str, open_quote_index: usize) -> bool {
    let bytes = s.as_bytes();
    if open_quote_index == 0 {
        return true;
    }
    
    let mut p = open_quote_index as isize - 1;
    while p >= 0 && bytes[p as usize] != b'"' {
        p -= 1;
    }
    if p <= 0 {
        return true;
    }
    
    let mut q = p - 1;
    while q >= 0 && bytes[q as usize].is_ascii_whitespace() {
        q -= 1;
    }
    if q < 0 {
        return true;
    }
    matches!(bytes[q as usize], b'{' | b',' | b'[')
}






pub fn coerce_tool_args(name: &str, raw: &str, parsed: serde_json::Value) -> serde_json::Value {
    match parsed {
        serde_json::Value::Object(_) => parsed,
        serde_json::Value::String(s) => wrap_path_or_command(name, s),
        _ => wrap_raw_args(name, raw),
    }
}


pub fn wrap_path_or_command(name: &str, value: String) -> serde_json::Value {
    if is_filesystem_tool(name) {
        serde_json::json!({ "path": value })
    } else {
        serde_json::json!({ "command": value })
    }
}


pub fn wrap_raw_args(name: &str, raw: &str) -> serde_json::Value {
    let trimmed = raw.trim();
    if is_filesystem_tool(name) {
        serde_json::json!({ "path": trimmed })
    } else {
        serde_json::json!({ "command": trimmed })
    }
}


pub fn is_filesystem_tool(name: &str) -> bool {
    matches!(name, "read_file" | "write_file" | "list_dir")
}




pub fn read_simple_field(s: &str, key: &str) -> Option<String> {
    let marker = format!("\"{}\"", key);
    let idx = s.find(&marker)? + marker.len();
    let rest = &s[idx..];
    let colon = rest.find(':')? + 1;
    let after = &rest[colon..];
    let bytes = after.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= bytes.len() || bytes[i] != b'"' {
        return None;
    }
    i += 1;
    
    let mut out: Vec<u8> = Vec::new();
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' {
            out.push(b'\\');
            if i + 1 < bytes.len() {
                out.push(bytes[i + 1]);
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if b == b'"' {
            return Some(String::from_utf8_lossy(&out).into_owned());
        }
        out.push(b);
        i += 1;
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}








pub fn read_terminal_field(s: &str, key: &str) -> Option<String> {
    let marker = format!("\"{}\"", key);
    let idx = s.find(&marker)? + marker.len();
    let rest = &s[idx..];
    let colon = rest.find(':')? + 1;
    let after = &rest[colon..];
    let bytes = after.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= bytes.len() || bytes[i] != b'"' {
        return None;
    }
    i += 1;
    let mut depth: i32 = 0;
    
    
    let mut out: Vec<u8> = Vec::new();
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' {
            out.push(b'\\');
            if i + 1 < bytes.len() {
                out.push(bytes[i + 1]);
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if b == b'"' {
            
            
            
            let remainder = after[i + 1..].trim_start();
            if depth <= 0 && (remainder.starts_with('}') || remainder.starts_with(']')) {
                return Some(String::from_utf8_lossy(&out).into_owned());
            }
            out.push(b'"');
            i += 1;
            continue;
        }
        if b == b'{' {
            depth += 1;
        } else if b == b'}' {
            depth -= 1;
        }
        out.push(b);
        i += 1;
    }
    
    Some(String::from_utf8_lossy(&out).into_owned())
}





pub fn extract_tool_args_tolerant(name: &str, raw: &str) -> serde_json::Value {
    match name {
        "write_file" => {
            let path = read_simple_field(raw, "path");
            let content = read_terminal_field(raw, "content");
            let mut obj = serde_json::Map::new();
            if let Some(p) = path {
                obj.insert("path".into(), serde_json::Value::String(p));
            }
            if let Some(c) = content {
                obj.insert("content".into(), serde_json::Value::String(c));
            }
            if obj.is_empty() {
                serde_json::json!({ "path": raw.trim() })
            } else {
                serde_json::Value::Object(obj)
            }
        }
        "run_shell" => match read_terminal_field(raw, "command") {
            Some(cmd) => serde_json::json!({ "command": cmd }),
            None => serde_json::json!({ "command": raw.trim() }),
        },
        _ => match read_simple_field(raw, "path") {
            Some(p) => serde_json::json!({ "path": p }),
            None => serde_json::json!({ "path": raw.trim() }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn parse(input: &str) -> Value {
        let repaired = repair_json(input);
        serde_json::from_str(&repaired).expect("repaired JSON must parse")
    }

    #[test]
    fn missing_colon_is_fixed() {
        let v = parse(r#"{"path" "/Users/foo/bar.txt"}"#);
        assert_eq!(v["path"], "/Users/foo/bar.txt");
    }

    
    
    
    

    #[test]
    fn repair_preserves_multibyte_utf8() {
        
        
        
        
        let v = parse(r#"{'title' '正在读取配置 中文 emoji 🚀 混排'}"#);
        assert_eq!(v["title"], "正在读取配置 中文 emoji 🚀 混排");
    }

    #[test]
    fn normalize_quotes_keeps_chinese_intact() {
        assert_eq!(normalize_quotes("{'k': '中文'}"), r#"{"k": "中文"}"#);
    }

    #[test]
    fn escape_control_keeps_chinese_intact() {
        
        let out = escape_control_in_strings("{\"c\": \"第一行\n第二行\"}");
        assert_eq!(out, r#"{"c": "第一行\n第二行"}"#);
    }

    #[test]
    fn terminal_field_keeps_chinese_intact() {
        
        let got = read_terminal_field(r##"{"path":"a.md","content":"# 标题\n正文内容"}"##, "content");
        assert_eq!(got.as_deref(), Some(r"# 标题\n正文内容"));
    }

    #[test]
    fn empty_string_value_is_not_corrupted() {
        
        let v = parse(r#"{"mode": ""}"#);
        assert_eq!(v["mode"], "");
        
        let v2 = parse(r#"{"path": "/x", "mode": ""}"#);
        assert_eq!(v2["path"], "/x");
        assert_eq!(v2["mode"], "");
    }

    #[test]
    fn missing_colon_with_empty_value_is_not_corrupted() {
        let v = parse(r#"{"path": "/x", "mode": ""}"#);
        assert_eq!(v["path"], "/x");
        assert_eq!(v["mode"], "");
    }

    #[test]
    fn bare_string_path_is_wrapped_for_fs_tool() {
        let v = coerce_tool_args(
            "read_file",
            "\"/p/foo.txt\"",
            Value::String("/p/foo.txt".into()),
        );
        assert_eq!(v["path"], "/p/foo.txt");
    }

    #[test]
    fn bare_string_is_wrapped_as_command_for_shell() {
        let v = coerce_tool_args("run_shell", "\"ls -la\"", Value::String("ls -la".into()));
        assert_eq!(v["command"], "ls -la");
    }

    #[test]
    fn unquoted_bare_path_falls_back_to_path() {
        let v = wrap_raw_args("read_file", "/Users/foo/bar.txt ");
        assert_eq!(v["path"], "/Users/foo/bar.txt");
    }

    #[test]
    fn nested_object_value_survives() {
        let v = parse(r#"{"path": "/x", "opts": {"recursive": true}}"#);
        assert_eq!(v["path"], "/x");
        assert_eq!(v["opts"]["recursive"], true);
    }

    #[test]
    fn literal_newline_in_content_is_escaped() {
        
        
        let raw = "{\"path\": \"/x/y.txt\", \"content\": \"line1\nline2\nline3\"}";
        let v = parse(raw);
        assert_eq!(v["path"], "/x/y.txt");
        assert_eq!(v["content"], "line1\nline2\nline3");
    }

    #[test]
    fn write_file_content_with_newlines_survives_coercion() {
        let raw = "{\"path\": \"/x/y.txt\", \"content\": \"a\nb\"}";
        let repaired = repair_json(raw);
        let parsed: Value = serde_json::from_str(&repaired).expect("must parse after repair");
        let v = coerce_tool_args("write_file", raw, parsed);
        assert_eq!(v["path"], "/x/y.txt");
        assert_eq!(v["content"], "a\nb");
    }

    #[test]
    fn single_quoted_delimiters_are_normalized() {
        
        let raw = "{'path': '/x/y.txt', 'content': 'hi'}";
        let v = parse(raw);
        assert_eq!(v["path"], "/x/y.txt");
        assert_eq!(v["content"], "hi");
    }

    #[test]
    fn apostrophe_inside_content_is_preserved() {
        
        let raw = "{\"content\": \"font-family: 'Segoe UI', sans-serif\"}";
        let v = parse(raw);
        assert_eq!(v["content"], "font-family: 'Segoe UI', sans-serif");
    }

    #[test]
    fn real_world_write_file_raw_recovers_content() {
        
        
        let raw = "{\"path\": \"/root/app/index.html\", \"content\": \"<!DOCTYPE html>\n<head>\n  <style>\n    body { font-family: 'Segoe UI'; }\n  </style>\n</head>\n\"}";
        let repaired = repair_json(raw);
        let parsed: Value = serde_json::from_str(&repaired).expect("must parse after repair");
        let v = coerce_tool_args("write_file", raw, parsed);
        assert_eq!(v["path"], "/root/app/index.html");
        assert!(v["content"].as_str().unwrap().contains("'Segoe UI'"));
        assert!(v["content"].as_str().unwrap().contains("</head>"));
    }

    #[test]
    fn unescaped_quote_in_content_recovered_by_tolerant_extract() {
        
        
        
        let raw = "{\"path\": \"/tmp/a.html\", \"content\": \"<div class=\"x\">hi</div>\"}";
        assert!(
            serde_json::from_str::<Value>(raw).is_err(),
            "setup: input must be invalid JSON"
        );
        let v = extract_tool_args_tolerant("write_file", raw);
        assert_eq!(v["path"], "/tmp/a.html");
        assert_eq!(v["content"], "<div class=\"x\">hi</div>");
    }

    #[test]
    fn nested_braces_in_content_recovered() {
        
        
        let raw = "{\"path\": \"/tmp/b.html\", \"content\": \"<script>const o = {a: 1, b: \"x\"};</script>\"}";
        assert!(
            serde_json::from_str::<Value>(raw).is_err(),
            "setup: input must be invalid JSON"
        );
        let v = extract_tool_args_tolerant("write_file", raw);
        assert_eq!(v["path"], "/tmp/b.html");
        assert!(v["content"]
            .as_str()
            .unwrap()
            .contains("const o = {a: 1, b: \"x\"}"));
    }

    #[test]
    fn shell_command_with_embedded_quotes_recovered() {
        let raw = "{\"command\": \"echo \"hello world\" && ls -la\"}";
        assert!(
            serde_json::from_str::<Value>(raw).is_err(),
            "setup: input must be invalid JSON"
        );
        let v = extract_tool_args_tolerant("run_shell", raw);
        assert_eq!(v["command"], "echo \"hello world\" && ls -la");
    }

    #[test]
    fn run_shell_tolerant_handles_balanced_array_close() {
        
        
        let raw = "[{\"command\": \"echo hi\"}]";
        let v = extract_tool_args_tolerant("run_shell", raw);
        assert_eq!(v["command"], "echo hi");
    }
}
