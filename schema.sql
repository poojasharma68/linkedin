create table programmes (
  id bigint generated always as identity primary key,
  name text not null unique,
  -- Display order of the programme filter; alphabetical would scramble it.
  position int not null default 0
);

-- The shared tab vocabulary. One "Life" row that every programme points at,
-- which is what lets "All programmes + Life" collect Life posts across every
-- programme in a single query instead of matching on name.
create table tabs (
  id bigint generated always as identity primary key,
  name text not null unique,
  position int not null default 0
);

-- Which tabs each programme shows. A programme has many tabs, and a tab is
-- reused by many programmes, so the two are joined rather than nested.
create table programme_tabs (
  programme_id bigint not null references programmes on delete cascade,
  tab_id bigint not null references tabs on delete cascade,
  primary key (programme_id, tab_id)
);

-- One row per captured URL. The screenshot is taken once, no matter how many
-- programme/tab pairs the post ends up filed under.
create table linkedin_posts (
  id bigint generated always as identity primary key,
  url text not null unique,
  screenshot_url text not null,
  created_at timestamptz not null default now()
);

-- Where a post shows up. A post can have as many of these as it needs, so the
-- same URL can appear under several programmes and several tabs at once.
-- The composite foreign key means a post can only be filed under a pair the
-- programme actually has, and unlinking a tab from a programme clears the
-- posts filed there rather than leaving them orphaned.
create table post_placements (
  post_id bigint not null references linkedin_posts on delete cascade,
  programme_id bigint not null,
  tab_id bigint not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (post_id, programme_id, tab_id),
  foreign key (programme_id, tab_id)
    references programme_tabs (programme_id, tab_id) on delete cascade
);

create index on post_placements (tab_id) where is_active;
create index on post_placements (programme_id, tab_id) where is_active;

-- No policies are defined on purpose: every read and write goes through the
-- server with the service role key, which bypasses RLS. Enabling RLS without
-- policies means a leaked anon key still grants nothing.
alter table programmes enable row level security;
alter table tabs enable row level security;
alter table programme_tabs enable row level security;
alter table linkedin_posts enable row level security;
alter table post_placements enable row level security;

-- The 'linkedin-screenshots' bucket is created through the storage API, not
-- here: storage.buckets is owned by supabase_storage_admin and inserting into
-- it from the SQL editor fails with "permission denied for table buckets".
--   npm run storage:init

insert into programmes (name, position) values
  ('UG Programmes', 1),
  ('PG Programmes', 2),
  ('Executive Education', 3),
  ('PGP Bharat', 4)
on conflict (name) do nothing;

insert into tabs (name, position) values
  ('Life', 1),
  ('Faculty', 2),
  ('Curriculum', 3),
  ('Careers', 4),
  ('Entrepreneurship', 5),
  ('Dropshipping', 6)
on conflict (name) do nothing;

-- Start every programme with the full tab list. Drop the rows you don't want
-- per programme; the tab bar for a programme is exactly what is linked here.
insert into programme_tabs (programme_id, tab_id)
select p.id, t.id from programmes p cross join tabs t
on conflict do nothing;
