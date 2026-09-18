




use crate::paths;
use crate::skill::model::*;
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use crate::storage::skill_repo::SkillRepository;
use rusqlite::Result as SqliteResult;
use std::sync::Arc;


pub struct SkillManager {
    db: Arc<DbConnection>,
}

impl SkillManager {
    pub fn new(db: Arc<DbConnection>) -> Self {
        Self { db }
    }

    pub fn list(&self) -> SqliteResult<Vec<Skill>> {
        SkillRepository::new(&self.db).find_all(())
    }

    pub fn get(&self, id: &str) -> SqliteResult<Option<Skill>> {
        SkillRepository::new(&self.db).find_by_id(id)
    }

    pub fn create(&self, payload: CreateSkillPayload) -> SqliteResult<Skill> {
        let repo = SkillRepository::new(&self.db);
        let skill = repo.create(payload)?;
        tracing::info!(
            target: "onedesktop.skill",
            skill_id = %skill.id,
            name = %skill.name,
            "Skill created"
        );
        Ok(skill)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> SqliteResult<()> {
        SkillRepository::new(&self.db).set_enabled(id, enabled)
    }

    pub fn delete(&self, id: &str) -> SqliteResult<()> {
        SkillRepository::new(&self.db).delete(id)
    }

    
    
    
    
    
    pub fn import_local(&self, path: String) -> Result<Skill, String> {
        let src = std::path::Path::new(&path);
        let skill_md = src.join("SKILL.md");
        let content = std::fs::read_to_string(&skill_md)
            .map_err(|e| format!("无法读取 {}: {}", skill_md.display(), e))?;
        let (name, description, version) = parse_skill_frontmatter(&content).unwrap_or_else(|| {
            (
                skill_md
                    .parent()
                    .and_then(|p| p.file_name())
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "imported-skill".to_string()),
                "Imported skill".to_string(),
                "1.0.0".to_string(),
            )
        });

        let id = uuid::Uuid::new_v4().to_string();
        let dest = paths::skill_dir("local", &id);
        copy_dir_recursive(src, &dest)
            .map_err(|e| format!("复制 skill 到 {} 失败: {}", dest.display(), e))?;

        let payload = CreateSkillPayload {
            id,
            name,
            description,
            version,
            source: SkillSource::Local,
            path: Some(dest.to_string_lossy().into_owned()),
            url: None,
            status: SkillStatus::Enabled,
            dependencies: vec![],
        };
        self.create(payload).map_err(|e| e.to_string())
    }

    
    pub fn import_url(&self, url: String) -> Result<Skill, String> {
        let name = url
            .split('/')
            .last()
            .filter(|s| !s.is_empty())
            .unwrap_or("imported-skill")
            .to_string();
        let payload = CreateSkillPayload {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            description: format!("Imported from {}", url),
            version: "1.0.0".to_string(),
            source: SkillSource::Url,
            path: None,
            url: Some(url),
            status: SkillStatus::Enabled,
            dependencies: vec![],
        };
        self.create(payload).map_err(|e| e.to_string())
    }
}


const L2_TOKEN_LIMIT: usize = 5000;

const CHARS_PER_TOKEN: usize = 3;

impl SkillManager {
    
    
    
    pub fn l1_block(&self, skill_ids: &[String]) -> String {
        let mut lines: Vec<String> = Vec::new();
        for id in skill_ids {
            if let Ok(Some(skill)) = self.get(id) {
                if skill.status == SkillStatus::Disabled {
                    continue;
                }
                lines.push(format!("- {}: {}", skill.name, skill.description));
            }
        }
        if lines.is_empty() {
            String::new()
        } else {
            format!(
                "可用 Skills（正文按需加载，命中后由 read_skill 读取，不要臆测内容）：\n{}",
                lines.join("\n")
            )
        }
    }

    
    
    
    pub fn read_l2(&self, id: &str) -> Option<String> {
        let skill = self.get(id).ok().flatten()?;
        let dir = skill.path.as_ref()?;
        let md_path = std::path::Path::new(dir).join("SKILL.md");
        let content = std::fs::read_to_string(&md_path).ok()?;
        let body = strip_frontmatter(&content);
        let budget_chars = L2_TOKEN_LIMIT * CHARS_PER_TOKEN;
        if body.chars().count() > budget_chars {
            let taken: String = body.chars().take(budget_chars).collect();
            Some(format!(
                "{}…\n[L2 已截断至 {} token 预算上限]",
                taken, L2_TOKEN_LIMIT
            ))
        } else {
            Some(body)
        }
    }

    
    
    
    pub fn read_l3(&self, id: &str, file: &str) -> Option<String> {
        let skill = self.get(id).ok().flatten()?;
        let dir = std::path::Path::new(skill.path.as_ref()?);
        let target = dir.join(file);
        if target != dir && !target.starts_with(dir) {
            return None;
        }
        std::fs::read_to_string(&target).ok()
    }
}


fn strip_frontmatter(content: &str) -> String {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let rest = match content.strip_prefix("---") {
        Some(r) => r,
        None => return content.to_string(),
    };
    match rest.find("\n---") {
        Some(end) => {
            let after = &rest[end + 4..];
            after.trim_start_matches('\n').to_string()
        }
        None => content.to_string(),
    }
}


fn parse_skill_frontmatter(content: &str) -> Option<(String, String, String)> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let rest = content.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let fm = &rest[..end];
    let name = extract_yaml_value(fm, "name");
    let description = extract_yaml_value(fm, "description");
    let version = extract_yaml_value(fm, "version").unwrap_or_else(|| "1.0.0".to_string());
    Some((
        name.unwrap_or_else(|| "imported-skill".to_string()),
        description.unwrap_or_default(),
        version,
    ))
}

fn extract_yaml_value(fm: &str, key: &str) -> Option<String> {
    fm.lines().find_map(|line| {
        let line = line.trim();
        if let Some(stripped) = line.strip_prefix(&format!("{}:", key)) {
            let v = stripped
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            if v.is_empty() {
                None
            } else {
                Some(v)
            }
        } else {
            None
        }
    })
}



fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::connection::DbConnection;
    use std::sync::Arc;

    
    
    #[test]
    fn import_local_parses_frontmatter_and_persists() {
        let base = paths::tmp_dir().join(format!("skill_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let skill_dir = base.join("commit-writer");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: commit-writer\ndescription: 根据 git 暂存差异生成提交信息\nversion: 1.2.3\n---\n\n# commit-writer\n",
        )
        .unwrap();

        let db = Arc::new(DbConnection::open(&base).unwrap());
        let mgr = SkillManager::new(db);

        let skill = mgr
            .import_local(skill_dir.to_string_lossy().into_owned())
            .expect("import_local should succeed");
        assert_eq!(skill.name, "commit-writer");
        assert_eq!(skill.version, "1.2.3");
        assert_eq!(skill.source, SkillSource::Local);
        
        assert!(skill.path.unwrap().contains(".one-desktop/skills/local"));

        let all = mgr.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, skill.id);

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(paths::skill_dir("local", &skill.id));
    }

    
    #[test]
    fn three_tier_loading_respects_budget() {
        let base = paths::tmp_dir().join(format!("skill_tier_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let skill_dir = base.join("tier-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let body = "# tier-skill\n\n正文内容：执行具体步骤 A → B → C。".repeat(3);
        std::fs::write(
            skill_dir.join("SKILL.md"),
            format!(
                "---\nname: tier-skill\ndescription: 三级加载测试技能\nversion: 1.0.0\n---\n\n{}",
                body
            ),
        )
        .unwrap();
        std::fs::write(skill_dir.join("helper.sh"), "echo 'bundled script output'").unwrap();

        let db = Arc::new(DbConnection::open(&base).unwrap());
        let mgr = SkillManager::new(db);
        let skill = mgr
            .import_local(skill_dir.to_string_lossy().into_owned())
            .expect("import");

        
        let l1 = mgr.l1_block(&[skill.id.clone()]);
        assert!(l1.contains("tier-skill"), "L1 must name the skill");
        assert!(l1.contains("三级加载测试技能"), "L1 must carry description");
        assert!(!l1.contains("正文内容"), "L1 must NOT leak L2 body");

        
        let l2 = mgr.read_l2(&skill.id).expect("L2 readable");
        assert!(l2.contains("正文内容"), "L2 must carry body");
        assert!(!l2.contains("description:"), "L2 must strip frontmatter");

        
        let l3 = mgr.read_l3(&skill.id, "helper.sh").expect("L3 readable");
        assert!(l3.contains("bundled script output"));
        assert!(mgr.read_l3(&skill.id, "../escape.txt").is_none(), "L3 rejects path escape");

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(paths::skill_dir("local", &skill.id));
    }

    
    #[test]
    fn l2_truncates_over_budget() {
        let base = paths::tmp_dir().join(format!("skill_l2_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let skill_dir = base.join("big-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        
        let big = "正文行。".repeat(100_000);
        std::fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: big-skill\ndescription: 超大正文\n---\n\n{}", big),
        )
        .unwrap();

        let db = Arc::new(DbConnection::open(&base).unwrap());
        let mgr = SkillManager::new(db);
        let skill = mgr
            .import_local(skill_dir.to_string_lossy().into_owned())
            .expect("import");
        let l2 = mgr.read_l2(&skill.id).expect("L2 readable");
        assert!(l2.contains("已截断至"), "over-budget L2 must be truncated with note");
        assert!(
            l2.chars().count() < big.chars().count(),
            "truncated L2 must be shorter than raw body"
        );

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(paths::skill_dir("local", &skill.id));
    }
}
