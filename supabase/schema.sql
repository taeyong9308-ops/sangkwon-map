-- 상권 기입 지도 · Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run. (한 번만)

create extension if not exists pgcrypto;

-- 라인(상가 라인·블록 면) 또는 지점(사거리·몰)
create table if not exists public.lines (
  id         uuid primary key default gen_random_uuid(),
  no         int,
  name       text not null default '새 라인',
  zone       text default '',
  kind       text not null default 'line' check (kind in ('line','node')),
  pts        jsonb not null default '[]',   -- [{"lat":..,"lon":..}, ...]
  r_m        int,                           -- 지점(node) 반경, 미터
  ratings    jsonb not null default '{}',   -- {"wl":"많음","wd":"","sl":"보통","sd":""}
  notes      jsonb not null default '{}',   -- 시간대별 관찰 메모
  tags       jsonb not null default '[]',
  memo       text  not null default '',
  photos     jsonb not null default '[]',   -- 사진 URL 목록
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 메모 핀 (관찰 / 특징 / 매물)
create table if not exists public.pins (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null default '관찰',
  title      text not null default '',
  text       text not null default '',
  slot       text not null default 'all',   -- all | wl | wd | sl | sd
  lat        double precision not null,
  lng        double precision not null,
  place      jsonb,                         -- 카카오 장소 검색으로 만든 경우 장소 정보
  photos     jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 로그인한 사람만 읽고 쓰기
alter table public.lines enable row level security;
alter table public.pins  enable row level security;
drop policy if exists "auth all lines" on public.lines;
drop policy if exists "auth all pins"  on public.pins;
create policy "auth all lines" on public.lines for all to authenticated using (true) with check (true);
create policy "auth all pins"  on public.pins  for all to authenticated using (true) with check (true);

-- 폰·PC 실시간 동기화
do $$ begin
  begin alter publication supabase_realtime add table public.lines; exception when others then null; end;
  begin alter publication supabase_realtime add table public.pins;  exception when others then null; end;
end $$;

-- 사진 저장소 (공개 URL, 파일명은 무작위)
insert into storage.buckets (id, name, public) values ('photos','photos', true)
on conflict (id) do nothing;
drop policy if exists "auth upload photos" on storage.objects;
drop policy if exists "auth delete photos" on storage.objects;
create policy "auth upload photos" on storage.objects for insert to authenticated with check (bucket_id = 'photos');
create policy "auth delete photos" on storage.objects for delete to authenticated using (bucket_id = 'photos');
