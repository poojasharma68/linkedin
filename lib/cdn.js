import { UnionStack } from '@masters-union/union-stack/node';

// Screenshots go to UnionStack when UNIONSTACK_API_KEY is set, and to the
// Supabase bucket otherwise, so the app still runs with no key configured.
//
// The key must be a SERVER key — one with an empty allowed-origins list in the
// UnionStack dashboard. Uploads here come from the Next.js server with no
// Origin header, which is exactly what a browser key rejects (code AUTH).
// Nothing on this path runs in the browser, so no key reaches the client.
export function cdnConfigured() {
  return Boolean(process.env.UNIONSTACK_API_KEY);
}

let client = null;

function getClient() {
  // Built on first upload rather than at import, so a missing key degrades to
  // the Supabase fallback instead of throwing while the module loads.
  if (!client) {
    client = UnionStack.init({ apiKey: process.env.UNIONSTACK_API_KEY });
  }
  return client;
}

export async function uploadToCdn(buffer, filename) {
  if (!cdnConfigured()) return null;

  try {
    // Raw bytes carry no name or type of their own. The SDK only infers those
    // when uploading from a path, so both are passed explicitly here.
    const file = await getClient().upload(buffer, {
      filename,
      mimeType: 'image/png',
    });

    // `url` is the public CDN address, e.g.
    // https://files.unionstack.in/f/V1StGXR8_Z5jdHi6B-myT
    return file.url;
  } catch (error) {
    // Errors carry a stable `code`. AUTH and VALIDATION are configuration
    // faults worth naming in the log, since retrying cannot fix them.
    const code = error?.code ? ` [${error.code}]` : '';
    throw new Error(`UnionStack upload failed${code}: ${error.message}`);
  }
}
