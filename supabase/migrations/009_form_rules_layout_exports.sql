-- =============================================================================
-- 009 — Form sections, conditional fields, validation rules; layout & exports
--
-- Form (Admin → Form fields), enforced here as well as on the website:
--   * type "section": a heading that groups request fields (no answer).
--   * showIf: { field, op, value } — the field only appears (and is only
--     required) when another field matches. op: equals | notEquals | isOneOf |
--     isFilled | isEmpty. Answers to hidden fields aren't saved.
--   * min / max (numbers) and maxLength (text).
--   * default: pre-filled on new requests (website only).
-- Settings:
--   * `layout` (request page) and `exports` (Excel templates) documents,
--     edited with "Customize lists & appearance".
--
-- Run once, after 008: Supabase → SQL Editor → New query → paste → Run.
-- =============================================================================


-- A field's answer from a request or item: built-in keys at the top level, custom ones in `data`.
create or replace function public.form_value(p_obj jsonb, p_key text)
returns text
language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(nullif(trim(p_obj ->> p_key), ''), nullif(trim(p_obj -> 'data' ->> p_key), ''), '');
$$;

-- Is a field shown, given its showIf condition? Item fields look at their own
-- item first, then the request.
create or replace function public.field_visible(p_field jsonb, p_request jsonb, p_item jsonb)
returns boolean
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  v_cond jsonb := p_field -> 'showIf';
  v_val  text;
  v_want jsonb;
begin
  if v_cond is null or jsonb_typeof(v_cond) <> 'object' or coalesce(v_cond ->> 'field', '') = '' then
    return true;
  end if;
  v_val := coalesce(nullif(form_value(p_item, v_cond ->> 'field'), ''), form_value(p_request, v_cond ->> 'field'));
  v_want := v_cond -> 'value';
  return case coalesce(v_cond ->> 'op', 'equals')
    when 'isFilled'  then v_val <> ''
    when 'isEmpty'   then v_val = ''
    when 'notEquals' then lower(v_val) <> lower(coalesce(v_want #>> '{}', ''))
    when 'isOneOf'   then exists (
      select 1 from jsonb_array_elements_text(case when jsonb_typeof(v_want) = 'array' then v_want else jsonb_build_array(v_want) end) x
      where lower(x) = lower(v_val))
    else lower(v_val) = lower(coalesce(v_want #>> '{}', ''))
  end;
end;
$$;


-- ---------------------------------------------------------------------------
-- Field lists: same rules as before, plus sections, conditions and limits.
-- ---------------------------------------------------------------------------
create or replace function public.validate_form_fields(p_fields jsonb, p_kind text)
returns void
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  v_builtin text[] := case p_kind
    when 'request' then array['title', 'requester', 'subsystem', 'priority', 'needed_by', 'justification']
    else array['item_name', 'vendor', 'product_link', 'part_number', 'quantity', 'unit_price', 'shipping_cost', 'notes'] end;
  v_locked text[] := array['title', 'item_name', 'quantity', 'unit_price'];
  v_types  text[] := case p_kind
    when 'request' then array['text', 'textarea', 'number', 'date', 'select', 'yesno', 'url', 'section']
    else array['text', 'textarea', 'number', 'date', 'select', 'yesno', 'url'] end;
  v_what   text := case p_kind when 'request' then 'request' else 'item' end;
  v_field  jsonb;
  v_key    text;
  v_label  text;
  v_keys   text[] := '{}';
  v_b      text;
  v_cond   jsonb;
begin
  if coalesce(jsonb_typeof(p_fields), '') <> 'array' then
    raise exception 'The % field list is missing.', v_what;
  end if;
  if jsonb_array_length(p_fields) > 80 then
    raise exception 'Too many % fields (80 max).', v_what;
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
      if not coalesce(v_field ->> 'type', '') = any(v_types) then
        raise exception 'The field "%" has an unknown type.', v_label;
      end if;
      if v_field ->> 'type' = 'select'
         and (coalesce(jsonb_typeof(v_field -> 'options'), '') <> 'array' or jsonb_array_length(v_field -> 'options') = 0) then
        raise exception 'The dropdown "%" needs at least one option.', v_label;
      end if;
      if v_field ->> 'type' = 'section' and (v_field -> 'required') = 'true'::jsonb then
        raise exception 'The section heading "%" can''t be required.', v_label;
      end if;
    end if;

    if v_key = any(v_locked)
       and ((v_field -> 'required') is distinct from 'true'::jsonb or (v_field -> 'hidden') = 'true'::jsonb or v_field ? 'showIf') then
      raise exception '"%" must stay required and always shown.', v_label;
    end if;

    -- Condition: { field, op, value }
    v_cond := v_field -> 'showIf';
    if v_cond is not null and jsonb_typeof(v_cond) <> 'null' then
      if jsonb_typeof(v_cond) <> 'object' or coalesce(v_cond ->> 'field', '') !~ '^[a-z][a-z0-9_]{0,39}$' then
        raise exception 'The condition on "%" needs a field to check.', v_label;
      end if;
      if v_cond ->> 'field' = v_key then
        raise exception '"%" can''t depend on itself.', v_label;
      end if;
      if coalesce(v_cond ->> 'op', '') not in ('equals', 'notEquals', 'isOneOf', 'isFilled', 'isEmpty') then
        raise exception 'The condition on "%" has an unknown rule.', v_label;
      end if;
      if v_cond ->> 'op' in ('equals', 'notEquals', 'isOneOf') and coalesce(v_cond #>> '{value}', '') in ('', '[]') then
        raise exception 'The condition on "%" needs a value to compare with.', v_label;
      end if;
    end if;

    -- Limits
    if v_field ? 'min' and coalesce(v_field ->> 'min', '') !~ '^-?\d*\.?\d+$' then
      raise exception 'The minimum for "%" must be a number.', v_label;
    end if;
    if v_field ? 'max' and coalesce(v_field ->> 'max', '') !~ '^-?\d*\.?\d+$' then
      raise exception 'The maximum for "%" must be a number.', v_label;
    end if;
    if v_field ? 'min' and v_field ? 'max' and (v_field ->> 'min')::numeric > (v_field ->> 'max')::numeric then
      raise exception 'The minimum for "%" is more than its maximum.', v_label;
    end if;
    if v_field ? 'maxLength'
       and (coalesce(v_field ->> 'maxLength', '') !~ '^\d+$' or (v_field ->> 'maxLength')::int not between 1 and 5000) then
      raise exception 'The maximum length for "%" must be between 1 and 5000.', v_label;
    end if;
  end loop;

  -- Conditions on request fields must point at a request field.
  if p_kind = 'request' then
    for v_field in select * from jsonb_array_elements(p_fields) where value ? 'showIf' and jsonb_typeof(value -> 'showIf') = 'object' loop
      if not (v_field #>> '{showIf,field}') = any(v_keys) then
        raise exception 'The condition on "%" refers to a field that doesn''t exist.', v_field ->> 'label';
      end if;
    end loop;
  end if;

  foreach v_b in array v_builtin loop
    if not v_b = any(v_keys) then
      raise exception 'The built-in field "%" can''t be removed — hide it instead.', v_b;
    end if;
  end loop;
end;
$$;


-- Custom field answers: same as 002, plus conditions (hidden → not required,
-- not saved), sections (skipped), and min / max / maxLength.
create or replace function public.clean_custom_fields(
  p_fields jsonb, p_data jsonb, p_prefix text, p_submit boolean, p_request jsonb, p_item jsonb,
  out o_data jsonb, out o_errors text[])
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  v_field jsonb;
  v_key   text;
  v_label text;
  v_type  text;
  v_value text;
  v_err   text;
begin
  o_data := '{}';
  o_errors := '{}';
  for v_field in select * from jsonb_array_elements(coalesce(p_fields, '[]')) loop
    continue when (v_field -> 'builtin') = 'true'::jsonb or (v_field -> 'hidden') = 'true'::jsonb
               or v_field ->> 'type' = 'section';
    continue when not field_visible(v_field, p_request, p_item);
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

    v_err := null;
    if v_type = 'number' then
      if v_value !~ '^-?\d*\.?\d+$' then
        v_err := ' must be a number.';
      elsif v_field ? 'min' and v_value::numeric < (v_field ->> 'min')::numeric then
        v_err := ' must be at least ' || (v_field ->> 'min') || '.';
      elsif v_field ? 'max' and v_value::numeric > (v_field ->> 'max')::numeric then
        v_err := ' must be at most ' || (v_field ->> 'max') || '.';
      end if;
    elsif v_type = 'date' and not is_valid_date(v_value) then
      v_err := ' must be a valid date.';
    elsif v_type = 'select' and not coalesce(v_field -> 'options', '[]') ? v_value then
      v_err := ' must be one of the listed options.';
    elsif v_type = 'yesno' and v_value not in ('Yes', 'No') then
      v_err := ' must be Yes or No.';
    elsif v_field ? 'maxLength' and length(v_value) > (v_field ->> 'maxLength')::int then
      v_err := ' must be ' || (v_field ->> 'maxLength') || ' characters or fewer.';
    elsif length(v_value) > 5000 then
      v_err := ' is too long.';
    end if;

    if v_err is null then
      o_data := o_data || jsonb_build_object(v_key, v_value);
    else
      o_errors := array_append(o_errors, p_prefix || v_label || v_err);
    end if;
  end loop;
end;
$$;


-- update_settings: same as 008, plus the `layout` and `exports` documents.
create or replace function public.update_settings(p_key text, p_value jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_locked jsonb;
begin
  if p_key in ('general', 'form') then
    perform require_permission('settings.edit');
  elsif p_key in ('lists', 'appearance', 'layout', 'exports') then
    perform require_permission('site.customize');
  else
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

  if p_key = 'appearance' and length(coalesce(p_value ->> 'logo', '')) > 400000 then
    raise exception 'The logo is too large. Use an image under 300 KB.';
  end if;
  if p_key = 'appearance' and coalesce(p_value ->> 'accent', '') !~ '^(#[0-9a-fA-F]{6})?$' then
    raise exception 'The accent color must look like #f26b1d.';
  end if;

  if p_key = 'general' then
    select coalesce(jsonb_object_agg(k, value -> k), '{}') into v_locked
    from app_settings, unnest(array['schemaVersion', 'season', 'seasonPrefix']) k
    where key = 'general' and value ? k;
    p_value := (p_value - 'schemaVersion' - 'season' - 'seasonPrefix') || v_locked;
  end if;

  insert into app_settings (key, value, updated_at, updated_by)
  values (p_key, p_value, now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
end;
$$;

-- The sign-in page shows the logo, accent color and sign-in message, so visitors
-- who aren't signed in can read the appearance settings (labels, colors, text only).
create policy "public appearance" on public.app_settings for select to anon using (key = 'appearance');

-- New documents start empty (= defaults), so their first change can be undone.
insert into public.app_settings (key, value) values ('layout', '{}'), ('exports', '{}')
on conflict (key) do nothing;


-- save_request: same as 007; fields hidden by a condition aren't required,
-- and custom fields get their limits checked.
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
  v_ship_txt  text;
  v_ship_bad  boolean;
  v_vendors   text[];
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
                 or (v_field -> 'hidden') = 'true'::jsonb or (v_field -> 'required') is distinct from 'true'::jsonb
                 or not field_visible(v_field, p_request, null);
      if coalesce(v_values ->> (v_field ->> 'key'), '') = '' then
        v_errors := array_append(v_errors, (v_field ->> 'label') || ' is required.');
      end if;
    end loop;
  end if;

  -- Custom request fields
  select * into v_custom from clean_custom_fields(v_rf, p_request -> 'data', '', v_submit, p_request, null);
  v_rdata := v_custom.o_data;
  v_errors := v_errors || v_custom.o_errors;

  -- Items: drop fully blank rows, validate the rest.
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    v_qty_txt   := regexp_replace(trim(coalesce(v_item ->> 'quantity', '')), '[$,]', '', 'g');
    v_price_txt := regexp_replace(trim(coalesce(v_item ->> 'unit_price', '')), '[$,]', '', 'g');
    v_ship_txt  := regexp_replace(trim(coalesce(v_item ->> 'shipping_cost', '')), '[$,]', '', 'g');
    continue when trim(coalesce(v_item ->> 'item_name', '')) = '' and trim(coalesce(v_item ->> 'vendor', '')) = ''
              and trim(coalesce(v_item ->> 'product_link', '')) = '' and trim(coalesce(v_item ->> 'part_number', '')) = ''
              and trim(coalesce(v_item ->> 'notes', '')) = '' and v_qty_txt = '' and v_price_txt = '' and v_ship_txt = ''
              and not exists (select 1 from jsonb_each_text(case when jsonb_typeof(v_item -> 'data') = 'object'
                                                                 then v_item -> 'data' else '{}' end) d
                              where trim(d.value) <> '');
    v_n := v_n + 1;
    v_label := 'Item ' || v_n || ': ';
    v_qty_bad := false;
    v_price_bad := false;
    v_ship_bad := false;

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
    if v_ship_txt <> '' and v_ship_txt !~ '^\d*\.?\d+$' then
      v_errors := array_append(v_errors, v_label || form_field_label(v_if, 'shipping_cost', 'Shipping') || ' must be a number of 0 or more.');
      v_ship_txt := '';
      v_ship_bad := true;
    end if;

    if v_submit then
      -- Item name, quantity and unit price are always required; others per settings.
      foreach v_key in array array['item_name', 'vendor', 'product_link', 'part_number', 'quantity', 'unit_price', 'shipping_cost', 'notes'] loop
        select f into v_field from jsonb_array_elements(v_if) f where f ->> 'key' = v_key;
        continue when v_key not in ('item_name', 'quantity', 'unit_price')
                   and (v_field is null or (v_field -> 'required') is distinct from 'true'::jsonb or (v_field -> 'hidden') = 'true'::jsonb
                        or not field_visible(v_field, p_request, v_item));
        -- Already reported as invalid; don't also say it's missing.
        continue when (v_key = 'quantity' and v_qty_bad) or (v_key = 'unit_price' and v_price_bad)
                   or (v_key = 'shipping_cost' and v_ship_bad);
        v_val := case v_key when 'quantity' then v_qty_txt when 'unit_price' then v_price_txt
                            when 'shipping_cost' then v_ship_txt
                            else trim(coalesce(v_item ->> v_key, '')) end;
        if v_val = '' then
          v_errors := array_append(v_errors, v_label || form_field_label(v_if, v_key, initcap(replace(v_key, '_', ' '))) || ' is required.');
        end if;
      end loop;
    end if;

    select * into v_custom from clean_custom_fields(v_if, v_item -> 'data', v_label, v_submit, p_request, v_item);
    v_errors := v_errors || v_custom.o_errors;

    v_items := v_items || jsonb_build_object(
      'item_name',    trim(coalesce(v_item ->> 'item_name', '')),
      'vendor',       trim(coalesce(v_item ->> 'vendor', '')),
      'product_link', trim(coalesce(v_item ->> 'product_link', '')),
      'part_number',  trim(coalesce(v_item ->> 'part_number', '')),
      'quantity',     nullif(v_qty_txt, ''),
      'unit_price',   nullif(v_price_txt, ''),
      'shipping_cost', nullif(v_ship_txt, ''),
      'notes',        trim(coalesce(v_item ->> 'notes', '')),
      'data',         v_custom.o_data
    );
  end loop;
  if v_submit and v_n = 0 then v_errors := array_append(v_errors, 'Add at least one item.'); end if;

  -- One vendor per request (setting form.oneVendorPerRequest, on unless set to false;
  -- skipped when the Vendor field is hidden). Compared ignoring case and spacing.
  if (v_form -> 'oneVendorPerRequest') is distinct from 'false'::jsonb
     and not exists (select 1 from jsonb_array_elements(v_if) f where f ->> 'key' = 'vendor' and (f -> 'hidden') = 'true'::jsonb) then
    select array_agg(v order by v) into v_vendors from (
      select min(i ->> 'vendor') as v
      from jsonb_array_elements(v_items) i
      where trim(i ->> 'vendor') <> ''
      group by lower(regexp_replace(trim(i ->> 'vendor'), '\s+', ' ', 'g'))
    ) d;
    if cardinality(v_vendors) > 1 then
      v_errors := array_append(v_errors, format(
        'All items in a request must come from the same %s. This one has: %s. Split them into separate requests.',
        lower(form_field_label(v_if, 'vendor', 'Vendor')), array_to_string(v_vendors, ', ')));
    end if;
  end if;

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

  insert into request_items (request_id, position, item_name, vendor, product_link, part_number, quantity, unit_price, shipping_cost, notes, data)
  select v_id, (e.ord - 1)::int, e.item ->> 'item_name', e.item ->> 'vendor', e.item ->> 'product_link',
         e.item ->> 'part_number', (e.item ->> 'quantity')::numeric, (e.item ->> 'unit_price')::numeric,
         (e.item ->> 'shipping_cost')::numeric, e.item ->> 'notes', e.item -> 'data'
  from jsonb_array_elements(v_items) with ordinality as e(item, ord);

  return v_number;
end;
$$;


revoke execute on function
  public.form_value(jsonb, text),
  public.field_visible(jsonb, jsonb, jsonb),
  public.clean_custom_fields(jsonb, jsonb, text, boolean, jsonb, jsonb)
from public, anon, authenticated;

update public.app_settings set value = value || '{"schemaVersion": 9}' where key = 'general';
