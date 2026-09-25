CREATE TABLE "share_link_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" text NOT NULL,
	"email_hash" "bytea" NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"blob" jsonb,
	"verifier" "bytea" NOT NULL,
	"allowed_emails" jsonb,
	"max_views" integer NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sharing_keys" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"public_key" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"sender_id" uuid NOT NULL,
	"sender_email" text NOT NULL,
	"sender_public_key" text NOT NULL,
	"recipient_id" uuid NOT NULL,
	"recipient_email" text NOT NULL,
	"ephemeral_public_key" text NOT NULL,
	"blob" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "share_link_codes" ADD CONSTRAINT "share_link_codes_link_id_share_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."share_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_owner_id_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharing_keys" ADD CONSTRAINT "sharing_keys_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_shares" ADD CONSTRAINT "user_shares_sender_id_accounts_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_shares" ADD CONSTRAINT "user_shares_recipient_id_accounts_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_link_codes_link_idx" ON "share_link_codes" USING btree ("link_id","email_hash","created_at");--> statement-breakpoint
CREATE INDEX "share_links_owner_idx" ON "share_links" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "sharing_keys_email_idx" ON "sharing_keys" USING btree ("email");--> statement-breakpoint
CREATE INDEX "user_shares_recipient_idx" ON "user_shares" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "user_shares_sender_idx" ON "user_shares" USING btree ("sender_id","created_at");