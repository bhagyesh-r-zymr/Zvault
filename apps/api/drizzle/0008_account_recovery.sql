CREATE TABLE "account_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"email" text NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"token_hash" "bytea",
	"token_expires_at" timestamp with time zone,
	"token_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_recoveries_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "recovery_keyset" jsonb;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "recovery_verifier" "bytea";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "recovery_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_recoveries" ADD CONSTRAINT "account_recoveries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_recoveries_email_idx" ON "account_recoveries" USING btree ("email","created_at");