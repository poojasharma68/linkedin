import { supabase } from '@/lib/supabase';
import PostForm from './form';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // Only what the form needs to render its checkboxes. Filed posts are not
  // fetched here on purpose: the display site reads them from Supabase, and
  // this page only shows what the current session just added.
  const [programmes, tabs, links] = await Promise.all([
    supabase.from('programmes').select('id, name').order('position'),
    supabase.from('tabs').select('id, name').order('position'),
    supabase.from('programme_tabs').select('programme_id, tab_id'),
  ]);

  return (
    <main>
      <h1>LinkedIn Posts</h1>

      <PostForm
        programmes={programmes.data ?? []}
        tabs={tabs.data ?? []}
        links={links.data ?? []}
      />
    </main>
  );
}
