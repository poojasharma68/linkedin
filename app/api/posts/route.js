import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { capturePost } from '@/lib/capture';
import { cdnConfigured, uploadToCdn } from '@/lib/cdn';
import { cleanLinkedInUrl, idList, placementPairs } from '@/lib/validate';

const BUCKET = 'linkedin-screenshots';

export const maxDuration = 60;

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const postUrl = cleanLinkedInUrl(body.url);
  const programmeIds = idList(body.programme_ids);
  const tabIds = idList(body.tab_ids);

  if (!postUrl || !programmeIds.length || !tabIds.length) {
    return NextResponse.json(
      { error: 'Enter a LinkedIn post URL and tick at least one programme and one tab.' },
      { status: 400 }
    );
  }

  try {
    // The same URL can be filed in several places, so look for an existing
    // capture first: re-screenshotting would cost a browser run and leave two
    // slightly different images of the same post.
    const existing = await supabase
      .from('linkedin_posts')
      .select('id, screenshot_url')
      .eq('url', postUrl)
      .maybeSingle();
    if (existing.error) throw existing.error;

    let postId = existing.data?.id;
    let screenshotUrl = existing.data?.screenshot_url;
    // Re-shooting an existing post is opt-in: normally the whole point of the
    // URL lookup is to avoid a second browser run, but a capture that came out
    // wrong needs a way to be redone.
    const captured = !postId || Boolean(body.recapture);

    if (captured) {
      const screenshot = await capturePost(postUrl);
      const previous = screenshotUrl;
      const filename = `${crypto.randomUUID()}.png`;

      // Prefer the CDN when one is configured, but never let it break a
      // capture: the browser run is the expensive part, so a CDN that is down
      // or misconfigured falls back to Supabase rather than throwing away a
      // screenshot that already cost several seconds to take.
      let publicUrl = null;
      if (cdnConfigured()) {
        try {
          publicUrl = await uploadToCdn(screenshot, filename);
        } catch (cdnError) {
          console.error(`CDN upload failed, falling back to Supabase: ${cdnError.message}`);
        }
      }

      if (!publicUrl) {
        const upload = await supabase.storage
          .from(BUCKET)
          .upload(filename, screenshot, { contentType: 'image/png' });
        if (upload.error) throw upload.error;
        publicUrl = supabase.storage.from(BUCKET).getPublicUrl(filename).data.publicUrl;
      }

      screenshotUrl = publicUrl;

      if (postId) {
        const updated = await supabase
          .from('linkedin_posts')
          .update({ screenshot_url: publicUrl })
          .eq('id', postId);
        if (updated.error) throw updated.error;

        // The row now points at the new file, so the old one is unreachable.
        // Only Supabase-hosted files are ours to delete — a CDN URL is left
        // alone, since this service does not own that store.
        const stale = previous?.includes(`/${BUCKET}/`)
          ? previous.split(`${BUCKET}/`)[1]
          : null;
        if (stale) await supabase.storage.from(BUCKET).remove([stale]);
      } else {
        const inserted = await supabase
          .from('linkedin_posts')
          .insert({ url: postUrl, screenshot_url: publicUrl })
          .select('id')
          .single();
        if (inserted.error) throw inserted.error;
        postId = inserted.data.id;
      }
    }

    const pairs = placementPairs(programmeIds, tabIds);

    // A programme only shows the tabs linked to it, and post_placements has a
    // composite key into that link table, so filing a post under a pair the
    // programme doesn't have yet would fail on the foreign key. Adding the
    // link first means "file this under Executive Education / Life" also gives
    // Executive Education a Life tab, rather than being rejected.
    const linked = await supabase
      .from('programme_tabs')
      .upsert(pairs, { onConflict: 'programme_id,tab_id' });
    if (linked.error) throw linked.error;

    // Upsert rather than insert so re-filing a post under a place it already
    // sits is a no-op instead of a primary key violation.
    const placements = pairs.map((pair) => ({ ...pair, post_id: postId, is_active: true }));

    const { error } = await supabase
      .from('post_placements')
      .upsert(placements, { onConflict: 'post_id,programme_id,tab_id' });
    if (error) throw error;

    return NextResponse.json(
      { id: postId, captured, screenshot_url: screenshotUrl, placements: placements.length },
      { status: 201 }
    );
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
