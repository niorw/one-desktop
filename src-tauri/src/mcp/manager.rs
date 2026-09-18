




use crate::mcp::client::McpClient;
use crate::mcp::model::*;
use crate::storage::connection::DbConnection;
use crate::storage::mcp_repo::McpServerRepository;
use crate::storage::repository::Repository;
use rusqlite::Result as SqliteResult;
use std::sync::Arc;
use std::time::Duration;


#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpConnectionResult {
    pub ok: bool,
    pub capabilities: McpCapabilities,
    pub error: Option<String>,
}


pub struct McpManager {
    db: Arc<DbConnection>,
}

impl McpManager {
    pub fn new(db: Arc<DbConnection>) -> Self {
        Self { db }
    }

    pub fn list(&self) -> SqliteResult<Vec<McpServer>> {
        McpServerRepository::new(&self.db).find_all(())
    }

    pub fn get(&self, id: &str) -> SqliteResult<Option<McpServer>> {
        McpServerRepository::new(&self.db).find_by_id(id)
    }

    pub fn create(&self, payload: CreateMcpServerPayload) -> SqliteResult<McpServer> {
        let repo = McpServerRepository::new(&self.db);
        let server = repo.create(payload)?;
        tracing::info!(
            target: "onedesktop.mcp",
            server_id = %server.id,
            name = %server.name,
            "MCP server created"
        );
        Ok(server)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> SqliteResult<()> {
        McpServerRepository::new(&self.db).set_enabled(id, enabled)
    }

    pub fn delete(&self, id: &str) -> SqliteResult<()> {
        McpServerRepository::new(&self.db).delete(id)
    }

    
    
    pub fn test_connection(&self, id: &str) -> Result<McpConnectionResult, String> {
        let server = self
            .get(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "MCP 服务器不存在".to_string())?;

        McpServerRepository::new(&self.db)
            .set_status(id, McpStatus::Connecting)
            .ok();

        match McpClient::test(&server, Duration::from_secs(8)) {
            Ok(caps) => {
                McpServerRepository::new(&self.db)
                    .record_success(id, &caps)
                    .ok();
                Ok(McpConnectionResult {
                    ok: true,
                    capabilities: caps,
                    error: None,
                })
            }
            Err(e) => {
                McpServerRepository::new(&self.db).record_error(id, &e).ok();
                Ok(McpConnectionResult {
                    ok: false,
                    capabilities: McpCapabilities::default(),
                    error: Some(e),
                })
            }
        }
    }
}
