CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer DEFAULT 1 NOT NULL,
	"type" text NOT NULL,
	"slug" text,
	"session_id" text,
	"variant" text,
	"utm" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" integer DEFAULT 1 NOT NULL,
	"vertical" text NOT NULL,
	"slug" text,
	"name_enc" text NOT NULL,
	"phone_enc" text NOT NULL,
	"detail_enc" text,
	"damage_type" text,
	"amount_band" text,
	"utm" jsonb,
	"first_touch" jsonb,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
