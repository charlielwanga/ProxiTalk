-- Short-lived authenticated signaling mailbox for one-to-one WebRTC calls.
-- SDP/ICE content is E2E-encrypted and device-signed by the clients; this table
-- intentionally does not carry audio/video media. The service still sees call
-- participants, signal kind, timestamps, and call IDs.
CREATE TABLE public.proxitalk_call_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL,
  sender_id uuid NOT NULL REFERENCES public.proxitalk_directory(user_id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES public.proxitalk_directory(user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('offer', 'answer', 'ice', 'hangup', 'reject')),
  ciphertext jsonb NOT NULL CHECK (
    jsonb_typeof(ciphertext) = 'object' AND pg_column_size(ciphertext) <= 65536
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  CONSTRAINT proxitalk_call_not_self CHECK (sender_id <> recipient_id),
  CONSTRAINT proxitalk_call_signal_expiry CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '10 minutes'
  )
);
CREATE INDEX proxitalk_call_signals_inbox
  ON public.proxitalk_call_signals(recipient_id, created_at);
CREATE INDEX proxitalk_call_signals_expiry
  ON public.proxitalk_call_signals(expires_at);
ALTER TABLE public.proxitalk_call_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proxitalk_call_signals FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.proxitalk_call_signals FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.proxitalk_call_signals TO authenticated;
GRANT INSERT (call_id, sender_id, recipient_id, kind, ciphertext)
  ON public.proxitalk_call_signals TO authenticated;
CREATE POLICY call_signals_participant_read ON public.proxitalk_call_signals
  FOR SELECT TO authenticated USING (
    sender_id = (SELECT auth.uid()) OR recipient_id = (SELECT auth.uid())
  );
CREATE POLICY call_signals_sender_insert ON public.proxitalk_call_signals
  FOR INSERT TO authenticated WITH CHECK (
    sender_id = (SELECT auth.uid()) AND recipient_id <> (SELECT auth.uid())
  );
CREATE POLICY call_signals_participant_delete ON public.proxitalk_call_signals
  FOR DELETE TO authenticated USING (
    sender_id = (SELECT auth.uid()) OR recipient_id = (SELECT auth.uid())
  );
