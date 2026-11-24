-- Bảng, ràng buộc, chỉ mục, RLS của mô đun Intercom. API không ghi thẳng bảng nào: mọi ghi đi qua hàm ở tệp sau.

CREATE TABLE public.intercom_deleter (
    profile_id uuid NOT NULL
);

CREATE TABLE public.intercom_drive_account (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    google_sub text NOT NULL,
    google_email text NOT NULL,
    refresh_token_cipher text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    connected_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT intercom_drive_account_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);

CREATE TABLE public.intercom_drive_bench (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    project_id uuid,
    account_id uuid,
    seq integer,
    bytes integer,
    ms integer,
    attempts integer,
    outcome text,
    error text,
    device text,
    network text,
    upload_mode text,
    file_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.intercom_drive_delete_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    file_id text NOT NULL,
    project_id uuid,
    was_done boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    done_at timestamp with time zone
);

CREATE TABLE public.intercom_drive_gate (
    singleton boolean DEFAULT true NOT NULL,
    gate_hash text NOT NULL,
    CONSTRAINT intercom_drive_gate_gate_hash_check CHECK ((gate_hash ~ '^[0-9a-f]{64}$'::text)),
    -- Băm của chuỗi rỗng: gần như chắc là quên đặt biến lúc tính băm.
    CONSTRAINT intercom_drive_gate_not_empty_check CHECK ((gate_hash <> encode(sha256(''::bytea), 'hex'::text))),
    CONSTRAINT intercom_drive_gate_singleton_check CHECK (singleton)
);

CREATE TABLE public.intercom_drive_permission (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    account_id uuid NOT NULL,
    file_id text NOT NULL,
    purpose text NOT NULL,
    role text NOT NULL,
    permission_id text,
    want text NOT NULL,
    applied_at timestamp with time zone,
    attempts smallint DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT intercom_drive_permission_file_id_check CHECK ((file_id ~ '^[A-Za-z0-9_-]{1,200}$'::text)),
    CONSTRAINT intercom_drive_permission_purpose_check CHECK ((purpose = ANY (ARRAY['folder_share'::text, 'sheet_edit'::text]))),
    CONSTRAINT intercom_drive_permission_role_check CHECK ((role = ANY (ARRAY['reader'::text, 'writer'::text]))),
    CONSTRAINT intercom_drive_permission_want_check CHECK ((want = ANY (ARRAY['on'::text, 'off'::text])))
);

CREATE TABLE public.intercom_drive_pilot (
    project_id uuid NOT NULL
);

CREATE TABLE public.intercom_handover (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    kind text NOT NULL,
    work_date date NOT NULL,
    person_id uuid,
    department text,
    group_no smallint,
    unit_ids uuid[],
    issue_ids uuid[],
    photo_key text NOT NULL,
    thumb_key text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    source text NOT NULL,
    taken_at timestamp with time zone DEFAULT now() NOT NULL,
    size_bytes integer,
    width integer,
    height integer,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    photo_purged_at timestamp with time zone,
    drive_file_id text,
    drive_thumb_file_id text,
    drive_account_id uuid,
    storage_fallback_at timestamp with time zone,
    drive_moved_at timestamp with time zone,
    drive_placed_at timestamp with time zone,
    move_attempts smallint DEFAULT 0 NOT NULL,
    move_last_error text,
    CONSTRAINT intercom_handover_check CHECK (((kind <> 'deliver'::text) OR ((department IS NOT NULL) AND (group_no IS NOT NULL) AND (cardinality(unit_ids) > 0)))),
    CONSTRAINT intercom_handover_check1 CHECK (((kind <> 'collect'::text) OR (cardinality(issue_ids) > 0))),
    CONSTRAINT intercom_handover_group_no_check CHECK (((group_no >= 1) AND (group_no <= 6))),
    CONSTRAINT intercom_handover_height_check CHECK (((height >= 1) AND (height <= 100000))),
    CONSTRAINT intercom_handover_kind_check CHECK ((kind = ANY (ARRAY['deliver'::text, 'collect'::text]))),
    CONSTRAINT intercom_handover_photo_key_check CHECK ((photo_key ~ '^intercom/[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'::text)),
    CONSTRAINT intercom_handover_size_bytes_check CHECK (((size_bytes >= 1) AND (size_bytes <= 2097152))),
    CONSTRAINT intercom_handover_source_check CHECK ((source = ANY (ARRAY['camera'::text, 'library'::text]))),
    CONSTRAINT intercom_handover_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text]))),
    CONSTRAINT intercom_handover_thumb_key_check CHECK ((thumb_key ~ '^intercom/[0-9a-f-]{36}/[0-9a-f-]{36}_t\.jpg$'::text)),
    CONSTRAINT intercom_handover_width_check CHECK (((width >= 1) AND (width <= 100000)))
);

CREATE TABLE public.intercom_issue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    work_date date NOT NULL,
    person_id uuid,
    department text NOT NULL,
    group_no smallint NOT NULL,
    deliver_handover_id uuid NOT NULL,
    collect_handover_id uuid,
    collected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    fault_reason text,
    CONSTRAINT intercom_issue_fault_reason_check CHECK (((fault_reason IS NULL) OR ((btrim(fault_reason) <> ''::text) AND (char_length(fault_reason) <= 200))))
);

CREATE TABLE public.intercom_manager (
    profile_id uuid NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.intercom_member (
    project_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    source text NOT NULL,
    added_by uuid,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT intercom_member_source_check CHECK ((source = ANY (ARRAY['order'::text, 'manual'::text, 'backfill'::text, 'creator'::text])))
);

CREATE TABLE public.intercom_people_sheet (
    project_id uuid NOT NULL,
    kind text NOT NULL,
    file_id text NOT NULL,
    gid text,
    template_file_id text,
    template_account_id uuid,
    edit_closed_reason text,
    loaded_at timestamp with time zone,
    loaded_by uuid,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT intercom_people_sheet_edit_closed_reason_check CHECK ((edit_closed_reason = ANY (ARRAY['ended'::text, 'replaced'::text]))),
    CONSTRAINT intercom_people_sheet_file_id_check CHECK ((file_id ~ '^[A-Za-z0-9_-]{1,200}$'::text)),
    CONSTRAINT intercom_people_sheet_gid_check CHECK (((gid IS NULL) OR (gid ~ '^[0-9]{1,20}$'::text))),
    CONSTRAINT intercom_people_sheet_kind_check CHECK ((kind = ANY (ARRAY['template'::text, 'link'::text]))),
    CONSTRAINT intercom_people_sheet_template_file_id_check CHECK (((template_file_id IS NULL) OR (template_file_id ~ '^[A-Za-z0-9_-]{1,200}$'::text)))
);

CREATE TABLE public.intercom_person (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    full_name text NOT NULL,
    department text NOT NULL,
    group_no smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    phone text,
    CONSTRAINT intercom_person_department_check CHECK ((btrim(department) <> ''::text)),
    CONSTRAINT intercom_person_full_name_check CHECK ((btrim(full_name) <> ''::text)),
    CONSTRAINT intercom_person_group_no_check CHECK (((group_no >= 1) AND (group_no <= 6))),
    CONSTRAINT intercom_person_phone_check CHECK (((phone IS NULL) OR (phone ~ '^0[1-9][0-9]{8}$'::text)))
);

CREATE TABLE public.intercom_project (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    group_count smallint NOT NULL,
    day_count smallint NOT NULL,
    share_token text,
    share_revoked_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    order_id uuid,
    customer_id uuid,
    cover_key text,
    storage_kind text DEFAULT 'r2'::text NOT NULL,
    drive_account_id uuid,
    drive_folder_id text,
    drive_staging_folder_id text,
    CONSTRAINT intercom_project_check CHECK ((end_date >= start_date)),
    CONSTRAINT intercom_project_cover_key_check CHECK (((cover_key IS NULL) OR (cover_key ~ '^intercom/[0-9a-f-]{36}/cover_[0-9a-f-]{36}\.jpg$'::text))),
    CONSTRAINT intercom_project_day_count_check CHECK (((day_count >= 1) AND (day_count <= 60))),
    CONSTRAINT intercom_project_group_count_check CHECK (((group_count >= 1) AND (group_count <= 6))),
    CONSTRAINT intercom_project_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT intercom_project_storage_kind_check CHECK ((storage_kind = ANY (ARRAY['r2'::text, 'drive'::text])))
);

CREATE TABLE public.intercom_unit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    prefix text NOT NULL,
    seq smallint NOT NULL,
    code text GENERATED ALWAYS AS ((prefix ||
CASE
    WHEN (seq = 0) THEN 'M'::text
    ELSE (seq)::text
END)) STORED,
    CONSTRAINT intercom_unit_prefix_check CHECK ((prefix ~ '^[A-Z]{1,4}$'::text)),
    CONSTRAINT intercom_unit_seq_check CHECK (((seq >= 0) AND (seq <= 20)))
);

CREATE TABLE public.intercom_unit_model (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    max_units smallint NOT NULL,
    has_master boolean DEFAULT true NOT NULL,
    is_hub boolean DEFAULT false NOT NULL,
    unit_hours numeric(4,1) NOT NULL,
    master_hours_min numeric(4,1),
    master_hours_max numeric(4,1),
    hub_hours numeric(4,1),
    photo_key text,
    status text DEFAULT 'approved'::text NOT NULL,
    merged_into uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT intercom_unit_model_hub_hours_check CHECK (((hub_hours >= 0.5) AND (hub_hours <= (48)::numeric))),
    CONSTRAINT intercom_unit_model_hub_no_master CHECK ((NOT (is_hub AND has_master))),
    CONSTRAINT intercom_unit_model_master_hours_max_check CHECK (((master_hours_max >= 0.5) AND (master_hours_max <= (48)::numeric))),
    CONSTRAINT intercom_unit_model_master_hours_min_check CHECK (((master_hours_min >= 0.5) AND (master_hours_min <= (48)::numeric))),
    CONSTRAINT intercom_unit_model_merge_self CHECK (((merged_into IS NULL) OR (merged_into <> id))),
    CONSTRAINT intercom_unit_model_name_check CHECK (((name = btrim(name)) AND ((char_length(name) >= 1) AND (char_length(name) <= 60)))),
    CONSTRAINT intercom_unit_model_photo_key_check CHECK (((photo_key IS NULL) OR (photo_key ~ (('^intercom/models/'::text || (id)::text) || '/[0-9a-f-]{36}\.jpg$'::text)))),
    CONSTRAINT intercom_unit_model_status_check CHECK ((status = ANY (ARRAY['approved'::text, 'pending'::text]))),
    CONSTRAINT intercom_unit_model_unit_hours_check CHECK (((unit_hours >= 0.5) AND (unit_hours <= (48)::numeric))),
    CONSTRAINT intercom_unit_model_units_check CHECK (
CASE
    WHEN has_master THEN (((max_units >= 2) AND (max_units <= 21)) AND (master_hours_min IS NOT NULL) AND (master_hours_max IS NOT NULL) AND (master_hours_min <= master_hours_max))
    ELSE (((max_units >= 1) AND (max_units <= 20)) AND (master_hours_min IS NULL) AND (master_hours_max IS NULL))
END)
);

CREATE TABLE public.intercom_unit_set (
    project_id uuid NOT NULL,
    prefix text NOT NULL,
    tag_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    model_id uuid,
    has_master boolean DEFAULT false NOT NULL,
    is_hub boolean DEFAULT false NOT NULL,
    unit_hours numeric(4,1),
    master_hours_min numeric(4,1),
    master_hours_max numeric(4,1),
    hub_hours numeric(4,1),
    CONSTRAINT intercom_unit_set_prefix_check CHECK ((prefix ~ '^[A-Z]{1,4}$'::text)),
    CONSTRAINT intercom_unit_set_tag_note_check CHECK (((tag_note IS NULL) OR ((btrim(tag_note) <> ''::text) AND (char_length(tag_note) <= 60))))
);

CREATE TABLE public.intercom_upload_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    handover_id uuid NOT NULL,
    project_id uuid,
    created_by uuid,
    kind text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone NOT NULL,
    duration_ms integer NOT NULL,
    photo_bytes integer DEFAULT 0 NOT NULL,
    thumb_bytes integer DEFAULT 0 NOT NULL,
    attempts smallint DEFAULT 1 NOT NULL,
    method text NOT NULL,
    outcome text NOT NULL,
    fail_reason text,
    device text,
    network text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT intercom_upload_log_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT intercom_upload_log_device_check CHECK ((char_length(device) <= 120)),
    CONSTRAINT intercom_upload_log_duration_ms_check CHECK ((duration_ms >= 0)),
    CONSTRAINT intercom_upload_log_fail_reason_check CHECK ((char_length(fail_reason) <= 40)),
    CONSTRAINT intercom_upload_log_kind_check CHECK ((kind = ANY (ARRAY['deliver'::text, 'collect'::text]))),
    CONSTRAINT intercom_upload_log_method_check CHECK ((method = ANY (ARRAY['chunk'::text, 'single'::text, 'direct'::text]))),
    CONSTRAINT intercom_upload_log_network_check CHECK ((char_length(network) <= 20)),
    CONSTRAINT intercom_upload_log_outcome_check CHECK ((outcome = ANY (ARRAY['ok'::text, 'fail'::text]))),
    CONSTRAINT intercom_upload_log_photo_bytes_check CHECK ((photo_bytes >= 0)),
    CONSTRAINT intercom_upload_log_thumb_bytes_check CHECK ((thumb_bytes >= 0))
);

ALTER TABLE ONLY public.intercom_deleter
    ADD CONSTRAINT intercom_deleter_pkey PRIMARY KEY (profile_id);

ALTER TABLE ONLY public.intercom_drive_account
    ADD CONSTRAINT intercom_drive_account_google_sub_key UNIQUE (google_sub);

ALTER TABLE ONLY public.intercom_drive_account
    ADD CONSTRAINT intercom_drive_account_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.intercom_drive_bench
    ADD CONSTRAINT intercom_drive_bench_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.intercom_drive_delete_queue
    ADD CONSTRAINT intercom_drive_delete_queue_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.intercom_drive_gate
    ADD CONSTRAINT intercom_drive_gate_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY public.intercom_drive_permission
    ADD CONSTRAINT intercom_drive_permission_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.intercom_drive_permission
    ADD CONSTRAINT intercom_drive_permission_project_id_purpose_file_id_key UNIQUE (project_id, purpose, file_id);

ALTER TABLE ONLY public.intercom_drive_pilot
    ADD CONSTRAINT intercom_drive_pilot_pkey PRIMARY KEY (project_id);

ALTER TABLE ONLY public.intercom_handover
    ADD CONSTRAINT intercom_handover_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.intercom_issue
    ADD CONSTRAINT intercom_issue_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.intercom_manager
    ADD CONSTRAINT intercom_manager_pkey PRIMARY KEY (profile_id);

ALTER TABLE ONLY public.intercom_member
    ADD CONSTRAINT intercom_member_pkey PRIMARY KEY (project_id, profile_id);

ALTER TABLE ONLY public.intercom_people_sheet
    ADD CONSTRAINT intercom_people_sheet_pkey PRIMARY KEY (project_id);

ALTER TABLE ONLY public.intercom_person
    ADD CONSTRAINT intercom_person_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.intercom_project
    ADD CONSTRAINT intercom_project_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.intercom_project
    ADD CONSTRAINT intercom_project_order_id_key UNIQUE (order_id);

ALTER TABLE ONLY public.intercom_project
    ADD CONSTRAINT intercom_project_share_token_key UNIQUE (share_token);

ALTER TABLE ONLY public.intercom_unit_model
    ADD CONSTRAINT intercom_unit_model_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.intercom_unit
    ADD CONSTRAINT intercom_unit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.intercom_unit
    ADD CONSTRAINT intercom_unit_project_id_code_key UNIQUE (project_id, code);

ALTER TABLE ONLY public.intercom_unit
    ADD CONSTRAINT intercom_unit_project_id_prefix_seq_key UNIQUE (project_id, prefix, seq);

ALTER TABLE ONLY public.intercom_unit_set
    ADD CONSTRAINT intercom_unit_set_pkey PRIMARY KEY (project_id, prefix);

ALTER TABLE ONLY public.intercom_upload_log
    ADD CONSTRAINT intercom_upload_log_pkey PRIMARY KEY (id);

CREATE INDEX intercom_drive_bench_run_idx ON public.intercom_drive_bench USING btree (run_id);

CREATE INDEX intercom_drive_delete_queue_account_idx ON public.intercom_drive_delete_queue USING btree (account_id) WHERE (done_at IS NULL);

CREATE INDEX intercom_drive_delete_queue_open_idx ON public.intercom_drive_delete_queue USING btree (created_at) WHERE (done_at IS NULL);

CREATE INDEX intercom_drive_permission_pending_idx ON public.intercom_drive_permission USING btree (updated_at) WHERE (applied_at IS NULL);

CREATE INDEX intercom_handover_project_idx ON public.intercom_handover USING btree (project_id, status);

CREATE INDEX intercom_issue_collect_idx ON public.intercom_issue USING btree (collect_handover_id);

CREATE INDEX intercom_issue_deliver_idx ON public.intercom_issue USING btree (deliver_handover_id);

CREATE INDEX intercom_issue_project_idx ON public.intercom_issue USING btree (project_id, work_date);

CREATE UNIQUE INDEX intercom_issue_unit_out_uq ON public.intercom_issue USING btree (unit_id) WHERE (collect_handover_id IS NULL);

CREATE INDEX intercom_member_profile_id_idx ON public.intercom_member USING btree (profile_id);

CREATE INDEX intercom_person_project_idx ON public.intercom_person USING btree (project_id);

CREATE INDEX intercom_project_customer_id_idx ON public.intercom_project USING btree (customer_id);

CREATE UNIQUE INDEX intercom_unit_model_name_key ON public.intercom_unit_model USING btree (lower(name));

CREATE INDEX intercom_upload_log_created_at_idx ON public.intercom_upload_log USING btree (created_at);

CREATE INDEX intercom_upload_log_project_created_idx ON public.intercom_upload_log USING btree (project_id, created_at);

ALTER TABLE ONLY public.intercom_deleter
    ADD CONSTRAINT intercom_deleter_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id);

ALTER TABLE ONLY public.intercom_drive_permission
    ADD CONSTRAINT intercom_drive_permission_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.intercom_project(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.intercom_drive_pilot
    ADD CONSTRAINT intercom_drive_pilot_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.intercom_project(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.intercom_handover
    ADD CONSTRAINT intercom_handover_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.intercom_handover
    ADD CONSTRAINT intercom_handover_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.intercom_person(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.intercom_handover
    ADD CONSTRAINT intercom_handover_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.intercom_project(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.intercom_issue
    ADD CONSTRAINT intercom_issue_collect_handover_id_fkey FOREIGN KEY (collect_handover_id) REFERENCES public.intercom_handover(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.intercom_issue
    ADD CONSTRAINT intercom_issue_deliver_handover_id_fkey FOREIGN KEY (deliver_handover_id) REFERENCES public.intercom_handover(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.intercom_issue
    ADD CONSTRAINT intercom_issue_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.intercom_person(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.intercom_issue
    ADD CONSTRAINT intercom_issue_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.intercom_project(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.intercom_issue
    ADD CONSTRAINT intercom_issue_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.intercom_unit(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.intercom_manager
    ADD CONSTRAINT intercom_manager_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.intercom_member
    ADD CONSTRAINT intercom_member_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.intercom_member
    ADD CONSTRAINT intercom_member_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.intercom_member
    ADD CONSTRAINT intercom_member_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.intercom_project(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.intercom_people_sheet
    ADD CONSTRAINT intercom_people_sheet_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.intercom_project(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.intercom_person
    ADD CONSTRAINT intercom_person_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.intercom_project(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.intercom_project
    ADD CONSTRAINT intercom_project_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.intercom_unit_model
    ADD CONSTRAINT intercom_unit_model_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.intercom_unit_model(id);

ALTER TABLE ONLY public.intercom_unit
    ADD CONSTRAINT intercom_unit_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.intercom_project(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.intercom_unit_set
    ADD CONSTRAINT intercom_unit_set_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.intercom_unit_model(id);

ALTER TABLE ONLY public.intercom_unit_set
    ADD CONSTRAINT intercom_unit_set_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.intercom_project(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.intercom_upload_log
    ADD CONSTRAINT intercom_upload_log_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.intercom_deleter ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_drive_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_drive_bench ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_drive_delete_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_drive_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_drive_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_drive_pilot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_handover ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_manager ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_people_sheet ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_person ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_project ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_unit_model ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_unit_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercom_upload_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON
  public.intercom_deleter,
  public.intercom_drive_account,
  public.intercom_drive_bench,
  public.intercom_drive_delete_queue,
  public.intercom_drive_gate,
  public.intercom_drive_permission,
  public.intercom_drive_pilot,
  public.intercom_handover,
  public.intercom_issue,
  public.intercom_manager,
  public.intercom_member,
  public.intercom_people_sheet,
  public.intercom_person,
  public.intercom_project,
  public.intercom_unit,
  public.intercom_unit_model,
  public.intercom_unit_set,
  public.intercom_upload_log
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON
  public.intercom_person,
  public.intercom_unit,
  public.intercom_handover,
  public.intercom_issue,
  public.intercom_upload_log,
  public.intercom_project,
  public.intercom_unit_model,
  public.intercom_unit_set,
  public.intercom_people_sheet
  TO authenticated;
