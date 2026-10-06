-- mdh-mdh schema. ids are uuidv7 (PostgreSQL 18).

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  username      text NOT NULL,
  password_hash text NOT NULL,                    -- scrypt, includes its own salt
  default_rollback_policy text NOT NULL DEFAULT 'author_and_write',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9_.-]{3,32}$'),
  CONSTRAINT users_policy_valid CHECK (default_rollback_policy IN ('author_only', 'author_and_write'))
);
CREATE UNIQUE INDEX users_username_key ON users (username);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        text NOT NULL,
  ro_enc      text NOT NULL,                      -- AES-256-GCM, so the owner can copy it again
  rw_enc      text NOT NULL,
  ro_hash     bytea NOT NULL,                     -- HMAC-SHA256, lets a password find its project
  rw_hash     bytea NOT NULL,
  ro_gen      integer NOT NULL DEFAULT 1,         -- bumped on refresh; gate cookies carry it
  rw_gen      integer NOT NULL DEFAULT 1,
  rollback_policy text NOT NULL DEFAULT 'author_and_write',
  last_seq    integer NOT NULL DEFAULT 0,         -- last used change number; bumping it locks the project
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_name_valid CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT projects_policy_valid CHECK (rollback_policy IN ('author_only', 'author_and_write'))
);
CREATE UNIQUE INDEX projects_ro_hash_key ON projects (ro_hash);
CREATE UNIQUE INDEX projects_rw_hash_key ON projects (rw_hash);
CREATE INDEX projects_owner_idx ON projects (owner_id, updated_at DESC);

-- current tree. COLLATE "C" = byte order, so sorting and prefix ranges are predictable.
CREATE TABLE nodes (
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  path        text COLLATE "C" NOT NULL,
  kind        text NOT NULL,
  content     text NOT NULL DEFAULT '',
  version     integer NOT NULL DEFAULT 1,         -- bumped on every save, used for conflict detection
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, path),
  CONSTRAINT nodes_kind_valid CHECK (kind IN ('dir', 'file')),
  CONSTRAINT nodes_dir_has_no_content CHECK (kind = 'file' OR content = ''),
  CONSTRAINT nodes_file_extension CHECK (kind = 'dir' OR path ~* '\.(md|yml|yaml)$'),
  -- a folder can never share a name with a file, so one path is always one kind (history rows rely on it)
  CONSTRAINT nodes_dir_not_file_name CHECK (kind = 'file' OR path !~* '\.(md|yml|yaml)$')
);

CREATE TABLE changes (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id     uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  seq            integer NOT NULL,
  actor_type     text NOT NULL,
  actor_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_name     text NOT NULL DEFAULT '',        -- username, or the name typed at the gate ('' = none)
  kind           text NOT NULL,
  summary        text NOT NULL,
  target_seq     integer,                         -- rollback only: the change that was restored
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, seq),
  CONSTRAINT changes_seq_positive CHECK (seq >= 1),
  CONSTRAINT changes_actor_type_valid CHECK (actor_type IN ('user', 'password')),
  CONSTRAINT changes_kind_valid CHECK (kind IN ('edit', 'create', 'rename', 'delete', 'upload', 'rollback')),
  CONSTRAINT changes_target_only_for_rollback CHECK ((kind = 'rollback') = (target_seq IS NOT NULL))
);

CREATE TABLE change_files (
  change_id  uuid NOT NULL REFERENCES changes (id) ON DELETE CASCADE,
  path       text COLLATE "C" NOT NULL,
  kind       text NOT NULL,
  action     text NOT NULL,
  before     text,                                -- content before ('' for a dir)
  after      text,
  PRIMARY KEY (change_id, path),
  CONSTRAINT change_files_kind_valid CHECK (kind IN ('dir', 'file')),
  CONSTRAINT change_files_action_shape CHECK (
    (action = 'created' AND before IS NULL     AND after IS NOT NULL) OR
    (action = 'deleted' AND before IS NOT NULL AND after IS NULL) OR
    (action = 'updated' AND before IS NOT NULL AND after IS NOT NULL)
  )
);
