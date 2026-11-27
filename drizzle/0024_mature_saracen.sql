CREATE TABLE "source_collection_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"source_url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"operator_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_collection_requests_firm_url" UNIQUE("firm_id","source_url")
);
--> statement-breakpoint
ALTER TABLE "source_collection_requests" ADD CONSTRAINT "source_collection_requests_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_collection_requests_status_created_idx" ON "source_collection_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "source_collection_requests_firm_created_idx" ON "source_collection_requests" USING btree ("firm_id","created_at");