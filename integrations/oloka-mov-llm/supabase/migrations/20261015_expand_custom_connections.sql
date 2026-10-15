-- Applied to Supabase project oloka-mov on 2026-10-15.
-- Apply once to the current schema; existing custom connections were empty.
ALTER TABLE public.mov_llm_connections DROP CONSTRAINT IF EXISTS mov_llm_connections_provider_slug_check;
ALTER TABLE public.mov_llm_connections ADD CONSTRAINT mov_llm_connections_provider_slug_check
 CHECK (provider_slug ~ '^[a-z][a-z0-9_-]{1,63}$');
ALTER TABLE public.mov_llm_connections DROP CONSTRAINT IF EXISTS mov_llm_connections_protocol_check;
ALTER TABLE public.mov_llm_connections ADD CONSTRAINT mov_llm_connections_protocol_check
 CHECK (protocol IN ('openai_compatible','anthropic_messages','gemini_generate'));
ALTER TABLE public.mov_llm_connections
 ADD COLUMN IF NOT EXISTS models_path text NOT NULL DEFAULT '/models',
 ADD COLUMN IF NOT EXISTS chat_path text NOT NULL DEFAULT '/chat/completions',
 ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
 ADD COLUMN IF NOT EXISTS last_test_status text,
 ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE public.mov_llm_connections ADD CONSTRAINT mov_llm_connections_models_path_check
 CHECK (length(models_path) BETWEEN 1 AND 200 AND left(models_path,1)='/');
ALTER TABLE public.mov_llm_connections ADD CONSTRAINT mov_llm_connections_chat_path_check
 CHECK (length(chat_path) BETWEEN 1 AND 200 AND left(chat_path,1)='/');
CREATE UNIQUE INDEX IF NOT EXISTS mov_connection_models_unique_model
 ON public.mov_llm_connection_models(connection_id,api_model);
ALTER TABLE public.mov_llm_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mov_llm_connection_models ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mov_llm_connections FROM anon, authenticated;
REVOKE ALL ON public.mov_llm_connection_models FROM anon, authenticated;
