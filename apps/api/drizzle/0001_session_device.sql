-- Sessions issued before device tracking have nothing to show in the device list; sign them out so the column can be NOT NULL.
DELETE FROM "sessions";
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device" jsonb NOT NULL;
