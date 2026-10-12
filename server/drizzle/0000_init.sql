CREATE TABLE "api_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"service" text NOT NULL,
	"env" text,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"status" integer,
	"duration_ms" integer,
	"request_body" text,
	"response_body" text,
	"error" text,
	"source" text
);
--> statement-breakpoint
CREATE TABLE "attribute_values" (
	"id" text PRIMARY KEY NOT NULL,
	"attr_id" text NOT NULL,
	"value_id" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attributes" (
	"id" text PRIMARY KEY NOT NULL,
	"item_type_id" text NOT NULL,
	"attribute_id" text NOT NULL,
	"taxonomy_id" text NOT NULL,
	"name" text NOT NULL,
	"mapped_property" text,
	"type" text NOT NULL,
	"attr_group" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"max_selections" integer DEFAULT 1 NOT NULL,
	"description" text,
	"raw" jsonb,
	"values_fetched" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distribution_centers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"raw" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_types" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"raw" jsonb,
	"attributes_fetched_at" timestamp with time zone,
	"values_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"status" text NOT NULL,
	"message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mapping_profiles" (
	"item_type_id" text PRIMARY KEY NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"order_number" text,
	"status" text NOT NULL,
	"order_date" timestamp with time zone,
	"requested_shipment_date" timestamp with time zone,
	"requested_delivery_date" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"address" jsonb,
	"fulfillments" jsonb,
	"acknowledged_at" timestamp with time zone,
	"shopify_order_id" text,
	"shopify_order_name" text,
	"shopify_push_error" text,
	"shopify_tracking_synced" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text DEFAULT 'shopify' NOT NULL,
	"source_id" text NOT NULL,
	"handle" text,
	"title" text NOT NULL,
	"description_html" text,
	"vendor" text,
	"product_type" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"option_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shopify_status" text,
	"item_type_id" text,
	"theme" text,
	"size_option" text,
	"color_option" text,
	"bullets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parent_external_id" text,
	"target_parent_id" text,
	"target_parent_tcin" text,
	"parent_status" text,
	"parent_validation" text,
	"parent_errors" jsonb,
	"logistics" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_pushed_at" timestamp with time zone,
	"last_push_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_source_id_unique" UNIQUE("source_id")
);
--> statement-breakpoint
CREATE TABLE "report_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"format" text,
	"status" text NOT NULL,
	"download_url" text,
	"params" jsonb,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"shipping_method" text NOT NULL,
	"carrier" text NOT NULL,
	"scac" text NOT NULL,
	"service_code" text NOT NULL,
	"raw" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"variant_id" text,
	"product_id" text,
	"dedup_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"result" jsonb,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_tasks_dedup_key_unique" UNIQUE("dedup_key")
);
--> statement-breakpoint
CREATE TABLE "test_scenarios" (
	"id" text PRIMARY KEY NOT NULL,
	"sheet" text NOT NULL,
	"scenario" text NOT NULL,
	"section" text NOT NULL,
	"owner" text NOT NULL,
	"description" text NOT NULL,
	"identifiers" text DEFAULT '' NOT NULL,
	"hint" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"date" timestamp with time zone,
	"sort" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"source_id" text NOT NULL,
	"inventory_item_id" text,
	"sku" text,
	"barcode" text,
	"mock_barcode" text,
	"title" text,
	"price" numeric(10, 2),
	"compare_at_price" numeric(10, 2),
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"weight_lb" double precision,
	"image_url" text,
	"inventory" integer DEFAULT 0 NOT NULL,
	"inventory_by_loc" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sync_enabled" boolean DEFAULT true NOT NULL,
	"target_product_id" text,
	"tcin" text,
	"listing_status" text,
	"validation_status" text,
	"errors" jsonb,
	"last_price_sent" jsonb,
	"last_qty_sent" jsonb,
	"last_price_sent_at" timestamp with time zone,
	"last_qty_sent_at" timestamp with time zone,
	"status_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variants_source_id_unique" UNIQUE("source_id")
);
--> statement-breakpoint
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_attr_id_attributes_id_fk" FOREIGN KEY ("attr_id") REFERENCES "public"."attributes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributes" ADD CONSTRAINT "attributes_item_type_id_item_types_id_fk" FOREIGN KEY ("item_type_id") REFERENCES "public"."item_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_logs_created_idx" ON "api_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_logs_status_idx" ON "api_logs" USING btree ("service","status");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_uq" ON "attribute_values" USING btree ("attr_id","value_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attributes_type_attr_uq" ON "attributes" USING btree ("item_type_id","attribute_id");--> statement-breakpoint
CREATE INDEX "job_runs_idx" ON "job_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "products_item_type_idx" ON "products" USING btree ("item_type_id");--> statement-breakpoint
CREATE INDEX "sync_tasks_status_idx" ON "sync_tasks" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "variants_sku_idx" ON "variants" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "variants_target_idx" ON "variants" USING btree ("target_product_id");