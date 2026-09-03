// Creates the screenshot bucket. Separate from schema.sql because
// storage.buckets cannot be inserted into from the SQL editor.
const BUCKET = 'linkedin-screenshots';

// Falling out of main() rather than calling process.exit(): forcing exit while
// fetch still holds a handle aborts the process on Windows with a libuv
// assertion, after the output has already been printed.
async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };

  const existing = await fetch(`${url}/storage/v1/bucket`, { headers }).then((r) => r.json());
  if (Array.isArray(existing) && existing.some((bucket) => bucket.id === BUCKET)) {
    console.log(`Bucket "${BUCKET}" already exists.`);
    return;
  }

  const response = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });

  if (!response.ok) throw new Error(await response.text());
  console.log(`Created bucket "${BUCKET}".`);
}

await main().catch((error) => {
  console.error(`Failed: ${error.message}`);
  process.exitCode = 1;
});
