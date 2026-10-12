CREATE TABLE "target_items" (
	"id" text PRIMARY KEY NOT NULL,
	"env" text NOT NULL,
	"tcin" text,
	"external_id" text,
	"relationship_type" text,
	"parent_id" text,
	"barcode" text,
	"title" text,
	"item_type_name" text,
	"listing_status" text,
	"validation_status" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"matched_variant_id" text,
	"matched_product_id" text,
	"match_by" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "target_items_barcode_idx" ON "target_items" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "target_items_ext_idx" ON "target_items" USING btree ("external_id");
