-- =============================================================================
-- 002 — Editable form fields
--
-- Lets users with `settings.edit` (Chief Engineer, Treasurer) change the
-- request form from Admin → Form fields: rename, reorder, show/hide, and
-- require fields, and add custom fields. Custom answers are stored in the
-- `data` jsonb columns of requests / request_items.
--
-- Run once, after 001: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- Field definitions live in the `form` settings document:
--   requestFields / itemFields: [{ key, label, type, builtin, required, hidden, help, options }]
-- Built-in fields map to table columns; custom fields go in `data`.
-- ---------------------------------------------------------------------------
update public.app_settings
set value = value || jsonb_build_object(
  'requestFields', coalesce(value -> 'requestFields', '[
    {"key": "title",         "label": "Request title",  "type": "text",     "builtin": true, "required": true},
    {"key": "requester",     "label": "Requester name", "type": "text",     "builtin": true, "required": true},
    {"key": "subsystem",     "label": "Subsystem",      "type": "select",   "builtin": true, "required": true},
    {"key": "priority",      "label": "Priority",       "type": "select",   "builtin": true, "required": false},
    {"key": "needed_by",     "label": "Needed by",      "type": "date",     "builtin": true, "required": true},
    {"key": "justification", "label": "Justification",  "type": "textarea", "builtin": true, "required": true,
     "help": "Why do you need these items? Be as descriptive as possible — it makes approval easier."}
  ]'::jsonb),
  'itemFields', coalesce(value -> 'itemFields', '[
    {"key": "item_name",    "label": "Item name",    "type": "text",   "builtin": true, "required": true},
    {"key": "vendor",       "label": "Vendor",       "type": "text",   "builtin": true, "required": true},
    {"key": "product_link", "label": "Product link", "type": "url",    "builtin": true, "required": false},
    {"key": "part_number",  "label": "Part number",  "type": "text",   "builtin": true, "required": false},
    {"key": "quantity",     "label": "Quantity",     "type": "number", "builtin": true, "required": true},
    {"key": "unit_price",   "label": "Unit price",   "type": "number", "builtin": true, "required": true},
    {"key": "notes",        "label": "Notes",        "type": "text",   "builtin": true, "required": false,
     "help": "Pack size, shipping, special instructions"}
  ]'::jsonb)
)
where key = 'form';

-- Lets the website tell leads when the database needs this update.
update public.app_settings set value = value || '{"schemaVersion": 2}' where key = 'general';


-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_valid_date(p_value text)
returns boolean
language plpgsql immutable set search_path = public, pg_temp
as $$
begin
  if p_value !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
  perform p_value::date;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function public.form_field_label(p_fields jsonb, p_key text, p_default text)
returns text
language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(
    (select f ->> 'label' from jsonb_array_elements(coalesce(p_fields, '[]')) f where f ->> 'key' = p_key limit 1),
    p_default);
$$;

-- Rejects field lists that would break the app (missing built-ins, bad keys, ...).
create or replace function public.validate_form_fields(p_fields jsonb, p_kind text)
returns void
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  v_builtin text[] := case p_kind
    when 'request' then array['title', 'requester', 'subsystem', 'priority', 'needed_by', 'justification']
    else array['item_name', 'vendor', 'product_link', 'part_number', 'quantity', 'unit_price', 'notes'] end;
  v_locked text[] := array['title', 'item_name', 'quantity', 'unit_price'];
  v_what   text := case p_kind when 'request' then 'request' else 'item' end;
  v_field  jsonb;
  v_key    text;
  v_label  text;
  v_keys   text[] := '{}';
  v_b      text;
begin
  if coalesce(jsonb_typeof(p_fields), '') <> 'array' then
    raise exception 'The % field list is missing.', v_what;
  end if;
  if jsonb_array_length(p_fields) > 60 then
    raise exception 'Too many % fields (60 max).', v_what;
  end if;

  for v_field in select * from jsonb_array_elements(p_fields) loop
    v_key := v_field ->> 'key';
    v_label := trim(coalesce(v_field ->> 'label', ''));
    if v_key is null or v_key !~ '^[a-z][a-z0-9_]{0,39}$' then
      raise exception 'Invalid field key "%".', v_key;
    end if;
    if v_key = any(v_keys) then raise exception 'The field "%" appears twice.', v_key; end if;
    v_keys := array_append(v_keys, v_key);
    if v_label = '' then raise exception 'Every field needs a label.'; end if;

    if v_key = any(v_builtin) then
      if (v_field -> 'builtin') is distinct from 'true'::jsonb then
        raise exception '"%" is a built-in field.', v_label;
      end if;
    else
      if (v_field -> 'builtin') = 'true'::jsonb then
        raise exception '"%" is not a built-in field.', v_label;
      end if;
      if coalesce(v_field ->> 'type', '') not in ('text', 'textarea', 'number', 'date', 'select', 'yesno', 'url') then
        raise exception 'The field "%" has an unknown type.', v_label;
      end if;
      if v_field ->> 'type' = 'select'
         and (coalesce(jsonb_typeof(v_field -> 'options'), '') <> 'array' or jsonb_array_length(v_field -> 'options') = 0) then
        raise exception 'The dropdown "%" needs at least one option.', v_label;
      end if;
    end if;

    if v_key = any(v_locked)
       and ((v_field -> 'required') is distinct from 'true'::jsonb or (v_field -> 'hidden') = 'true'::jsonb) then
      raise exception '"%" must stay required and shown.', v_label;
    end if;
  end loop;

  foreach v_b in array v_builtin loop
    if not v_b = any(v_keys) then
      raise exception 'The built-in field "%" can''t be removed — hide it instead.', v_b;
    end if;
  end loop;
end;
$$;

-- Validates and cleans the answers to custom (non built-in) fields.
create or replace function public.clean_custom_fields(
  p_fields jsonb, p_data jsonb, p_prefix text, p_submit boolean,
  out o_data jsonb, out o_errors text[])
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  v_field jsonb;
  v_key   text;
  v_label text;
  v_type  text;
  v_value text;
begin
  o_data := '{}';
  o_errors := '{}';
  for v_field in select * from jsonb_array_elements(coalesce(p_fields, '[]')) loop
    continue when (v_field -> 'builtin') = 'true'::jsonb or (v_field -> 'hidden') = 'true'::jsonb;
    v_key := v_field ->> 'key';
    v_label := v_field ->> 'label';
    v_type := v_field ->> 'type';
    v_value := trim(coalesce(p_data ->> v_key, ''));

    if v_value = '' then
      if p_submit and (v_field -> 'required') = 'true'::jsonb then
        o_errors := array_append(o_errors, p_prefix || v_label || ' is required.');
      end if;
      continue;
    end if;

    if v_type = 'number' and v_value !~ '^-?\d*\.?\d+$' then
      o_errors := array_append(o_errors, p_prefix || v_label || ' must be a number.');
    elsif v_type = 'date' and not is_valid_date(v_value) then
      o_errors := array_append(o_errors, p_prefix || v_label || ' must be a valid date.');
    elsif v_type = 'select' and not coalesce(v_field -> 'options', '[]') ? v_value then
      o_errors := array_append(o_errors, p_prefix || v_label || ' must be one of the listed options.');
    elsif v_type = 'yesno' and v_value not in ('Yes', 'No') then
      o_errors := array_append(o_errors, p_prefix || v_label || ' must be Yes or No.');
    elsif length(v_value) > 5000 then
      o_errors := array_append(o_errors, p_prefix || v_label || ' is too long.');
    else
      o_data := o_data || jsonb_build_object(v_key, v_value);
    end if;
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- save_request: required fields now come from the form settings, and custom
-- field answers are validated and stored in `data`.
-- ---------------------------------------------------------------------------
create or replace function public.save_request(p_id uuid, p_request jsonb, p_items jsonb, p_action text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_submit    boolean := p_action = 'submit';
  v_form      jsonb;
  v_rf        jsonb;
  v_if        jsonb;
  v_errors    text[] := '{}';
  v_existing  requests;
  v_id        uuid;
  v_number    text;
  v_title     text := trim(coalesce(p_request ->> 'title', ''));
  v_requester text := trim(coalesce(p_request ->> 'requester', ''));
  v_subsystem text := trim(coalesce(p_request ->> 'subsystem', ''));
  v_priority  text := trim(coalesce(p_request ->> 'priority', ''));
  v_needed    text := trim(coalesce(p_request ->> 'needed_by', ''));
  v_just      text := trim(coalesce(p_request ->> 'justification', ''));
  v_needed_by date;
  v_values    jsonb;
  v_custom    record;
  v_rdata     jsonb;
  v_field     jsonb;
  v_key       text;
  v_val       text;
  v_items     jsonb := '[]';
  v_item      jsonb;
  v_n         int := 0;
  v_qty_txt   text;
  v_price_txt text;
  v_label     text;
  v_qty_bad   boolean;
  v_price_bad boolean;
begin
  if v_uid is null then raise exception 'You must be signed in.'; end if;
  if p_action not in ('draft', 'submit') then raise exception 'action must be draft or submit'; end if;

  select value into v_form from app_settings where key = 'form';
  v_rf := coalesce(v_form -> 'requestFields', '[]');
  v_if := coalesce(v_form -> 'itemFields', '[]');
  if v_priority = '' then v_priority := coalesce(v_form ->> 'defaultPriority', ''); end if;

  -- Built-in request fields
  if v_title = '' then
    v_errors := array_append(v_errors, form_field_label(v_rf, 'title', 'Request title') || ' is required.');
  end if;
  if v_subsystem <> '' and not (v_form -> 'subsystems') ? v_subsystem then
    v_errors := array_append(v_errors, format('Unknown subsystem "%s".', v_subsystem));
  end if;
  if v_priority <> '' and not (v_form -> 'priorities') ? v_priority then
    v_errors := array_append(v_errors, format('Unknown priority "%s".', v_priority));
  end if;
  if v_needed <> '' then
    if is_valid_date(v_needed) then
      v_needed_by := v_needed::date;
    else
      v_errors := array_append(v_errors, form_field_label(v_rf, 'needed_by', 'Needed-by date') || ' must be a valid date.');
    end if;
  end if;

  if v_submit then
    v_values := jsonb_build_object('requester', v_requester, 'subsystem', v_subsystem, 'priority', v_priority,
                                   'needed_by', v_needed, 'justification', v_just);
    for v_field in select * from jsonb_array_elements(v_rf) loop
      continue when (v_field -> 'builtin') is distinct from 'true'::jsonb or v_field ->> 'key' = 'title'
                 or (v_field -> 'hidden') = 'true'::jsonb or (v_field -> 'required') is distinct from 'true'::jsonb;
      if coalesce(v_values ->> (v_field ->> 'key'), '') = '' then
        v_errors := array_append(v_errors, (v_field ->> 'label') || ' is required.');
      end if;
    end loop;
  end if;

  -- Custom request fields
  select * into v_custom from clean_custom_fields(v_rf, p_request -> 'data', '', v_submit);
  v_rdata := v_custom.o_data;
  v_errors := v_errors || v_custom.o_errors;

  -- Items: drop fully blank rows, validate the rest.
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    v_qty_txt   := regexp_replace(trim(coalesce(v_item ->> 'quantity', '')), '[$,]', '', 'g');
    v_price_txt := regexp_replace(trim(coalesce(v_item ->> 'unit_price', '')), '[$,]', '', 'g');
    continue when trim(coalesce(v_item ->> 'item_name', '')) = '' and trim(coalesce(v_item ->> 'vendor', '')) = ''
              and trim(coalesce(v_item ->> 'product_link', '')) = '' and trim(coalesce(v_item ->> 'part_number', '')) = ''
              and trim(coalesce(v_item ->> 'notes', '')) = '' and v_qty_txt = '' and v_price_txt = ''
              and not exists (select 1 from jsonb_each_text(case when jsonb_typeof(v_item -> 'data') = 'object'
                                                                 then v_item -> 'data' else '{}' end) d
                              where trim(d.value) <> '');
    v_n := v_n + 1;
    v_label := 'Item ' || v_n || ': ';
    v_qty_bad := false;
    v_price_bad := false;

    if v_qty_txt <> '' and (v_qty_txt !~ '^\d*\.?\d+$' or v_qty_txt::numeric <= 0) then
      v_errors := array_append(v_errors, v_label || form_field_label(v_if, 'quantity', 'Quantity') || ' must be a positive number.');
      v_qty_txt := '';
      v_qty_bad := true;
    end if;
    if v_price_txt <> '' and v_price_txt !~ '^\d*\.?\d+$' then
      v_errors := array_append(v_errors, v_label || form_field_label(v_if, 'unit_price', 'Unit price') || ' must be a number of 0 or more.');
      v_price_txt := '';
      v_price_bad := true;
    end if;

    if v_submit then
      -- Item name, quantity and unit price are always required; others per settings.
      foreach v_key in array array['item_name', 'vendor', 'product_link', 'part_number', 'quantity', 'unit_price', 'notes'] loop
        select f into v_field from jsonb_array_elements(v_if) f where f ->> 'key' = v_key;
        continue when v_key not in ('item_name', 'quantity', 'unit_price')
                   and (v_field is null or (v_field -> 'required') is distinct from 'true'::jsonb or (v_field -> 'hidden') = 'true'::jsonb);
        -- Already reported as invalid; don't also say it's missing.
        continue when (v_key = 'quantity' and v_qty_bad) or (v_key = 'unit_price' and v_price_bad);
        v_val := case v_key when 'quantity' then v_qty_txt when 'unit_price' then v_price_txt
                            else trim(coalesce(v_item ->> v_key, '')) end;
        if v_val = '' then
          v_errors := array_append(v_errors, v_label || form_field_label(v_if, v_key, initcap(replace(v_key, '_', ' '))) || ' is required.');
        end if;
      end loop;
    end if;

    select * into v_custom from clean_custom_fields(v_if, v_item -> 'data', v_label, v_submit);
    v_errors := v_errors || v_custom.o_errors;

    v_items := v_items || jsonb_build_object(
      'item_name',    trim(coalesce(v_item ->> 'item_name', '')),
      'vendor',       trim(coalesce(v_item ->> 'vendor', '')),
      'product_link', trim(coalesce(v_item ->> 'product_link', '')),
      'part_number',  trim(coalesce(v_item ->> 'part_number', '')),
      'quantity',     nullif(v_qty_txt, ''),
      'unit_price',   nullif(v_price_txt, ''),
      'notes',        trim(coalesce(v_item ->> 'notes', '')),
      'data',         v_custom.o_data
    );
  end loop;
  if v_submit and v_n = 0 then v_errors := array_append(v_errors, 'Add at least one item.'); end if;

  if cardinality(v_errors) > 0 then
    raise exception using message = 'Please fix the following:', detail = array_to_string(v_errors, E'\n');
  end if;

  if p_id is null then
    insert into requests (created_by, title, requester, subsystem, priority, needed_by, justification, data, status)
    values (v_uid, v_title, v_requester, v_subsystem, v_priority, v_needed_by, v_just, v_rdata,
            case when v_submit then 'Submitted' else 'Draft' end)
    returning id, request_number into v_id, v_number;
  else
    select * into v_existing from requests where id = p_id for update;
    if not found then raise exception 'Request not found.'; end if;
    if v_existing.created_by is distinct from v_uid then
      raise exception 'Only the person who created % can edit it.', v_existing.request_number;
    end if;
    if v_existing.status not in ('Draft', 'Changes Requested') then
      raise exception '% is "%" and can no longer be edited.', v_existing.request_number, v_existing.status;
    end if;
    update requests set
      title = v_title, requester = v_requester, subsystem = v_subsystem, priority = v_priority,
      needed_by = v_needed_by, justification = v_just, data = v_rdata,
      status = case when v_submit then 'Submitted' else 'Draft' end,
      updated_at = now()
    where id = p_id;
    delete from request_items where request_id = p_id;
    v_id := p_id;
    v_number := v_existing.request_number;
  end if;

  insert into request_items (request_id, position, item_name, vendor, product_link, part_number, quantity, unit_price, notes, data)
  select v_id, (e.ord - 1)::int, e.item ->> 'item_name', e.item ->> 'vendor', e.item ->> 'product_link',
         e.item ->> 'part_number', (e.item ->> 'quantity')::numeric, (e.item ->> 'unit_price')::numeric,
         e.item ->> 'notes', e.item -> 'data'
  from jsonb_array_elements(v_items) with ordinality as e(item, ord);

  return v_number;
end;
$$;


-- ---------------------------------------------------------------------------
-- update_settings: also validates the field lists.
-- ---------------------------------------------------------------------------
create or replace function public.update_settings(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform require_permission('settings.edit');
  if p_key not in ('general', 'form') then
    raise exception 'Unknown settings key "%".', p_key;
  end if;
  if jsonb_typeof(p_value) <> 'object' then
    raise exception 'Settings must be a JSON object.';
  end if;

  if p_key = 'form' then
    if coalesce(jsonb_typeof(p_value -> 'subsystems'), '') <> 'array' or jsonb_array_length(p_value -> 'subsystems') = 0 then
      raise exception 'At least one subsystem is required.';
    end if;
    if coalesce(jsonb_typeof(p_value -> 'priorities'), '') <> 'array' or jsonb_array_length(p_value -> 'priorities') = 0 then
      raise exception 'At least one priority is required.';
    end if;
    perform validate_form_fields(p_value -> 'requestFields', 'request');
    perform validate_form_fields(p_value -> 'itemFields', 'item');
  end if;

  if p_key = 'general' then
    -- The schema version is set by migrations, not by the website.
    p_value := p_value - 'schemaVersion'
      || coalesce((select jsonb_build_object('schemaVersion', value -> 'schemaVersion')
                   from app_settings where key = 'general' and value ? 'schemaVersion'), '{}');
  end if;

  insert into app_settings (key, value, updated_at, updated_by)
  values (p_key, p_value, now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
end;
$$;


-- Helpers are internal only.
revoke execute on function
  public.is_valid_date(text),
  public.form_field_label(jsonb, text, text),
  public.validate_form_fields(jsonb, text),
  public.clean_custom_fields(jsonb, jsonb, text, boolean)
from public, anon, authenticated;
