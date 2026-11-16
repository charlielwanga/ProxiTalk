-- Lock down the earlier prototype's anonymous ALL policies.
-- No browser client is enabled until auth-scoped policies are designed.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'devices', 'profiles', 'mesh_packets', 'gateway_sync',
    'sos_alerts', 'groups', 'group_members'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS proxitalk_open_all ON public.%I', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
  END LOOP;
END $$;
