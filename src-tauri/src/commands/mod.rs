



pub mod agent;

pub mod changeset;

pub mod calendar;
pub mod config;
pub mod extensibility;
pub mod group;

pub mod insight;

pub mod redact;

pub mod longtask;

pub mod memory;

pub mod playbook;
pub mod scheduler;
pub mod session;

pub mod upgrade;

pub mod user_profile;

pub mod inspiration;

pub mod artifact;

pub mod attachment;

pub mod workspace;
















use std::time::Instant;



pub struct CmdLog {
    name: &'static str,
    args: Vec<(String, String)>,
    started: Instant,
    failed: bool,
}

impl CmdLog {
    pub fn begin(name: &'static str, args: &[(&str, String)]) -> Self {
        let args: Vec<(String, String)> = args
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect();
        tracing::debug!(
            target: "onedesktop.cmd",
            cmd = name,
            args = ?args,
            "cmd begin"
        );
        Self {
            name,
            args,
            started: Instant::now(),
            failed: false,
        }
    }

    
    pub fn fail(&mut self, err: &str) {
        self.failed = true;
        tracing::warn!(
            target: "onedesktop.cmd",
            cmd = self.name,
            error = err,
            "cmd failed"
        );
    }
}

impl Drop for CmdLog {
    fn drop(&mut self) {
        let dur_ms = self.started.elapsed().as_millis() as u64;
        if self.failed {
            tracing::info!(
                target: "onedesktop.cmd",
                cmd = self.name,
                outcome = "failed",
                dur_ms,
                "cmd end"
            );
        } else {
            tracing::debug!(
                target: "onedesktop.cmd",
                cmd = self.name,
                outcome = "ok",
                dur_ms,
                "cmd end"
            );
        }
    }
}



#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}




#[tauri::command]
pub fn startup_progress() -> u8 {
    use std::sync::atomic::Ordering;
    crate::STARTUP_PROGRESS.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_log_begin_returns_guard() {
        
        {
            let _g = CmdLog::begin("test_cmd", &[("a", "1".into())]);
        }
        
        {
            let mut g = CmdLog::begin("test_cmd_fail", &[]);
            g.fail("boom");
        }
    }

    #[test]
    fn cmd_log_tracks_elapsed() {
        let g = CmdLog::begin("t", &[]);
        assert!(g.started.elapsed().as_millis() >= 0);
    }
}
