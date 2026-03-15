ALTER TABLE public.device_sensors
DROP CONSTRAINT IF EXISTS chk_deployment_status;

ALTER TABLE public.device_sensors
ADD CONSTRAINT chk_deployment_status
CHECK (
  (deployment_status)::text = ANY (
    (
      ARRAY[
        'pending'::character varying,
        'deployed'::character varying,
        'failed'::character varying,
        'pending_deletion'::character varying,
        'virtual'::character varying,
        'draft'::character varying,
        'deleted'::character varying
      ]
    )::text[]
  )
);
