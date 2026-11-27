CREATE TABLE "lead_conflict_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"lead_id" uuid NOT NULL,
	"terms_enc" text NOT NULL,
	"result" text NOT NULL,
	"match_count" integer DEFAULT 0 NOT NULL,
	"matched_lead_ids" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"lead_id" uuid NOT NULL,
	"role" text NOT NULL,
	"name_enc" text NOT NULL,
	"name_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_parties_lead_role_hash" UNIQUE("lead_id","role","name_hash")
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "assigned_lawyer" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "follow_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "last_contact_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "intake_note_enc" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "conflict_status" text DEFAULT 'unchecked' NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "conflict_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "evidence_checklist" jsonb;--> statement-breakpoint
ALTER TABLE "lead_conflict_checks" ADD CONSTRAINT "lead_conflict_checks_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_conflict_checks" ADD CONSTRAINT "lead_conflict_checks_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_parties" ADD CONSTRAINT "lead_parties_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_parties" ADD CONSTRAINT "lead_parties_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;