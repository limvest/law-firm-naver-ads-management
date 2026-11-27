CREATE TABLE "firm_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"login_id" text NOT NULL,
	"password_hash" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_accounts_login_id" UNIQUE("login_id")
);
--> statement-breakpoint
ALTER TABLE "firm_collection_runs" DROP CONSTRAINT "firm_collection_runs_operation_job";--> statement-breakpoint
ALTER TABLE "firm_collection_runs" DROP CONSTRAINT "firm_collection_runs_operation_job_id_operation_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "firm_collection_runs" ALTER COLUMN "status" SET DEFAULT 'running';--> statement-breakpoint
ALTER TABLE "firm_accounts" ADD CONSTRAINT "firm_accounts_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "firm_accounts_firm_enabled_idx" ON "firm_accounts" USING btree ("firm_id","enabled");--> statement-breakpoint
INSERT INTO "firm_accounts" ("firm_id", "login_id", "password_hash")
SELECT 2, 'test', 'scrypt-v1$demo-lawfirm-v1$i7W-oaP4aqCsrZRtuY6vPP5dD9xjjwqyLDRLhTrF9w4'
WHERE EXISTS (SELECT 1 FROM "firms" WHERE "id" = 2)
ON CONFLICT ("login_id") DO NOTHING;--> statement-breakpoint
UPDATE "firm_collection_runs" SET "status" = CASE
  WHEN "status" IN ('succeeded', 'completed') THEN 'completed'
  WHEN "status" IN ('failed', 'error') THEN 'error'
  ELSE 'running'
END;--> statement-breakpoint
ALTER TABLE "firm_collection_runs" DROP COLUMN "operation_job_id";--> statement-breakpoint
ALTER TABLE "firm_collection_runs" DROP COLUMN "items_seen";--> statement-breakpoint
ALTER TABLE "firm_collection_runs" DROP COLUMN "items_accepted";--> statement-breakpoint
ALTER TABLE "firm_collection_runs" DROP COLUMN "billable_units";
