import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { idList } from '@/lib/validate';

// Programmes and tabs are the same shape, so one handler covers both rather
// than two near-identical routes.
const TABLES = { programme: 'programmes', tab: 'tabs' };

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const { kind, name } = body;
  const table = TABLES[kind];
  const trimmed = (name ?? '').trim();

  if (!table) return NextResponse.json({ error: 'Unknown kind.' }, { status: 400 });
  if (!trimmed) return NextResponse.json({ error: 'Enter a name.' }, { status: 400 });

  // New entries go to the end of the row they appear in.
  const last = await supabase
    .from(table)
    .select('position')
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last.error) {
    return NextResponse.json({ error: last.error.message }, { status: 500 });
  }

  const { data, error } = await supabase
    .from(table)
    .insert({ name: trimmed, position: (last.data?.position ?? 0) + 1 })
    .select('id, name, position')
    .single();

  if (error) {
    // 23505 is unique_violation — the name is already in the list, which is a
    // typo on the user's side rather than a server fault.
    if (error.code === '23505') {
      return NextResponse.json({ error: `"${trimmed}" already exists.` }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // A tab is only visible under the programmes it is linked to, so link it to
  // whichever programmes the form has ticked. A new programme starts with
  // every existing tab, matching how the seed sets programmes up.
  const links =
    kind === 'tab'
      ? idList(body.programme_ids).map((programme_id) => ({ programme_id, tab_id: data.id }))
      : (await supabase.from('tabs').select('id')).data?.map((tab) => ({
          programme_id: data.id,
          tab_id: tab.id,
        })) ?? [];

  if (links.length) {
    const linked = await supabase
      .from('programme_tabs')
      .upsert(links, { onConflict: 'programme_id,tab_id' });
    if (linked.error) {
      return NextResponse.json({ error: linked.error.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ...data, links }, { status: 201 });
}
