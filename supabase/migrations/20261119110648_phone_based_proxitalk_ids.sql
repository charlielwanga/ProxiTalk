-- New ProxiTalk IDs are Uganda mobile numbers in canonical format 2567xxxxxxxx.
-- Legacy PT-XXXXXXXX IDs remain valid only for accounts that have not migrated yet.
ALTER TABLE public.proxitalk_directory
  DROP CONSTRAINT IF EXISTS proxitalk_directory_proxitalk_id_check;

ALTER TABLE public.proxitalk_directory
  ADD CONSTRAINT proxitalk_directory_proxitalk_id_check
  CHECK (proxitalk_id ~ '^(PT-[0-9A-F]{8}|2567[0-9]{8})$');

CREATE OR REPLACE FUNCTION public.proxitalk_require_phone_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.proxitalk_id !~ '^2567[0-9]{8}$' THEN
    IF TG_OP = 'INSERT' OR NEW.proxitalk_id IS DISTINCT FROM OLD.proxitalk_id THEN
      RAISE EXCEPTION 'ProxiTalk IDs must be Uganda mobile numbers in 2567xxxxxxxx format'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS proxitalk_require_phone_id ON public.proxitalk_directory;
CREATE TRIGGER proxitalk_require_phone_id
  BEFORE INSERT OR UPDATE OF proxitalk_id ON public.proxitalk_directory
  FOR EACH ROW EXECUTE FUNCTION public.proxitalk_require_phone_id();

-- Existing participant-scoped RLS continues to restrict ID changes to the row owner.
GRANT UPDATE (proxitalk_id, display_name) ON public.proxitalk_directory TO authenticated;
