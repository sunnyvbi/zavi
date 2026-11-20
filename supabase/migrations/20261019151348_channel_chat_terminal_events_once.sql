CREATE OR REPLACE FUNCTION public.guard_terminal_run_event_once()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.stage = 'persisted'
     OR (NEW.stage = 'completed' AND NEW.meta->>'code' IN ('success', 'parse_failed')) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.agent_run_id::text || ':' || NEW.stage, 0));
    IF EXISTS (
      SELECT 1 FROM public.agent_run_events
      WHERE agent_run_id = NEW.agent_run_id AND stage = NEW.stage
        AND (NEW.stage = 'persisted' OR meta->>'code' IN ('success', 'parse_failed'))
    ) THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS terminal_run_event_once ON public.agent_run_events;
CREATE TRIGGER terminal_run_event_once BEFORE INSERT ON public.agent_run_events
FOR EACH ROW EXECUTE FUNCTION public.guard_terminal_run_event_once();
