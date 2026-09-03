import { createClient } from '@supabase/supabase-js';

let client = null;

function getClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // createClient's own message for a missing key names neither the variable
  // nor the file, and .env.local is only picked up on a dev server restart.
  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local — set both, then restart next dev.'
    );
  }
  if (key.startsWith('sb_publishable_')) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY holds the publishable key. RLS is on with no policies, so that key reads nothing — use the sb_secret_... key or the legacy service_role JWT.'
    );
  }

  client = createClient(url, key);
  return client;
}

// Built on first use rather than at import: `next build` loads this module to
// collect page data, and a throw at module scope fails the build on a machine
// that has no .env.local at all.
// Service role key: only ever imported from server code, never a client component.
export const supabase = new Proxy(
  {},
  {
    get(_target, property) {
      const value = Reflect.get(getClient(), property);
      return typeof value === 'function' ? value.bind(getClient()) : value;
    },
  }
);
