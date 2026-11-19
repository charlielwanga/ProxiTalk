-- Initial authenticated cloud transport for the fresh ProxiTalk project.
-- Public directory contains only ProxiTalk ID, display name, and an ECDH P-256 public key.
CREATE TABLE public.proxitalk_directory (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  proxitalk_id text NOT NULL UNIQUE CHECK (proxitalk_id ~ '^PT-[0-9A-F]{8}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 48),
  public_key jsonb NOT NULL CHECK (
    jsonb_typeof(public_key) = 'object'
    AND public_key->>'kty' = 'EC'
    AND public_key->>'crv' = 'P-256'
    AND public_key ? 'x'
    AND public_key ? 'y'
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.proxitalk_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proxitalk_directory FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.proxitalk_directory FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.proxitalk_directory TO authenticated;
GRANT INSERT (user_id, proxitalk_id, display_name, public_key) ON public.proxitalk_directory TO authenticated;
GRANT UPDATE (display_name, public_key) ON public.proxitalk_directory TO authenticated;
CREATE POLICY directory_authenticated_read ON public.proxitalk_directory
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
CREATE POLICY directory_user_insert ON public.proxitalk_directory
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY directory_user_update ON public.proxitalk_directory
  FOR UPDATE TO authenticated USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE TABLE public.proxitalk_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES public.proxitalk_directory(user_id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES public.proxitalk_directory(user_id) ON DELETE CASCADE,
  ciphertext jsonb NOT NULL CHECK (
    jsonb_typeof(ciphertext) = 'object' AND pg_column_size(ciphertext) <= 65536
  ),
  packet_type text NOT NULL DEFAULT 'message'
    CHECK (packet_type IN ('message', 'media', 'sos', 'ack')),
  hops smallint NOT NULL DEFAULT 0 CHECK (hops BETWEEN 0 AND 12),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  CONSTRAINT proxitalk_no_self_message CHECK (sender_id <> recipient_id),
  CONSTRAINT proxitalk_expiry_window CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '14 days'
  )
);
CREATE INDEX proxitalk_messages_recipient_pending
  ON public.proxitalk_messages(recipient_id, created_at) WHERE delivered_at IS NULL;
ALTER TABLE public.proxitalk_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proxitalk_messages FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.proxitalk_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.proxitalk_messages TO authenticated;
GRANT INSERT (sender_id, recipient_id, ciphertext, packet_type) ON public.proxitalk_messages TO authenticated;
GRANT UPDATE (delivered_at) ON public.proxitalk_messages TO authenticated;
CREATE POLICY message_participants_read ON public.proxitalk_messages
  FOR SELECT TO authenticated
  USING (sender_id = (SELECT auth.uid()) OR recipient_id = (SELECT auth.uid()));
CREATE POLICY message_sender_insert ON public.proxitalk_messages
  FOR INSERT TO authenticated
  WITH CHECK (sender_id = (SELECT auth.uid()) AND recipient_id <> (SELECT auth.uid()));
CREATE POLICY message_recipient_ack ON public.proxitalk_messages
  FOR UPDATE TO authenticated
  USING (recipient_id = (SELECT auth.uid()))
  WITH CHECK (recipient_id = (SELECT auth.uid()));
CREATE POLICY message_participant_delete ON public.proxitalk_messages
  FOR DELETE TO authenticated
  USING (sender_id = (SELECT auth.uid()) OR recipient_id = (SELECT auth.uid()));
