







use rusqlite::Result as SqliteResult;







pub trait Repository<Entity, CreatePayload, Query> {
    
    fn create(&self, payload: CreatePayload) -> SqliteResult<Entity>;

    
    fn find_by_id(&self, id: &str) -> SqliteResult<Option<Entity>>;

    
    fn find_all(&self, query: Query) -> SqliteResult<Vec<Entity>>;

    
    fn delete(&self, id: &str) -> SqliteResult<()>;
}
