CREATE TABLE "ad_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"entity_id" uuid NOT NULL,
	"day" text NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"cost" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ad_stats_entity_day" UNIQUE("entity_id","day")
);
--> statement-breakpoint
CREATE TABLE "firm_ad_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"entity_type" text NOT NULL,
	"keyword_id" uuid,
	"variant_id" uuid,
	"naver_id" text NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_ad_entities_firm_type_naver" UNIQUE("firm_id","entity_type","naver_id")
);
--> statement-breakpoint
CREATE TABLE "firm_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"provider" text DEFAULT 'naver_searchad' NOT NULL,
	"customer_id" text NOT NULL,
	"api_key_enc" text NOT NULL,
	"secret_enc" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_credentials_firm_provider" UNIQUE("firm_id","provider")
);
--> statement-breakpoint
CREATE TABLE "firm_keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer NOT NULL,
	"keyword_id" uuid NOT NULL,
	"status" text DEFAULT 'subscribed' NOT NULL,
	"naver_adgroup_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firm_keywords_firm_keyword" UNIQUE("firm_id","keyword_id")
);
--> statement-breakpoint
CREATE TABLE "firms" (
	"id" integer PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"ad_lawyer_name" text NOT NULL,
	"phone" text NOT NULL,
	"phone_intl" text NOT NULL,
	"address" text NOT NULL,
	"address_region" text NOT NULL,
	"address_locality" text NOT NULL,
	"kakao_url" text,
	"domain" text,
	"status" text DEFAULT 'pilot' NOT NULL,
	"plan_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firms_slug_unique" UNIQUE("slug"),
	CONSTRAINT "firms_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "keyword_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keyword_id" uuid NOT NULL,
	"text" text NOT NULL,
	"rule" text NOT NULL,
	"rule_version" text DEFAULT 'v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keyword_variants_keyword_text" UNIQUE("keyword_id","text")
);
--> statement-breakpoint
ALTER TABLE "ad_stats" ADD CONSTRAINT "ad_stats_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_stats" ADD CONSTRAINT "ad_stats_entity_id_firm_ad_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."firm_ad_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_ad_entities" ADD CONSTRAINT "firm_ad_entities_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_ad_entities" ADD CONSTRAINT "firm_ad_entities_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_ad_entities" ADD CONSTRAINT "firm_ad_entities_variant_id_keyword_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."keyword_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_credentials" ADD CONSTRAINT "firm_credentials_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_keywords" ADD CONSTRAINT "firm_keywords_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_keywords" ADD CONSTRAINT "firm_keywords_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_variants" ADD CONSTRAINT "keyword_variants_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE no action ON UPDATE no action;