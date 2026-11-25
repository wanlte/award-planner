-- 任务奖励规划器 · Supabase 建表脚本
-- 用法：Supabase 控制台 → SQL Editor → New query → 整段粘贴 → Run
-- 执行完在 Table Editor 里能看到 planner_users / planner_goals / planner_tasks / planner_meta
-- 重复执行也安全（都是 create ... if not exists / create or replace）

-- ---------- 表 ----------

create table if not exists planner_meta (
  id         integer primary key,
  version    integer     not null default 3,
  revision   bigint      not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists planner_users (
  id             text primary key,
  name           text not null,
  created_at     timestamptz,
  linked_user_id text
);

create table if not exists planner_goals (
  user_id    text    not null references planner_users (id) on delete cascade,
  id         text    not null,
  name       text    not null,
  target     numeric not null default 0,
  note       text,
  created_at timestamptz,
  position   integer not null default 0,
  primary key (user_id, id)
);

create table if not exists planner_tasks (
  user_id       text    not null references planner_users (id) on delete cascade,
  goal_id       text    not null,
  id            text    not null,
  title         text    not null,
  content       text,
  start_at      timestamptz,
  end_at        timestamptz,
  difficulty    text,
  reward        numeric,
  actual_reward numeric,
  status        text,
  created_at    timestamptz,
  updated_at    timestamptz,
  completed_at  timestamptz,
  metrics       jsonb   not null default '{}'::jsonb,
  position      integer not null default 0,
  primary key (user_id, id)
);

create index if not exists planner_goals_user_idx on planner_goals (user_id, position);
create index if not exists planner_tasks_goal_idx on planner_tasks (user_id, goal_id, position);

-- ---------- 读取：一次 RPC 拿回全部数据 ----------

create or replace function planner_load()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'meta',
      coalesce(
        (
          select jsonb_build_object(
            'version',   m.version,
            'revision',  m.revision,
            'createdAt', to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
          from planner_meta m
          where m.id = 1
        ),
        'null'::jsonb
      ),
    'users',
      coalesce(
        (select jsonb_agg(to_jsonb(u) order by u.id) from planner_users u),
        '[]'::jsonb
      ),
    'goals',
      coalesce(
        (select jsonb_agg(to_jsonb(g) order by g.user_id, g.position) from planner_goals g),
        '[]'::jsonb
      ),
    'tasks',
      coalesce(
        (select jsonb_agg(to_jsonb(t) order by t.user_id, t.position) from planner_tasks t),
        '[]'::jsonb
      )
  );
$$;

-- ---------- 写入：整份状态在一个事务里落库 ----------

create or replace function planner_save(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into planner_meta (id, version, revision, created_at)
  values (
    1,
    coalesce((p ->> 'version')::int, 3),
    coalesce((p ->> 'revision')::bigint, 0),
    coalesce((p ->> 'createdAt')::timestamptz, now())
  )
  on conflict (id) do update
    set version    = excluded.version,
        revision   = excluded.revision,
        created_at = excluded.created_at;

  delete from planner_tasks;
  delete from planner_goals;
  delete from planner_users;

  insert into planner_users (id, name, created_at, linked_user_id)
  select
    x ->> 'id',
    coalesce(x ->> 'name', ''),
    (x ->> 'created_at')::timestamptz,
    nullif(x ->> 'linked_user_id', '')
  from jsonb_array_elements(coalesce(p -> 'users', '[]'::jsonb)) as x;

  insert into planner_goals (user_id, id, name, target, note, created_at, position)
  select
    x ->> 'user_id',
    x ->> 'id',
    coalesce(x ->> 'name', ''),
    coalesce((x ->> 'target')::numeric, 0),
    x ->> 'note',
    (x ->> 'created_at')::timestamptz,
    coalesce((x ->> 'position')::int, 0)
  from jsonb_array_elements(coalesce(p -> 'goals', '[]'::jsonb)) as x;

  insert into planner_tasks (
    user_id, goal_id, id, title, content, start_at, end_at, difficulty,
    reward, actual_reward, status, created_at, updated_at, completed_at, metrics, position
  )
  select
    x ->> 'user_id',
    x ->> 'goal_id',
    x ->> 'id',
    coalesce(x ->> 'title', ''),
    x ->> 'content',
    (x ->> 'start_at')::timestamptz,
    (x ->> 'end_at')::timestamptz,
    x ->> 'difficulty',
    (x ->> 'reward')::numeric,
    case
      when x ->> 'actual_reward' is null or x ->> 'actual_reward' = '' then null
      else (x ->> 'actual_reward')::numeric
    end,
    x ->> 'status',
    (x ->> 'created_at')::timestamptz,
    (x ->> 'updated_at')::timestamptz,
    (x ->> 'completed_at')::timestamptz,
    coalesce((x -> 'metrics_json')::jsonb, '{}'::jsonb),
    coalesce((x ->> 'position')::int, 0)
  from jsonb_array_elements(coalesce(p -> 'tasks', '[]'::jsonb)) as x;
end;
$$;

-- ---------- 权限 ----------

grant select, insert, update, delete
  on planner_meta, planner_users, planner_goals, planner_tasks
  to service_role;

grant execute on function planner_load() to service_role;
grant execute on function planner_save(jsonb) to service_role;

-- RLS 开着也不影响：服务端用 service_role key，绕过行级策略。
alter table planner_meta   enable row level security;
alter table planner_users  enable row level security;
alter table planner_goals  enable row level security;
alter table planner_tasks  enable row level security;
