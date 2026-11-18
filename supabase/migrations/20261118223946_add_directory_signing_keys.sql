-- Add an independent P-256 ECDSA identity key for offline sender authentication.
-- Nullable during rollout so existing clients and profiles continue to work.
ALTER TABLE public.proxitalk_directory
  ADD COLUMN IF NOT EXISTS signing_public_key jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'proxitalk_directory_signing_public_key_shape'
      AND conrelid = 'public.proxitalk_directory'::regclass
  ) THEN
    ALTER TABLE public.proxitalk_directory
      ADD CONSTRAINT proxitalk_directory_signing_public_key_shape
      CHECK (
        signing_public_key IS NULL OR (
          jsonb_typeof(signing_public_key) = 'object'
          AND signing_public_key->>'kty' = 'EC'
          AND signing_public_key->>'crv' = 'P-256'
          AND signing_public_key ? 'x'
          AND signing_public_key ? 'y'
          AND NOT (signing_public_key ? 'd')
        )
      );
  END IF;
END $$;

-- Existing participant-scoped directory RLS policies still restrict these writes to the owner.
GRANT INSERT (signing_public_key) ON public.proxitalk_directory TO authenticated;
GRANT UPDATE (signing_public_key) ON public.proxitalk_directory TO authenticated;
