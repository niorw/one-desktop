













use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};


const ALLOWED_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg",
    "pdf", "txt", "md", "csv", "json", "log", "html",
];

const MAX_BYTES: usize = 20 * 1024 * 1024;


fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: [i16; 256] = build_table();
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buf: [u8; 4] = [0; 4];
    let mut n = 0usize;
    let mut pads = 0usize; 
    for &c in input.as_bytes() {
        if c == b' ' || c == b'\n' || c == b'\r' || c == b'\t' {
            continue; 
        }
        let v = TABLE[c as usize];
        if v < 0 {
            if c == b'=' && n >= 2 {
                pads += 1;
                buf[n] = 0;
                n += 1;
                if n == 4 {
                    push_triplet(&mut out, &buf)?;
                    n = 0;
                }
                continue;
            }
            return Err(format!("非法的 base64 字符: {:?}", c as char));
        }
        buf[n] = v as u8;
        n += 1;
        if n == 4 {
            push_triplet(&mut out, &buf)?;
            n = 0;
        }
    }
    
    if n == 2 {
        out.push((buf[0] << 2) | (buf[1] >> 4));
    } else if n == 3 {
        out.push((buf[0] << 2) | (buf[1] >> 4));
        out.push(((buf[1] & 0x0f) << 4) | (buf[2] >> 2));
    } else if n != 0 {
        return Err("base64 长度非法".into());
    }
    
    if pads > 0 && pads <= out.len() {
        out.truncate(out.len() - pads);
    }
    Ok(out)
}

const fn build_table() -> [i16; 256] {
    let mut t = [-1i16; 256];
    let mut i = 0;
    while i < 256 {
        let c = i as u8;
        let v = match c {
            b'A'..=b'Z' => (c - b'A') as i16,
            b'a'..=b'z' => (c - b'a') as i16 + 26,
            b'0'..=b'9' => (c - b'0') as i16 + 52,
            b'+' => 62,
            b'/' => 63,
            _ => -1,
        };
        t[i] = v;
        i += 1;
    }
    t
}

fn push_triplet(out: &mut Vec<u8>, buf: &[u8; 4]) -> Result<(), String> {
    let n = (buf[0] as u32) << 18 | (buf[1] as u32) << 12 | (buf[2] as u32) << 6 | buf[3] as u32;
    out.push((n >> 16) as u8);
    out.push((n >> 8) as u8);
    out.push(n as u8);
    Ok(())
}



fn sanitize_file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("paste").trim();
    if base.is_empty() {
        return "paste".to_string();
    }
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "paste".to_string()
    } else {
        cleaned.to_string()
    }
}


fn ext_allowed(name: &str) -> bool {
    let ext = name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    !ext.is_empty() && ALLOWED_EXT.contains(&ext.as_str())
}





#[tauri::command]
pub fn save_paste_attachment(data_b64: String, file_name: String) -> Result<String, String> {
    let mut _g = crate::commands::CmdLog::begin("save_paste_attachment", &[
        ("name", file_name.clone()),
        ("b64_len", data_b64.len().to_string()),
    ]);
    let name = sanitize_file_name(&file_name);
    if !ext_allowed(&name) {
        return Err(format!("不支持的文件类型：{}", name));
    }
    let bytes = base64_decode(&data_b64)?;
    if bytes.is_empty() {
        return Err("粘贴内容为空".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "附件过大（{} 字节，上限 20MB）",
            bytes.len()
        ));
    }
    let dir = crate::paths::data_dir().join("attachments");
    fs::create_dir_all(&dir).map_err(|e| format!("创建附件目录失败：{}", e))?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path: PathBuf = dir.join(format!("{}_{}", ts, name));
    fs::write(&path, &bytes).map_err(|e| format!("写入附件失败：{}", e))?;
    Ok(path.to_string_lossy().into_owned())
}


#[derive(Debug, serde::Serialize)]
pub struct ImportedAttachment {
    pub path: String,
    pub size: u64,
}








#[tauri::command]
pub fn import_attachment(source_path: String) -> Result<ImportedAttachment, String> {
    let mut _g = crate::commands::CmdLog::begin("import_attachment", &[
        ("source", source_path.clone()),
    ]);
    let src = PathBuf::from(&source_path);
    let meta = fs::metadata(&src).map_err(|e| format!("文件不可访问：{}", e))?;
    if !meta.is_file() {
        return Err("不是文件，无法作为附件".into());
    }
    if meta.len() > MAX_BYTES as u64 {
        return Err(format!(
            "附件过大（{} 字节，上限 20MB）",
            meta.len()
        ));
    }
    let name = src
        .file_name()
        .and_then(|s| s.to_str())
        .map(sanitize_file_name)
        .unwrap_or_else(|| "attachment".to_string());
    if !ext_allowed(&name) {
        return Err(format!("不支持的文件类型：{}", name));
    }
    let dir = crate::paths::data_dir().join("attachments");
    fs::create_dir_all(&dir).map_err(|e| format!("创建附件目录失败：{}", e))?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest: PathBuf = dir.join(format!("{}_{}", ts, name));
    fs::copy(&src, &dest).map_err(|e| format!("复制附件失败：{}", e))?;
    Ok(ImportedAttachment {
        path: dest.to_string_lossy().into_owned(),
        size: meta.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_known_vectors() {
        assert_eq!(base64_decode("TWFu").unwrap(), b"Man");
        assert_eq!(base64_decode("TWE=").unwrap(), b"Ma");
        assert_eq!(base64_decode("TQ==").unwrap(), b"M");
        assert_eq!(base64_decode("SGVsbG8gV29ybGQh").unwrap(), b"Hello World!");
    }

    #[test]
    fn decode_ignores_whitespace() {
        assert_eq!(base64_decode("TWF u\nTWE=").unwrap(), b"ManMa");
    }

    #[test]
    fn decode_rejects_garbage() {
        assert!(base64_decode("!!!").is_err());
        assert!(base64_decode("TWE=").is_ok()); 
        assert!(base64_decode("T").is_err()); 
    }

    #[test]
    fn sanitize_drops_paths_and_bad_chars() {
        assert_eq!(sanitize_file_name("/etc/passwd"), "passwd"); 
        assert_eq!(sanitize_file_name("../../evil?.png"), "evil_.png");
        assert_eq!(sanitize_file_name("截图.png"), "截图.png"); 
        assert_eq!(sanitize_file_name(""), "paste");
        assert_eq!(sanitize_file_name(".."), "paste");
    }

    #[test]
    fn ext_whitelist_checks_case_insensitive() {
        assert!(ext_allowed("a.PNG"));
        assert!(ext_allowed("b.pdf"));
        assert!(!ext_allowed("c.exe"));
        assert!(!ext_allowed("noext"));
    }

    #[test]
    fn rejects_oversize() {
        
        let big = vec![b'A'; (MAX_BYTES / 3 + 1) * 4];
        let s = String::from_utf8(big).unwrap();
        let name = "big.png".to_string();
        let r = save_paste_attachment(s, name);
        assert!(r.is_err());
        let msg = r.unwrap_err();
        assert!(msg.contains("过大"), "应提示过大: {}", msg);
    }
}
