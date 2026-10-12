ALTER TABLE "orders" ADD COLUMN "shopify_stock_adjusted" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_tasks" ADD COLUMN "rerun" boolean DEFAULT false NOT NULL;