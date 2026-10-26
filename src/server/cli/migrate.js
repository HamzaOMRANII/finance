// npm run migrate: applies pending migrations (the server also does this on start).
const db = require('../db');

db.open();
const rows = db.all('SELECT name, applied_at FROM schema_migrations ORDER BY name');
for (const r of rows) console.log(`${r.name}  ${r.applied_at}`);
