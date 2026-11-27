CREATE TABLE "firm_case_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"outcome" text NOT NULL,
	"handled_at" text,
	"published" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "profile_intro" text;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "office_history" jsonb;--> statement-breakpoint
ALTER TABLE "firm_case_results" ADD CONSTRAINT "firm_case_results_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;