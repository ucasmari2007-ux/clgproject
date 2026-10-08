-- =====================================================================
-- TreeAI — Tamil Nadu Tree Intelligence
-- Complete Supabase schema. Paste ALL of this into
--   Supabase Dashboard -> SQL Editor -> New query -> Run
-- It is safe to run more than once (idempotent).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Helper: keep updated_at fresh
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 1. profiles  (one row per auth user)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile when someone signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Back-fill profiles for users who signed up before this script ran
insert into public.profiles (id, display_name)
select u.id, coalesce(nullif(trim(u.raw_user_meta_data ->> 'name'), ''), split_part(u.email, '@', 1))
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. tree_species  (reference catalogue — add as many rows as you like)
-- ---------------------------------------------------------------------
create table if not exists public.tree_species (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name            text not null,
  tamil_name      text,
  scientific_name text not null unique,
  family          text,
  category        text not null default 'Native'
                  check (category in ('Native','Fruit','Medicinal','Agricultural','Forest','Ornamental','Other')),
  description     text,
  uses            text,
  color_from      text not null default '#6fcf8e',
  color_to        text not null default '#2f8f7c',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_tree_species_category on public.tree_species (category);
create index if not exists idx_tree_species_name_lower on public.tree_species (lower(name));
create unique index if not exists idx_tree_species_sci_lower on public.tree_species (lower(scientific_name));

drop trigger if exists trg_tree_species_updated on public.tree_species;
create trigger trg_tree_species_updated
  before update on public.tree_species
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 3. tree_diseases  (diseases / pests / disorders linked to a species)
-- ---------------------------------------------------------------------
create table if not exists public.tree_diseases (
  id          uuid primary key default gen_random_uuid(),
  species_id  uuid not null references public.tree_species (id) on delete cascade,
  name        text not null,
  kind        text not null default 'Disease' check (kind in ('Disease','Pest','Disorder')),
  severity    text not null default 'Moderate' check (severity in ('Low','Moderate','High')),
  symptoms    jsonb not null default '[]'::jsonb,
  causes      jsonb not null default '[]'::jsonb,
  management  jsonb not null default '[]'::jsonb,
  prevention  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  unique (species_id, name)
);

create index if not exists idx_tree_diseases_species on public.tree_diseases (species_id);

-- ---------------------------------------------------------------------
-- 4. scan_results  (one row per saved scan)
-- ---------------------------------------------------------------------
create table if not exists public.scan_results (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  species_id         uuid references public.tree_species (id) on delete set null,
  image_path         text not null,          -- path inside the private "tree-images" bucket
  image_url          text,                   -- optional (only if you make the bucket public)
  tree_name          text not null,
  tamil_name         text,
  scientific_name    text,
  family             text,
  plant_part         text,
  confidence         smallint not null default 0 check (confidence between 0 and 100),
  health_status      text not null default 'Unknown'
                     check (health_status in ('Healthy','Minor concerns','Needs attention','Unhealthy','Unknown')),
  disease            text,
  disease_confidence smallint not null default 0 check (disease_confidence between 0 and 100),
  severity           text not null default 'Unknown'
                     check (severity in ('None','Low','Moderate','High','Unknown')),
  summary            text,
  symptoms           jsonb not null default '[]'::jsonb,
  causes             jsonb not null default '[]'::jsonb,
  treatment          jsonb not null default '[]'::jsonb,
  prevention         jsonb not null default '[]'::jsonb,
  observations       jsonb not null default '[]'::jsonb,
  ai_model           text,
  created_at         timestamptz not null default now(),
  constraint scan_results_unique_image unique (user_id, image_path),
  constraint scan_results_image_path_owner check (image_path like user_id::text || '/%')
);

create index if not exists idx_scan_results_user_created on public.scan_results (user_id, created_at desc);
create index if not exists idx_scan_results_species on public.scan_results (species_id);
create index if not exists idx_scan_results_health on public.scan_results (user_id, health_status);

-- ---------------------------------------------------------------------
-- 5. scan_symptoms  (symptoms normalised, one row each — handy for search/analytics)
-- ---------------------------------------------------------------------
create table if not exists public.scan_symptoms (
  id         uuid primary key default gen_random_uuid(),
  scan_id    uuid not null references public.scan_results (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  symptom    text not null,
  position   smallint not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_scan_symptoms_scan on public.scan_symptoms (scan_id);
create index if not exists idx_scan_symptoms_user on public.scan_symptoms (user_id);

-- ---------------------------------------------------------------------
-- 6. scan_history  (a read-only view: scans joined with the species catalogue)
--    security_invoker => the caller's Row Level Security still applies.
-- ---------------------------------------------------------------------
create or replace view public.scan_history
with (security_invoker = true) as
select
  r.id,
  r.user_id,
  r.image_path,
  r.tree_name,
  r.tamil_name,
  r.scientific_name,
  r.confidence,
  r.health_status,
  r.disease,
  r.severity,
  r.created_at,
  s.slug     as species_slug,
  s.category as species_category
from public.scan_results r
left join public.tree_species s on s.id = r.species_id;

-- ---------------------------------------------------------------------
-- 7. Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.tree_species  enable row level security;
alter table public.tree_diseases enable row level security;
alter table public.scan_results  enable row level security;
alter table public.scan_symptoms enable row level security;

-- profiles: a user can read & update only their own profile
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- reference data: anyone can read; only the service role (server) can write
drop policy if exists "species_read_all" on public.tree_species;
create policy "species_read_all" on public.tree_species
  for select to anon, authenticated using (true);

drop policy if exists "diseases_read_all" on public.tree_diseases;
create policy "diseases_read_all" on public.tree_diseases
  for select to anon, authenticated using (true);

-- scan_results: full control over your own rows only
drop policy if exists "scans_select_own" on public.scan_results;
create policy "scans_select_own" on public.scan_results
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "scans_insert_own" on public.scan_results;
create policy "scans_insert_own" on public.scan_results
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "scans_update_own" on public.scan_results;
create policy "scans_update_own" on public.scan_results
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "scans_delete_own" on public.scan_results;
create policy "scans_delete_own" on public.scan_results
  for delete to authenticated using (user_id = (select auth.uid()));

-- scan_symptoms: only for scans you own
drop policy if exists "symptoms_select_own" on public.scan_symptoms;
create policy "symptoms_select_own" on public.scan_symptoms
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "symptoms_insert_own" on public.scan_symptoms;
create policy "symptoms_insert_own" on public.scan_symptoms
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.scan_results r where r.id = scan_id and r.user_id = (select auth.uid()))
  );

drop policy if exists "symptoms_delete_own" on public.scan_symptoms;
create policy "symptoms_delete_own" on public.scan_symptoms
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- 8. Table privileges (RLS above decides which rows are visible)
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select on public.tree_species, public.tree_diseases to anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.scan_results to authenticated;
grant select, insert, delete on public.scan_symptoms to authenticated;
grant select on public.scan_history to authenticated;

-- ---------------------------------------------------------------------
-- 9. Storage: private bucket "tree-images"
--    Files live at  <user-id>/<file-name>  and only that user can touch them.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tree-images', 'tree-images', false, 8388608, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "tree_images_select_own" on storage.objects;
create policy "tree_images_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'tree-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "tree_images_insert_own" on storage.objects;
create policy "tree_images_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'tree-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "tree_images_update_own" on storage.objects;
create policy "tree_images_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'tree-images' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'tree-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "tree_images_delete_own" on storage.objects;
create policy "tree_images_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'tree-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------------------------------------------------------------------
-- 10. Seed: tree species common in Tamil Nadu
--     (add more rows any time; the AI scanner is NOT limited to this list)
-- ---------------------------------------------------------------------
insert into public.tree_species
  (slug, name, tamil_name, scientific_name, family, category, description, uses, color_from, color_to)
values
 ('mango','Mango','மாமரம்','Mangifera indica','Anacardiaceae','Fruit',
  'A large evergreen tree common in home gardens and orchards across Tamil Nadu, with long glossy leaves and dense shade.',
  'Fruit (fresh, pickles, juice), shade, timber, festival leaves.','#6fcf8e','#2f8f7c'),
 ('neem','Neem','வேம்பு','Azadirachta indica','Meliaceae','Medicinal',
  'A hardy, fast-growing tree that tolerates heat and poor soil, with compound leaves with toothed leaflets.',
  'Traditional medicine, natural pest-repellent leaves and seed oil, shade, village-temple tree.','#8bd98a','#3aa39a'),
 ('coconut','Coconut','தென்னை','Cocos nucifera','Arecaceae','Agricultural',
  'A tall, unbranched palm with a crown of long feather-like fronds, widely grown on farms and coastal belts.',
  'Coconuts, oil, coir, toddy, thatch and timber.','#e6b45e','#c98f3a'),
 ('banyan','Banyan','ஆலமரம்','Ficus benghalensis','Moraceae','Native',
  'A huge spreading fig that grows aerial prop roots, with large, leathery oval leaves.',
  'Shade and shelter, wildlife habitat, cultural and religious importance.','#6fcf8e','#245c46'),
 ('tamarind','Tamarind','புளியமரம்','Tamarindus indica','Fabaceae','Fruit',
  'A long-lived, dense tree with finely divided feathery leaves and brown pods holding tangy pulp.',
  'Culinary pulp, shade, timber, traditional uses.','#dd8f80','#b1604f'),
 ('guava','Guava','கொய்யா','Psidium guajava','Myrtaceae','Fruit',
  'A small tree with smooth, peeling, mottled bark and oval leaves with prominent veins.',
  'Fruit rich in vitamin C, leaves used in traditional remedies.','#a8d8b9','#3aa39a'),
 ('jackfruit','Jackfruit','பலாமரம்','Artocarpus heterophyllus','Moraceae','Fruit',
  'A large evergreen tree bearing very large fruits directly on the trunk and main branches.',
  'Fruit, seeds, timber, fodder.','#e6b45e','#8f6a2f'),
 ('drumstick','Drumstick','முருங்கை','Moringa oleifera','Moringaceae','Medicinal',
  'A fast-growing, drought-tolerant tree with delicate, feathery leaves and long, ridged seed pods.',
  'Pods and leaves as nutritious food, traditional medicine.','#8bd98a','#2f8f6f'),
 ('teak','Teak','தேக்கு','Tectona grandis','Lamiaceae','Forest',
  'A tall deciduous tree with very large, rough leaves that shed in the dry season.',
  'High-value durable timber, furniture and construction.','#3aa39a','#1f5a54'),
 ('peepal','Peepal','அரசமரம்','Ficus religiosa','Moraceae','Native',
  'A large fig tree with heart-shaped leaves ending in a long drip-tip that flutter in the slightest breeze.',
  'Shade, wildlife food, cultural and religious significance.','#6fcf8e','#2f8f6f'),
 ('amla','Indian Gooseberry (Amla)','நெல்லிமரம்','Phyllanthus emblica','Phyllanthaceae','Medicinal',
  'A small to medium tree with feathery, fern-like branchlets and round, pale-green ribbed fruit.',
  'Vitamin-C-rich fruit, pickles, traditional Ayurvedic and Siddha uses.','#a8d8b9','#3aa39a'),
 ('casuarina','Casuarina','சவுக்கு','Casuarina equisetifolia','Casuarinaceae','Forest',
  'A fast-growing evergreen with fine, needle-like green branchlets, common along the Tamil Nadu coast.',
  'Windbreaks and coastal shelterbelts, pulpwood, poles and firewood.','#9bb3a6','#556e62')
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- 11. Seed: common diseases / pests (conservative, general guidance only)
-- ---------------------------------------------------------------------
insert into public.tree_diseases (species_id, name, kind, severity, symptoms, causes, management, prevention)
select s.id, d.name, d.kind, d.severity, d.symptoms::jsonb, d.causes::jsonb, d.management::jsonb, d.prevention::jsonb
from (values
 ('mango','Anthracnose','Disease','Moderate',
  '["Dark, sunken spots on leaves, flowers and fruit","Blossom blight and flower drop","Spots enlarge in humid weather"]',
  '["Fungal infection that spreads in warm, humid, wet weather"]',
  '["Prune and safely dispose of affected twigs and leaves","Avoid overhead watering","Ask your local agriculture officer before using any fungicide"]',
  '["Keep the canopy open for air flow","Collect and remove fallen infected leaves and fruit","Avoid wounding fruit during harvest"]'),
 ('mango','Powdery mildew','Disease','Moderate',
  '["White powdery coating on flowers, young leaves and fruitlets","Flower and young fruit drop"]',
  '["Fungal disease favoured by cool nights and dry, cloudy weather during flowering"]',
  '["Prune affected panicles and shoots","Improve air circulation","Consult an agriculture officer for approved treatments"]',
  '["Regular canopy pruning","Avoid excess nitrogen fertiliser"]'),
 ('neem','Die-back (twig blight)','Disease','Moderate',
  '["Drying of young shoots from the tip downwards","Leaf browning and shedding","Dark patches on twigs"]',
  '["Fungal infection often worsened by drought stress and wounds"]',
  '["Prune dead and dying branches back to healthy wood","Dispose of cuttings away from the tree","Water deeply during long dry spells"]',
  '["Avoid mechanical injuries","Keep trees well watered in dry months","Do not overcrowd plantings"]'),
 ('coconut','Bud rot','Disease','High',
  '["Youngest (spear) leaf turns yellow-brown and wilts","Foul smell near the crown","Crown rots in advanced cases"]',
  '["Fungus-like pathogen that thrives in heavy rain and waterlogging"]',
  '["Seek help from your agriculture/horticulture officer quickly — this can kill the palm","Remove rotten tissue only under expert guidance"]',
  '["Improve drainage around palms","Avoid water collecting in the crown","Keep the palm clean and well nourished"]'),
 ('coconut','Red palm weevil damage','Pest','High',
  '["Holes and chewed fibre on the trunk or crown","Brown ooze from the trunk","Wilting and collapse of central fronds"]',
  '["Large red weevil whose grubs tunnel into the palm"]',
  '["Report early to the local agriculture department","Avoid wounding the trunk and crown","Expert-guided trapping and treatment only"]',
  '["Do not leave cut fronds or stumps that attract weevils","Inspect palms regularly"]'),
 ('banyan','Leaf spot','Disease','Low',
  '["Brown or black spots with yellow halos on leaves","Premature leaf fall in wet weather"]',
  '["Fungal or bacterial leaf infection favoured by humidity"]',
  '["Rake and remove fallen leaves","Prune very affected branches if reachable","Usually tolerated by mature trees"]',
  '["Avoid wetting foliage in the evening","Maintain general tree vigour"]'),
 ('tamarind','Powdery mildew','Disease','Low',
  '["White powdery growth on young leaves and flowers","Poor flowering or fruit set"]',
  '["Fungal disease during cool, dry-humid periods"]',
  '["Prune affected shoots","Keep the canopy open","Check with an agriculture officer before any treatment"]',
  '["Avoid dense, crowded canopies"]'),
 ('guava','Wilt','Disease','High',
  '["Sudden yellowing and wilting of branches","Leaves curl and drop","Whole branches or the tree dies"]',
  '["Soil-borne fungus that enters through roots, worse in poorly drained soil"]',
  '["Remove and destroy dead trees and roots","Do not replant guava in the same spot immediately","Seek expert advice"]',
  '["Plant in well-drained soil","Avoid root injury","Use healthy, disease-free saplings"]'),
 ('guava','Fruit anthracnose','Disease','Moderate',
  '["Dark sunken spots on fruit","Fruit rots as it ripens"]',
  '["Fungal infection promoted by wet, humid conditions"]',
  '["Remove infected fruit","Prune for air flow","Harvest carefully to avoid bruising"]',
  '["Clean up fallen fruit and leaves","Avoid overhead irrigation"]'),
 ('jackfruit','Fruit and flower rot','Disease','Moderate',
  '["Soft brown rot of young fruit and flower spikes","Whitish or dark mould growth"]',
  '["Fungal rot, common in wet, humid weather"]',
  '["Remove and dispose of rotting fruit","Prune to let air and light in"]',
  '["Keep ground around the tree clean","Avoid crowding branches"]'),
 ('drumstick','Cercospora leaf spot','Disease','Low',
  '["Small brown circular spots on leaves","Yellowing and early leaf drop"]',
  '["Fungal leaf infection in humid weather"]',
  '["Remove badly spotted leaves","Improve spacing and air flow"]',
  '["Avoid overhead watering","Do not overcrowd plants"]'),
 ('teak','Leaf skeletoniser / defoliator','Pest','Moderate',
  '["Leaves eaten, leaving only veins (skeletonised)","Patchy defoliation of the crown"]',
  '["Caterpillars of leaf-eating moths, common after rains"]',
  '["Usually the tree recovers; monitor the infestation","Contact the forest or agriculture officer for outbreaks"]',
  '["Maintain stand health and spacing","Encourage natural predators such as birds"]'),
 ('amla','Rust','Disease','Low',
  '["Orange-brown rust-like pustules on leaves and fruit","Fruit blemishes"]',
  '["Fungal rust in humid weather"]',
  '["Remove infected leaves and fruit","Maintain an open canopy"]',
  '["Avoid overcrowding","Keep area under the tree clean"]'),
 ('casuarina','Wilt / root rot','Disease','High',
  '["Branchlets turn yellow then brown","Sudden drying of the tree","Poor growth in waterlogged soil"]',
  '["Soil-borne pathogens, worse with poor drainage and root stress"]',
  '["Remove and destroy dead trees","Seek advice from the forest department"]',
  '["Plant on well-drained sites","Use healthy, certified planting material"]')
) as d(slug, name, kind, severity, symptoms, causes, management, prevention)
join public.tree_species s on s.slug = d.slug
on conflict (species_id, name) do nothing;
