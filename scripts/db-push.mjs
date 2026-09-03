import { readFile } from 'node:fs/promises';
import pg from 'pg';

// DDL needs a real Postgres connection. The SUPABASE_SERVICE_ROLE_KEY talks to
// PostgREST, which only exposes tables that already exist — it cannot create
// them, so this uses the database password instead.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    'Missing DATABASE_URL in .env.local.\n' +
      'Supabase dashboard -> Connect -> Session pooler, and put your database\n' +
      'password where it says [YOUR-PASSWORD].'
  );
  process.exit(1);
}

const file = process.argv[2] ?? 'schema.sql';
const sql = await readFile(file, 'utf8');

// Supabase terminates non-SSL connections. The pooler presents a certificate
// that is not in Node's trust store, so verification is off rather than the
// connection being refused outright.
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log(`Connected. Running ${file}…`);

  // Postgres DDL is transactional: if any statement fails, nothing is left
  // half-created for the next run to trip over.
  await client.query('begin');
  await client.query(sql);
  await client.query('commit');

  const { rows } = await client.query(
    `select table_name, (xpath('/row/c/text()',
        query_to_xml(format('select count(*) c from %I', table_name), false, true, '')))[1]::text::int as rows
     from information_schema.tables
     where table_schema = 'public'
     order by table_name`
  );

  console.log('\nDone. Tables in public:');
  for (const row of rows) console.log(`  ${row.table_name.padEnd(18)} ${row.rows} rows`);
} catch (error) {
  await client.query('rollback').catch(() => {});
  console.error(`\nFailed: ${error.message}`);
  if (error.position) console.error(`at character ${error.position} of ${file}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
