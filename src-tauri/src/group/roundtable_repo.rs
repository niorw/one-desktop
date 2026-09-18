







use crate::a2a::model::{A2aMessage, A2aPart, A2aTask, A2aTaskState};
use crate::storage::connection::DbConnection;
use rusqlite::{params, Result as SqliteResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoundtableMessage {
    pub seq: i64,
    pub group_id: String,
    
    pub author: String,
    
    pub worker_id: String,
    
    pub author_kind: String,
    pub content: String,
    
    pub mentions: Vec<String>,
    
    pub attachments: Vec<String>,
    pub created_at: i64,
    
    
    pub session_id: String,
}

impl RoundtableMessage {
    
    
    
    
    
    
    pub fn to_a2a_message(&self, context_id: &str) -> A2aMessage {
        let role = match self.author_kind.as_str() {
            "owner" => "user",
            "worker" => "agent",
            _ => "user", 
        };
        A2aMessage {
            message_id: format!("rt-msg-{}", self.seq),
            context_id: context_id.to_string(),
            task_id: None,
            role: role.to_string(),
            parts: vec![A2aPart::text(&self.content)],
            reference_task_ids: vec![],
        }
    }
}





pub fn roundtable_messages_to_a2a_task(
    msgs: &[RoundtableMessage],
    group_id: &str,
) -> A2aTask {
    let ctx = group_id.to_string();
    let messages: Vec<A2aMessage> = msgs.iter().map(|m| m.to_a2a_message(&ctx)).collect();
    A2aTask {
        task_id: format!("rt:{}", group_id),
        context_id: ctx,
        status: A2aTaskState::Completed,
        messages,
        artifacts: vec![],
        metadata: std::collections::BTreeMap::new(),
    }
}

pub struct RoundtableRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> RoundtableRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    
    pub fn create(&self, msg: &RoundtableMessage) -> SqliteResult<i64> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO roundtable_messages (group_id, author, worker_id, author_kind, content, mentions, attachments, created_at, session_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    msg.group_id,
                    msg.author,
                    msg.worker_id,
                    msg.author_kind,
                    msg.content,
                    serde_json::to_string(&msg.mentions).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&msg.attachments).unwrap_or_else(|_| "[]".into()),
                    msg.created_at,
                    msg.session_id,
                ],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    
    pub fn find_by_group(&self, group_id: &str) -> SqliteResult<Vec<RoundtableMessage>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT seq, group_id, author, worker_id, author_kind, content, mentions, attachments, created_at, session_id \
                 FROM roundtable_messages WHERE group_id = ?1 ORDER BY seq ASC",
            )?;
            let items = stmt
                .query_map(params![group_id], |row| {
                    Ok(RoundtableMessage {
                        seq: row.get(0)?,
                        group_id: row.get(1)?,
                        author: row.get(2)?,
                        worker_id: row.get(3)?,
                        author_kind: row.get(4)?,
                        content: row.get(5)?,
                        mentions: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
                        attachments: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
                        created_at: row.get(8)?,
                        session_id: row.get(9).unwrap_or_default(),
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();
            Ok(items)
        })
    }

    
    pub fn max_seq(&self, group_id: &str) -> SqliteResult<i64> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT COALESCE(MAX(seq), 0) FROM roundtable_messages WHERE group_id = ?1",
            )?;
            let v: i64 = stmt.query_row(params![group_id], |row| row.get(0))?;
            Ok(v)
        })
    }
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoundtableAlternative {
    pub id: i64,
    pub group_id: String,
    
    pub trigger_seq: i64,
    
    pub worker_id: String,
    
    pub content: String,
    pub created_at: i64,
}

pub struct RoundtableAlternativeRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> RoundtableAlternativeRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    pub fn create(&self, alt: &RoundtableAlternative) -> SqliteResult<i64> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO roundtable_alternatives (group_id, trigger_seq, worker_id, content, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    alt.group_id,
                    alt.trigger_seq,
                    alt.worker_id,
                    alt.content,
                    alt.created_at,
                ],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    
    pub fn find_before(
        &self,
        group_id: &str,
        before_seq: i64,
    ) -> SqliteResult<Vec<RoundtableAlternative>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, group_id, trigger_seq, worker_id, content, created_at \
                 FROM roundtable_alternatives WHERE group_id = ?1 AND trigger_seq < ?2 ORDER BY id ASC",
            )?;
            let items = stmt
                .query_map(params![group_id, before_seq], |row| {
                    Ok(RoundtableAlternative {
                        id: row.get(0)?,
                        group_id: row.get(1)?,
                        trigger_seq: row.get(2)?,
                        worker_id: row.get(3)?,
                        content: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();
            Ok(items)
        })
    }

    
    pub fn find_by_id(&self, id: i64) -> SqliteResult<Option<RoundtableAlternative>> {
        self.db.with_conn(|conn| {
            conn.query_row(
                "SELECT id, group_id, trigger_seq, worker_id, content, created_at \
                 FROM roundtable_alternatives WHERE id = ?1",
                params![id],
                |row| {
                    Ok(RoundtableAlternative {
                        id: row.get(0)?,
                        group_id: row.get(1)?,
                        trigger_seq: row.get(2)?,
                        worker_id: row.get(3)?,
                        content: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                },
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
        })
    }
}





#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoundtableSummary {
    pub id: i64,
    pub group_id: String,
    
    pub content: String,
    
    pub source_seq_start: i64,
    pub source_seq_end: i64,
    
    pub message_count: i32,
    pub created_at: i64,
}

pub struct RoundtableSummaryRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> RoundtableSummaryRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    
    pub fn create(&self, summary: &RoundtableSummary) -> SqliteResult<i64> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO roundtable_summaries \
                 (group_id, content, source_seq_start, source_seq_end, message_count, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    summary.group_id,
                    summary.content,
                    summary.source_seq_start,
                    summary.source_seq_end,
                    summary.message_count,
                    summary.created_at,
                ],
            )?;
            Ok(conn.last_insert_rowid())
        })
    }

    
    pub fn find_by_group(&self, group_id: &str) -> SqliteResult<Vec<RoundtableSummary>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, group_id, content, source_seq_start, source_seq_end, message_count, created_at \
                 FROM roundtable_summaries WHERE group_id = ?1 ORDER BY id ASC",
            )?;
            let items = stmt
                .query_map(params![group_id], |row| {
                    Ok(RoundtableSummary {
                        id: row.get(0)?,
                        group_id: row.get(1)?,
                        content: row.get(2)?,
                        source_seq_start: row.get(3)?,
                        source_seq_end: row.get(4)?,
                        message_count: row.get(5)?,
                        created_at: row.get(6)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();
            Ok(items)
        })
    }

    
    pub fn latest(&self, group_id: &str) -> SqliteResult<Option<RoundtableSummary>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, group_id, content, source_seq_start, source_seq_end, message_count, created_at \
                 FROM roundtable_summaries WHERE group_id = ?1 ORDER BY id DESC LIMIT 1",
            )?;
            let item = stmt
                .query_map(params![group_id], |row| {
                    Ok(RoundtableSummary {
                        id: row.get(0)?,
                        group_id: row.get(1)?,
                        content: row.get(2)?,
                        source_seq_start: row.get(3)?,
                        source_seq_end: row.get(4)?,
                        message_count: row.get(5)?,
                        created_at: row.get(6)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .next();
            Ok(item)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_msg(seq: i64, kind: &str, content: &str) -> RoundtableMessage {
        RoundtableMessage {
            seq,
            group_id: "g1".into(),
            author: format!("{}_ref", kind),
            worker_id: if kind == "worker" {
                "w1".into()
            } else {
                String::new()
            },
            author_kind: kind.into(),
            content: content.into(),
            mentions: vec![],
            attachments: vec![],
            created_at: 0,
            session_id: String::new(),
        }
    }

    #[test]
    fn message_role_mapping_owner_worker_system() {
        let owner = mk_msg(1, "owner", "群主问");
        let worker = mk_msg(2, "worker", "worker 答");
        let system = mk_msg(3, "system", "系统提示");
        assert_eq!(owner.to_a2a_message("g1").role, "user");
        assert_eq!(worker.to_a2a_message("g1").role, "agent");
        assert_eq!(system.to_a2a_message("g1").role, "user");
    }

    #[test]
    fn message_id_and_context_stable() {
        let m = mk_msg(7, "owner", "x");
        let a = m.to_a2a_message("g9");
        assert_eq!(a.message_id, "rt-msg-7");
        assert_eq!(a.context_id, "g9");
        assert_eq!(a.parts.len(), 1);
        assert_eq!(a.parts[0].text.as_deref(), Some("x"));
        assert!(a.reference_task_ids.is_empty());
    }

    #[test]
    fn whole_roundtable_projects_to_completed_task() {
        let msgs = vec![
            mk_msg(1, "owner", "问A"),
            mk_msg(2, "worker", "答A"),
            mk_msg(3, "owner", "问B"),
        ];
        let task = roundtable_messages_to_a2a_task(&msgs, "g1");
        assert_eq!(task.task_id, "rt:g1");
        assert_eq!(task.context_id, "g1");
        assert_eq!(task.status, A2aTaskState::Completed);
        assert_eq!(task.messages.len(), 3);
        
        assert_eq!(task.messages[0].role, "user");
        assert_eq!(task.messages[1].role, "agent");
        assert_eq!(task.messages[2].role, "user");
        
        assert_eq!(task.task_card_text(), "问B");
    }
}
