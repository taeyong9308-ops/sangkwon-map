-- 상권 기입 지도 v2 · Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run. (여러 번 실행해도 안전)

create extension if not exists pgcrypto;

-- 후보 지역 (마곡·발산, 철산 …)
create table if not exists public.regions (
  id uuid primary key default gen_random_uuid(),
  name text not null default '새 지역',
  center jsonb, level int default 4,
  zones jsonb not null default '[]',          -- 구역 경계 [{name, pts:[[lat,lng],..]}]
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- 라인(상가 라인·블록 면) 또는 지점(사거리·몰)
create table if not exists public.lines (
  id uuid primary key default gen_random_uuid(),
  region_id uuid references public.regions(id) on delete cascade,
  no int, name text not null default '새 라인', zone text default '',
  kind text not null default 'line' check (kind in ('line','node')),
  pts jsonb not null default '[]', r_m int,
  ratings jsonb not null default '{}', notes jsonb not null default '{}',
  tags jsonb not null default '[]', memo text not null default '', photos jsonb not null default '[]',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.lines add column if not exists region_id uuid references public.regions(id) on delete cascade;

-- 매장
create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  region_id uuid references public.regions(id) on delete cascade,
  name text not null default '', category text default '',
  lat double precision not null, lng double precision not null,
  place jsonb, line_id uuid references public.lines(id) on delete set null,
  memo text not null default '', tags jsonb not null default '[]', photos jsonb not null default '[]',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- 매장 시간대별 관찰 (영업 여부·혼잡·웨이팅)
create table if not exists public.store_obs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  region_id uuid references public.regions(id) on delete cascade,
  at timestamptz not null default now(), slot text,
  open text default '영업', pct int, is_full boolean default false, wait int, teams int,
  note text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists store_obs_store on public.store_obs(store_id, at desc);

-- 매물
create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  region_id uuid references public.regions(id) on delete cascade,
  title text default '', address text default '', floor text default '',
  lat double precision not null, lng double precision not null,
  status text default '검토중', source text default '',
  deposit text, rent text, premium text, mgmt text, area_ex text, area_ct text,   -- 만원 / 평 (입력 그대로)
  line_id uuid references public.lines(id) on delete set null,
  memo text not null default '', photos jsonb not null default '[]',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- 메모 핀
create table if not exists public.pins (
  id uuid primary key default gen_random_uuid(),
  region_id uuid references public.regions(id) on delete cascade,
  kind text not null default '관찰', title text not null default '', text text not null default '',
  slot text not null default 'all', lat double precision not null, lng double precision not null,
  place jsonb, photos jsonb not null default '[]',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.pins add column if not exists region_id uuid references public.regions(id) on delete cascade;

-- 음성 원문
create table if not exists public.voice_log (
  id uuid primary key default gen_random_uuid(),
  region_id uuid references public.regions(id) on delete cascade,
  text text not null default '', at timestamptz not null default now(), slot text, applied int default 0,
  lat double precision, lng double precision,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- 앱 개선 요청
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  region_id uuid references public.regions(id) on delete set null,
  text text not null default '', at timestamptz not null default now(), view text, done boolean default false, reply text default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- 로그인한 사람만 읽고 쓰기 + 실시간 동기화
do $$ declare t text; begin
  foreach t in array array['regions','lines','stores','store_obs','listings','pins','voice_log','feedback'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "auth all" on public.%I', t);
    execute format('create policy "auth all" on public.%I for all to authenticated using (true) with check (true)', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    begin execute format('alter publication supabase_realtime add table public.%I', t); exception when others then null; end;
  end loop;
end $$;

-- 사진 저장소 (공개 URL, 파일명은 무작위)
insert into storage.buckets (id, name, public) values ('photos','photos', true) on conflict (id) do nothing;
drop policy if exists "auth upload photos" on storage.objects;
drop policy if exists "auth delete photos" on storage.objects;
create policy "auth upload photos" on storage.objects for insert to authenticated with check (bucket_id = 'photos');
create policy "auth delete photos" on storage.objects for delete to authenticated using (bucket_id = 'photos');
