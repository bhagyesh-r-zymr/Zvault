CREATE TABLE "key_grants" (
	"project_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"wrapped_key" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "key_grants_project_id_resource_id_account_id_pk" PRIMARY KEY("project_id","resource_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "project_entries" (
	"project_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"type" text NOT NULL,
	"revision" integer NOT NULL,
	"seq" integer NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"encrypted_meta" jsonb,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_entries_project_id_id_pk" PRIMARY KEY("project_id","id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"encrypted_meta" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_values" (
	"project_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"encrypted_value" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "secret_values_project_id_secret_id_environment_id_pk" PRIMARY KEY("project_id","secret_id","environment_id")
);
--> statement-breakpoint
CREATE TABLE "vault_items" (
	"vault_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"seq" integer NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"encrypted_key" jsonb,
	"encrypted_data" jsonb,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vault_items_vault_id_id_pk" PRIMARY KEY("vault_id","id")
);
--> statement-breakpoint
CREATE TABLE "vaults" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"encrypted_key" jsonb NOT NULL,
	"encrypted_meta" jsonb NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "key_grants" ADD CONSTRAINT "key_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_grants" ADD CONSTRAINT "key_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_entries" ADD CONSTRAINT "project_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_owner_id_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "key_grants_account_idx" ON "key_grants" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "project_entries_seq_idx" ON "project_entries" USING btree ("project_id","seq");--> statement-breakpoint
CREATE INDEX "projects_owner_idx" ON "projects" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "vault_items_seq_idx" ON "vault_items" USING btree ("vault_id","seq");--> statement-breakpoint
CREATE INDEX "vaults_owner_idx" ON "vaults" USING btree ("owner_id");