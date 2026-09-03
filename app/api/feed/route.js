import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// Read-only view of public data (the screenshots already sit in a public
// bucket), so the display site can call this straight from the browser
// whatever origin it runs on.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const programmeId = Number(searchParams.get('programme')) || null;
  const tabId = Number(searchParams.get('tab')) || null;
  const limit = Math.min(Number(searchParams.get('limit')) || 60, 200);

  const [programmes, tabs, links] = await Promise.all([
    supabase.from('programmes').select('id, name').order('position'),
    supabase.from('tabs').select('id, name, position').order('position'),
    supabase.from('programme_tabs').select('programme_id, tab_id'),
  ]);

  const failed = [programmes, tabs, links].find((result) => result.error);
  if (failed) {
    return NextResponse.json({ error: failed.error.message }, { status: 500, headers: CORS });
  }

  const allTabs = tabs.data ?? [];
  const allLinks = links.data ?? [];

  // Each programme carries its own tab bar, so the frontend can render the
  // strip without a second call or a lookup of its own.
  const programmeList = (programmes.data ?? []).map((programme) => ({
    ...programme,
    tabs: allTabs
      .filter((tab) =>
        allLinks.some((link) => link.programme_id === programme.id && link.tab_id === tab.id)
      )
      .map(({ id, name }) => ({ id, name })),
  }));

  // Same two-step as the admin page: narrow by placement, then load the posts
  // with every placement they have, so a filtered response still says where
  // else each post appears.
  let placements = supabase.from('post_placements').select('post_id').eq('is_active', true);
  if (programmeId) placements = placements.eq('programme_id', programmeId);
  if (tabId) placements = placements.eq('tab_id', tabId);
  const matched = await placements;
  if (matched.error) {
    return NextResponse.json({ error: matched.error.message }, { status: 500, headers: CORS });
  }

  const postIds = [...new Set((matched.data ?? []).map((row) => row.post_id))];

  const posts = postIds.length
    ? await supabase
        .from('linkedin_posts')
        // post_placements reaches programmes and tabs through the composite
        // key on programme_tabs, which PostgREST cannot follow, so the names
        // are joined below from the lists already loaded above.
        .select('id, url, screenshot_url, created_at, post_placements(programme_id, tab_id, is_active)')
        .in('id', postIds)
        .order('created_at', { ascending: false })
        .limit(limit)
    : { data: [] };

  if (posts.error) {
    return NextResponse.json({ error: posts.error.message }, { status: 500, headers: CORS });
  }

  const programmeName = new Map((programmes.data ?? []).map((row) => [row.id, row.name]));
  const tabName = new Map(allTabs.map((row) => [row.id, row.name]));

  return NextResponse.json(
    {
      programmes: programmeList,
      tabs: allTabs.map(({ id, name }) => ({ id, name })),
      filter: { programme_id: programmeId, tab_id: tabId },
      posts: (posts.data ?? []).map((post) => ({
        id: post.id,
        url: post.url,
        screenshot_url: post.screenshot_url,
        created_at: post.created_at,
        placements: post.post_placements
          .filter((placement) => placement.is_active)
          .map((placement) => ({
            programme_id: placement.programme_id,
            programme: programmeName.get(placement.programme_id),
            tab_id: placement.tab_id,
            tab: tabName.get(placement.tab_id),
          })),
      })),
    },
    { headers: CORS }
  );
}
