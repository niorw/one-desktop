






#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillSource {
    Local,
    Url,
    Builtin,
}

impl SkillSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            SkillSource::Local => "local",
            SkillSource::Url => "url",
            SkillSource::Builtin => "builtin",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "url" => SkillSource::Url,
            "builtin" => SkillSource::Builtin,
            _ => SkillSource::Local,
        }
    }
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillStatus {
    Enabled,
    Disabled,
    Beta,
    Deprecated,
    Error,
}

impl SkillStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SkillStatus::Enabled => "enabled",
            SkillStatus::Disabled => "disabled",
            SkillStatus::Beta => "beta",
            SkillStatus::Deprecated => "deprecated",
            SkillStatus::Error => "error",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "disabled" => SkillStatus::Disabled,
            "beta" => SkillStatus::Beta,
            "deprecated" => SkillStatus::Deprecated,
            "error" => SkillStatus::Error,
            _ => SkillStatus::Enabled,
        }
    }
}


#[derive(Debug, Clone)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub source: SkillSource,
    pub path: Option<String>,
    pub url: Option<String>,
    pub status: SkillStatus,
    pub dependencies: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}


#[derive(Debug, Clone)]
pub struct CreateSkillPayload {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub source: SkillSource,
    pub path: Option<String>,
    pub url: Option<String>,
    pub status: SkillStatus,
    pub dependencies: Vec<String>,
}

impl Skill {
    
    pub fn to_dto(&self) -> crate::types::SkillDto {
        crate::types::SkillDto {
            id: self.id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            version: self.version.clone(),
            source: self.source.as_str().to_string(),
            path: self.path.clone(),
            url: self.url.clone(),
            status: self.status.as_str().to_string(),
            dependencies: self.dependencies.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}
