CREATE TABLE "product_lead_stage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"firm_id" integer NOT NULL,
	"from_stage" text,
	"to_stage" text NOT NULL,
	"evidence_note" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_lead_stage_history" ADD CONSTRAINT "product_lead_stage_history_lead_id_product_lead_profiles_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."product_lead_profiles"("lead_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_lead_stage_history" ADD CONSTRAINT "product_lead_stage_history_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_lead_stage_history_firm_created_idx" ON "product_lead_stage_history" USING btree ("firm_id","created_at");--> statement-breakpoint
CREATE INDEX "product_lead_stage_history_lead_created_idx" ON "product_lead_stage_history" USING btree ("lead_id","created_at");