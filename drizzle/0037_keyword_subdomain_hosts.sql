ALTER TABLE "firm_keywords" ADD COLUMN "public_host_label" text;
--> statement-breakpoint
ALTER TABLE "firm_keywords" ADD COLUMN "host_status" text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "firm_keywords" ADD COLUMN "host_key_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "firm_keywords" ADD COLUMN "host_published_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "firm_keywords" ADD COLUMN "host_redirected_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "firm_keywords" ADD CONSTRAINT "firm_keywords_firm_public_host" UNIQUE("firm_id","public_host_label");
--> statement-breakpoint
CREATE TABLE "keyword_host_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "firm_id" integer NOT NULL,
  "keyword_id" uuid NOT NULL,
  "host_label" text NOT NULL,
  "key_version" integer DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "retired_at" timestamp with time zone,
  CONSTRAINT "keyword_host_aliases_firm_label" UNIQUE("firm_id","host_label")
);
--> statement-breakpoint
ALTER TABLE "keyword_host_aliases" ADD CONSTRAINT "keyword_host_aliases_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "keyword_host_aliases" ADD CONSTRAINT "keyword_host_aliases_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "keyword_host_aliases_keyword_idx" ON "keyword_host_aliases" USING btree ("keyword_id");
