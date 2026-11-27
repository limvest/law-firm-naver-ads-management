-- A source run is an exclusive writer for its source cursor.  The discovery
-- worker also checks this in application code for a fast skip, but this index
-- closes the check/insert race across independent worker processes.
-- Keep the newest row if an older deployment already left duplicate running
-- rows behind; otherwise creating the unique index would make the migration
-- fail and leave every later discovery run blocked.
WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY source_id
      ORDER BY started_at DESC, id DESC
    ) AS rn
  FROM source_runs
  WHERE status = 'running'
)
UPDATE source_runs AS runs
SET status = 'failed',
    error = COALESCE(NULLIF(runs.error, ''), 'superseded duplicate running source run'),
    finished_at = COALESCE(runs.finished_at, now())
FROM ranked
WHERE runs.id = ranked.id AND ranked.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "source_runs_source_running_unique"
ON "source_runs" USING btree ("source_id")
WHERE "status" = 'running';
