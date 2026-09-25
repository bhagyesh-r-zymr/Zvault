CREATE TABLE "secret_versions" (
	"project_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"encrypted_meta" jsonb NOT NULL,
	"values" jsonb NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "secret_versions_project_id_secret_id_revision_pk" PRIMARY KEY("project_id","secret_id","revision")
);
--> statement-breakpoint
CREATE TABLE "vault_item_versions" (
	"vault_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"encrypted_key" jsonb NOT NULL,
	"encrypted_data" jsonb NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vault_item_versions_vault_id_item_id_revision_pk" PRIMARY KEY("vault_id","item_id","revision")
);
--> statement-breakpoint
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_item_versions" ADD CONSTRAINT "vault_item_versions_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;