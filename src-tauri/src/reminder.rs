









use std::sync::Arc;

use rusqlite::params;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::storage::connection::DbConnection;


pub async fn run_reminder_loop(app: AppHandle, db: Arc<DbConnection>) {
    
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
    ticker.tick().await;
    loop {
        ticker.tick().await;
        if let Err(e) = fire_due_reminders(&app, &db) {
            tracing::warn!(target: "onedesktop.reminder", "投递到期提醒失败: {e}");
        }
    }
}


pub fn fire_due_reminders(app: &AppHandle, db: &DbConnection) -> Result<(), String> {
    
    let threshold = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();

    let due: Vec<(String, String, String, String)> = db
        .with_conn(|conn| -> rusqlite::Result<Vec<(String, String, String, String)>> {
            let mut stmt = conn
                .prepare(
                    "SELECT id, title, content, time_start FROM calendar_events \
                     WHERE kind = 'reminder' \
                       AND time_start IS NOT NULL \
                       AND notified_at IS NULL \
                       AND (date_key || ' ' || time_start) <= ?1 \
                     ORDER BY date_key, time_start",
                )?;
            let rows = stmt
                .query_map(params![threshold], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok(out)
        })
        .map_err(|e| e.to_string())?;

    if due.is_empty() {
        return Ok(());
    }

    for (id, title, content, _ts) in due {
        let body = if content.trim().is_empty() {
            "OneDesktop 提醒".to_string()
        } else {
            content.trim().to_string()
        };

        
        let _ = app
            .notification()
            .builder()
            .title(title.clone())
            .body(body)
            .show();

        
        let _ = db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE calendar_events SET notified_at = ?1 WHERE id = ?2",
                params![chrono::Utc::now().timestamp(), id.clone()],
            )
        });
    }

    Ok(())
}



#[tauri::command]
pub fn reminder_notify_test(app: AppHandle) -> Result<(), String> {
    app.notification()
        .builder()
        .title("OneDesktop 提醒测试")
        .body("如果你看到这条系统通知，说明 macOS 通知已接通 ✅")
        .show()
        .map_err(|e| e.to_string())
}
