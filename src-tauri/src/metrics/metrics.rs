





use std::sync::atomic::{AtomicU64, Ordering};




pub struct Metrics {
    
    pub agent_loops: AtomicU64,
    
    pub tool_calls: AtomicU64,
    
    pub tool_errors: AtomicU64,
    
    pub sessions_created: AtomicU64,
    
    pub messages_persisted: AtomicU64,
    
    pub total_tokens: AtomicU64,
    
    pub avg_loop_duration_us: AtomicU64,
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            agent_loops: AtomicU64::new(0),
            tool_calls: AtomicU64::new(0),
            tool_errors: AtomicU64::new(0),
            sessions_created: AtomicU64::new(0),
            messages_persisted: AtomicU64::new(0),
            total_tokens: AtomicU64::new(0),
            avg_loop_duration_us: AtomicU64::new(0),
        }
    }

    pub fn inc_agent_loops(&self) {
        self.agent_loops.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_tool_calls(&self) {
        self.tool_calls.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_tool_errors(&self) {
        self.tool_errors.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_sessions_created(&self) {
        self.sessions_created.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_messages_persisted(&self) {
        self.messages_persisted.fetch_add(1, Ordering::Relaxed);
    }

    pub fn add_tokens(&self, tokens: u64) {
        self.total_tokens.fetch_add(tokens, Ordering::Relaxed);
    }

    
    pub fn record_loop_duration(&self, duration_us: u64) {
        let current = self.avg_loop_duration_us.load(Ordering::Relaxed);
        let new = if current == 0 {
            duration_us
        } else {
            (current / 10 * 9) + (duration_us / 10)
        };
        self.avg_loop_duration_us.store(new, Ordering::Relaxed);
    }

    
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "agent_loops": self.agent_loops.load(Ordering::Relaxed),
            "tool_calls": self.tool_calls.load(Ordering::Relaxed),
            "tool_errors": self.tool_errors.load(Ordering::Relaxed),
            "sessions_created": self.sessions_created.load(Ordering::Relaxed),
            "messages_persisted": self.messages_persisted.load(Ordering::Relaxed),
            "total_tokens": self.total_tokens.load(Ordering::Relaxed),
            "avg_loop_duration_us": self.avg_loop_duration_us.load(Ordering::Relaxed),
        })
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}
