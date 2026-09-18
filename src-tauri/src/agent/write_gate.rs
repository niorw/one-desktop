












use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;



pub struct ChangesetRecord {
    pub file: String,
    pub holder: String,
    pub run_id: Option<String>,
    pub before_hash: Option<String>,
    pub after_hash: String,
    pub before_content: Option<String>,
    pub after_content: Option<String>,
}


pub trait ChangesetRecorder: Send + Sync {
    
    
    
    fn record(&self, rec: ChangesetRecord);
}


#[derive(Default)]
pub struct WriteGate {
    
    held: RwLock<HashMap<PathBuf, String>>,
    
    recorder: Option<Box<dyn ChangesetRecorder>>,
}

impl std::fmt::Debug for WriteGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WriteGate").finish_non_exhaustive()
    }
}

impl WriteGate {
    pub fn new(recorder: Option<Box<dyn ChangesetRecorder>>) -> Self {
        Self {
            held: RwLock::new(HashMap::new()),
            recorder,
        }
    }

    
    
    pub fn begin_write(&self, path: &Path, holder: &str) -> Result<(), String> {
        let canon = normalize(path);
        let mut held = self.held.write().map_err(|_| "write gate poisoned".to_string())?;
        match held.get(&canon) {
            Some(existing) if existing != holder => Err(format!(
                "文件正在被其他任务写入：{}（持有者 run {}）—— 并发写冲突，已拒绝本次写入。请等待该任务完成或改派他人。",
                canon.display(),
                existing
            )),
            _ => {
                held.insert(canon, holder.to_string());
                Ok(())
            }
        }
    }

    
    
    pub fn commit_write(
        &self,
        path: &Path,
        holder: &str,
        run_id: Option<&str>,
        before_hash: Option<String>,
        after_hash: String,
        before_content: Option<String>,
        after_content: Option<String>,
    ) {
        let canon = normalize(path);
        if let Some(r) = &self.recorder {
            r.record(ChangesetRecord {
                file: canon.to_string_lossy().to_string(),
                holder: holder.to_string(),
                run_id: run_id.map(|s| s.to_string()),
                before_hash,
                after_hash,
                before_content,
                after_content,
            });
        }
        let mut held = match self.held.write() {
            Ok(g) => g,
            Err(_) => return,
        };
        
        if held.get(&canon).map(|h| h == holder).unwrap_or(false) {
            held.remove(&canon);
        }
    }

    
    pub fn release_run(&self, holder: &str) {
        if let Ok(mut held) = self.held.write() {
            held.retain(|_, h| h != holder);
        }
    }

    
    pub fn held_len(&self) -> usize {
        self.held.read().map(|g| g.len()).unwrap_or(0)
    }
}




fn normalize(path: &Path) -> PathBuf {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let parent = abs.parent().unwrap_or_else(|| Path::new("."));
    let file = abs.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    let canon_parent = parent.canonicalize().unwrap_or_else(|_| parent.to_path_buf());
    canon_parent.join(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_writer_rejected_same_run_allowed() {
        let gate = WriteGate::new(None);
        let p = Path::new("/tmp/od_f10_a.txt");
        assert!(gate.begin_write(p, "run-1").is_ok());
        
        assert!(gate.begin_write(p, "run-1").is_ok());
        
        let err = gate.begin_write(p, "run-2").unwrap_err();
        assert!(err.contains("并发写冲突"), "错误应说明冲突: {}", err);
        assert_eq!(gate.held_len(), 1);

        
        gate.commit_write(p, "run-1", Some("run-1"), None, "h".into(), None, None);
        assert!(gate.begin_write(p, "run-2").is_ok());
    }

    #[test]
    fn different_files_do_not_conflict() {
        let gate = WriteGate::new(None);
        assert!(gate.begin_write(Path::new("/tmp/od_f10_x.txt"), "run-1").is_ok());
        assert!(gate.begin_write(Path::new("/tmp/od_f10_y.txt"), "run-2").is_ok());
        assert_eq!(gate.held_len(), 2);
    }

    #[test]
    fn release_run_cleans_all_holdings() {
        let gate = WriteGate::new(None);
        gate.begin_write(Path::new("/tmp/od_f10_r1.txt"), "run-1").unwrap();
        gate.begin_write(Path::new("/tmp/od_f10_r2.txt"), "run-1").unwrap();
        gate.begin_write(Path::new("/tmp/od_f10_other.txt"), "run-2").unwrap();
        assert_eq!(gate.held_len(), 3);
        gate.release_run("run-1");
        assert_eq!(gate.held_len(), 1);
    }

    struct RecordingRecorder(std::sync::Arc<std::sync::Mutex<Vec<String>>>);
    impl ChangesetRecorder for RecordingRecorder {
        fn record(&self, rec: ChangesetRecord) {
            self.0.lock().unwrap().push(format!(
                "{}|{}|{:?}|{:?}|{}|{:?}|{:?}",
                rec.file,
                rec.holder,
                rec.run_id,
                rec.before_hash,
                rec.after_hash,
                rec.before_content,
                rec.after_content
            ));
        }
    }

    #[test]
    fn commit_records_changeset() {
        let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let gate = WriteGate::new(Some(Box::new(RecordingRecorder(log.clone()))));
        let p = Path::new("/tmp/od_f10_rec.txt");
        gate.begin_write(p, "run-1").unwrap();
        gate.commit_write(
            p,
            "run-1",
            Some("run-1"),
            Some("before".into()),
            "after".into(),
            Some("old content".into()),
            Some("new content".into()),
        );
        let rec = log.lock().unwrap();
        assert_eq!(rec.len(), 1);
        assert!(rec[0].contains("run-1"));
        assert!(rec[0].contains("before"));
        assert!(rec[0].contains("after"));
        assert!(rec[0].contains("old content"));
        assert!(rec[0].contains("new content"));
    }
}
