

use crate::group::topology::TopologyPolicy;
use crate::group::topology_repo::TopologyPolicyRepository;
use crate::group::{CreateGroupPayload, Group, GroupKind, GroupListItem, GroupStatus};
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use rusqlite::{params, Connection, Result as SqliteResult};

pub struct GroupRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> GroupRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    pub fn update_status(&self, id: &str, status: GroupStatus) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE groups SET status = ?1 WHERE id = ?2",
                params![serde_json::to_string(&status).unwrap(), id],
            )?;
            Ok(())
        })
    }
}

fn map_row(row: &rusqlite::Row) -> SqliteResult<Group> {
    Ok(Group {
        id: row.get(0)?,
        name: row.get(1)?,
        goal: row.get(2)?,
        owner_agent_ref: row.get(3)?,
        status: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or(GroupStatus::Active),
        
        kind: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or(GroupKind::Chat),
        seat_config: serde_json::from_str(&row.get::<_, String>(5)?)
            .unwrap_or(serde_json::Value::Null),
        created_at: row.get(6)?,
    })
}


fn count_workers(conn: &Connection, group_id: &str) -> SqliteResult<i64> {
    let mut stmt = conn.prepare("SELECT COUNT(*) FROM workers WHERE group_id = ?1")?;
    stmt.query_row(params![group_id], |row| row.get::<_, i64>(0))
}


fn latest_roundtable_message(
    conn: &Connection,
    group_id: &str,
) -> SqliteResult<(Option<String>, Option<i64>)> {
    let mut stmt = conn.prepare(
        "SELECT content, created_at FROM roundtable_messages WHERE group_id = ?1 ORDER BY seq DESC LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![group_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    match rows.next() {
        Some(Ok((content, ts))) => Ok((Some(content), Some(ts))),
        _ => Ok((None, None)),
    }
}

impl<'a> Repository<Group, CreateGroupPayload, ()> for GroupRepository<'a> {
    fn create(&self, p: CreateGroupPayload) -> SqliteResult<Group> {
        let id = insert_group(self.db, &p)?;
        
        TopologyPolicyRepository::new(self.db).save(&id, &TopologyPolicy::default())?;
        self.find_by_id(&id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    fn find_by_id(&self, id: &str) -> SqliteResult<Option<Group>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,name,goal,owner_agent_ref,status,seat_config,created_at,kind FROM groups WHERE id = ?1",
            )?;
            let mut rows = stmt.query_map(params![id], map_row)?;
            match rows.next() {
                Some(Ok(g)) => Ok(Some(g)),
                _ => Ok(None),
            }
        })
    }

    fn find_all(&self, _query: ()) -> SqliteResult<Vec<Group>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,name,goal,owner_agent_ref,status,seat_config,created_at,kind FROM groups ORDER BY created_at DESC",
            )?;
            let items = stmt.query_map([], map_row)?.filter_map(|r| r.ok()).collect();
            Ok(items)
        })
    }

    fn delete(&self, id: &str) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute("DELETE FROM groups WHERE id = ?1", params![id])?;
            Ok(())
        })
    }
}



fn insert_group(db: &DbConnection, p: &CreateGroupPayload) -> SqliteResult<String> {
    let id = format!("grp_{}", uuid::Uuid::new_v4().simple());
    let now = chrono::Utc::now().timestamp();
    let status = GroupStatus::Active;
    db.with_conn_mut(|conn| {
        conn.execute(
            "INSERT INTO groups (id,name,goal,owner_agent_ref,status,seat_config,created_at,kind)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                id,
                p.name,
                p.goal,
                p.owner_agent_ref,
                serde_json::to_string(&status).unwrap(),
                serde_json::to_string(&p.seat_config).unwrap_or_else(|_| "{}".into()),
                now,
                serde_json::to_string(&p.kind).unwrap_or_else(|_| "\"Chat\"".into()),
            ],
        )
    })?;
    Ok(id)
}

impl<'a> GroupRepository<'a> {
    
    
    pub fn find_summaries(&self) -> SqliteResult<Vec<GroupListItem>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,name,goal,owner_agent_ref,status,seat_config,created_at,kind FROM groups",
            )?;
            let mut items: Vec<GroupListItem> = stmt
                .query_map([], |row| {
                    let id: String = row.get(0)?;
                    let created_at: i64 = row.get(6)?;
                    let (preview, last_ts) = latest_roundtable_message(conn, &id)?;
                    let member_count = count_workers(conn, &id)?;
                    
                    let updated_at = last_ts.map(|ms| ms / 1000).or(Some(created_at));
                    Ok(GroupListItem {
                        id,
                        name: row.get(1)?,
                        goal: row.get(2)?,
                        owner_agent_ref: row.get(3)?,
                        status: serde_json::from_str(&row.get::<_, String>(4)?)
                            .unwrap_or(GroupStatus::Active),
                        kind: serde_json::from_str(&row.get::<_, String>(7)?)
                            .unwrap_or(GroupKind::Chat),
                        seat_config: serde_json::from_str(&row.get::<_, String>(5)?)
                            .unwrap_or(serde_json::Value::Null),
                        created_at,
                        updated_at,
                        member_count,
                        last_message_preview: preview,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();
            items.sort_by(|a, b| {
                let ta = a.updated_at.unwrap_or(a.created_at);
                let tb = b.updated_at.unwrap_or(b.created_at);
                tb.cmp(&ta)
            });
            Ok(items)
        })
    }

    
    
    pub fn create_with_topology(
        &self,
        p: &CreateGroupPayload,
        topology: &TopologyPolicy,
    ) -> SqliteResult<Group> {
        let id = insert_group(self.db, p)?;
        TopologyPolicyRepository::new(self.db).commit_next(&id, topology.clone())?;
        self.find_by_id(&id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }
}
