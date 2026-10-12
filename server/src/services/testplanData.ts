// Scenarios from Target's "API Integration Test Plan" workbook (5 sheets).
export interface ScenarioSeed { sheet: string; scenario: string; section: string; owner: string; description: string; hint: string; notes: string; sort: number }
export const SCENARIOS: ScenarioSeed[] = [
 {
  "sheet": "Data Collection",
  "scenario": "1.1",
  "section": "Data Collection - POST Allowed Item Types Report",
  "owner": "Partner",
  "description": "Request the Allowed Item Types Report to retrieve a list of Item types you are allowed to sell",
  "hint": "",
  "notes": "Create the report: \nPOST /sellers/v1/sellers/{seller_id}/report_requests\nGET /sellers/v1/sellers/{seller_id}/report_requests",
  "sort": 1
 },
 {
  "sheet": "Data Collection",
  "scenario": "2.1",
  "section": "Data Collection - GET Allowed Item Types Report",
  "owner": "Partner",
  "description": "Download the report from the download_url contained in the response from scenario 1.1",
  "hint": "List download_url: \nList any 3 approved Item Types :",
  "notes": "Retrieve the report:\nGET -/sellers/v1/sellers/{seller_id}/report_requests/{report_request_id}\n\nNote: You will need the report_id from scenario 1.1",
  "sort": 2
 },
 {
  "sheet": "Data Collection",
  "scenario": "2.2",
  "section": "Data Collection - GET Allowed Item Types Report",
  "owner": "Target Plus",
  "description": "Validate URL provided by Partner",
  "hint": "",
  "notes": "",
  "sort": 3
 },
 {
  "sheet": "Data Collection",
  "scenario": "3.1",
  "section": "Data Collection - Get Item Data Report",
  "owner": "Partner",
  "description": "Request the BULK_PRODUCT_DATA_TEMPLATE Report to get the attributes and attribute values for any one of your item types.",
  "hint": "List download_url:",
  "notes": "Note: In the first tab/first sheet, Columns A-D are not attributes but are some of the required fields within the JSON file. \nConsider Column E onwards as the attributes you can include in the the JSON file to list an item. \nFirst row list the attribute name and Second row lists the mapped_property.\n\nWhen formating your JSON file, use the mapped_property field as the name of the key, and insert the appropriate value for you item type. Eg: {\"name\": \"brands.name\",\"value\": \"Valor Fitness\"}. Consult the SA JSON and VAP JSON Example file for more detail \n\nRED columns are mandatory attributes and GREY columns are generally optional attributes. (Certain attributes in GREY may be required for listing a parent/child item)",
  "sort": 4
 },
 {
  "sheet": "Data Collection",
  "scenario": "3.2",
  "section": "Data Collection - Get Item Data Report",
  "owner": "Target Plus",
  "description": "Validate URL provided by Partner",
  "hint": "",
  "notes": "",
  "sort": 5
 },
 {
  "sheet": "Data Collection",
  "scenario": "4.1",
  "section": "Data Collection - GET Attribute types",
  "owner": "Partner",
  "description": "Get the attributes required by Target Plus for any one of your allowed Item_types",
  "hint": "Item Type :",
  "notes": "",
  "sort": 6
 },
 {
  "sheet": "Data Collection",
  "scenario": "4.2",
  "section": "Data Collection - GET Attribute types",
  "owner": "Partner",
  "description": "Get the Total Attributes Count for the item_type on E15",
  "hint": "Total Attributes :",
  "notes": "Refer FirstTab / First Sheet from the Reference bulk_product_data_template.xlsx from the shared folder\nColumn A to D are not attributes\nConsider Column E onwards as the attributes.",
  "sort": 7
 },
 {
  "sheet": "Data Collection",
  "scenario": "4.3",
  "section": "Data Collection - GET Attribute types",
  "owner": "Partner",
  "description": "Get the Required Attributes Count for the item_type on E15",
  "hint": "Total Required Attributes :",
  "notes": "Refer FirstTab / First Sheet from the Reference bulk_product_data_template.xlsx from the shared folder\nColumn A to D are not attributes\nConsider Column E onwards as the attributes.\n\nRED columns are required attributes",
  "sort": 8
 },
 {
  "sheet": "Data Collection",
  "scenario": "4.4",
  "section": "Data Collection - GET Attribute types",
  "owner": "Partner",
  "description": "Get the Optional Attributes Count for the item_type on E15",
  "hint": "Total Optional Attributes :",
  "notes": "Refer FirstTab / First Sheet from the Reference bulk_product_data_template.xlsx from the shared folder\nColumn A to D are not attributes\nConsider Column E onwards as the attributes.\n\n\nGREY columns are generally optional attributes.",
  "sort": 9
 },
 {
  "sheet": "Data Collection",
  "scenario": "4.5",
  "section": "Data Collection - GET Attribute types",
  "owner": "Partner",
  "description": "Get the Attribute Types for the item_type on E15",
  "hint": "4 Attribute Types:",
  "notes": "The TYPE is used to identify the format type of an attribute\nPlease refere to the second sheet row 19 on the Reference bulk_product_data_template.xlsx from the shared folder",
  "sort": 10
 },
 {
  "sheet": "Data Collection",
  "scenario": "4.6",
  "section": "Data Collection - GET Attribute types",
  "owner": "Target Plus",
  "description": "Validate Partner has provided correct details about the assigned attributes referenced in E12",
  "hint": "",
  "notes": "",
  "sort": 11
 },
 {
  "sheet": "Data Collection",
  "scenario": "5.1",
  "section": "Data Collection - GET Item Type Attributes",
  "owner": "Partner",
  "description": "Request the attributes required by Target Plus for an Item to post to Target.com",
  "hint": "Number of feature bullets Target Plus allows:",
  "notes": "",
  "sort": 12
 },
 {
  "sheet": "Data Collection",
  "scenario": "5.2",
  "section": "Data Collection - GET Item Type Attributes",
  "owner": "Target Plus",
  "description": "Validate Partner has provided correct number of feature bullets they can provide",
  "hint": "",
  "notes": "",
  "sort": 13
 },
 {
  "sheet": "Data Collection",
  "scenario": "6.1",
  "section": "Data Collection - GET Values for Attributes",
  "owner": "Partner",
  "description": "Request the value list tied to the attributes you will be utilizing for your allowed item types.  Value lists may vary by item type.",
  "hint": "List three predefined values tied to an attribute of type VALUE.\nitem_type : \nitem_type_id : \nattribute name :\nmapped_property : \n3 predefined values :",
  "notes": "The TYPE is used to identify the format type of an attribute\nPlease refere to the second sheet row 19 on the Reference bulk_product_data_template.xlsx from the shared folder\n\nFor mapped_property  refere to the first sheet row 7 on the Reference bulk_product_data_template.xlsx from the shared folder",
  "sort": 14
 },
 {
  "sheet": "Data Collection",
  "scenario": "6.2",
  "section": "Data Collection - GET Values for Attributes",
  "owner": "Target Plus",
  "description": "Validate Partner has provided correct value for attribute referenced in E18",
  "hint": "",
  "notes": "",
  "sort": 15
 },
 {
  "sheet": "Data Collection",
  "scenario": "7.1",
  "section": "Data Collection - GET Distribution Center ID",
  "owner": "Partner",
  "description": "Request your assigned distribution (warehouse) ID to be utilized with your inventory allocation.",
  "hint": "List the 2 Distribution Center IDs:",
  "notes": "Note: Target Plus allows the addition of up to 30 Distribution centers to ensure the most accurate delivery promise dates based on DC zipcode to Guest zipcode. More information available in help center, search Dynamic EDD.",
  "sort": 16
 },
 {
  "sheet": "Data Collection",
  "scenario": "7.2",
  "section": "Data Collection - GET Distribution Center ID",
  "owner": "Target Plus",
  "description": "Validate the distribution_center_id provided by the Partner is correct",
  "hint": "",
  "notes": "",
  "sort": 17
 },
 {
  "sheet": "Data Collection",
  "scenario": "8.1",
  "section": "Data Collection - GET Shipping Method",
  "owner": "Partner",
  "description": "Request the allowable shipping methods you will be able to utilize when fulfilling orders",
  "hint": "List 3 SCAC shipping_methods:",
  "notes": "Note: Set pagination to pull this report. This defaults to 10. To increase to 100:  (&page=1&per_page=100)  \n\nWe had a recent update to the Orders Base URL. The new Base URL is as below\nbase_url : https://stage-api.target.com/seller_orders/v1\nMore details on all end points that need the base_url update can be found here https://plus.target.com/docs/spec/orders#servers",
  "sort": 18
 },
 {
  "sheet": "Data Collection",
  "scenario": "8.2",
  "section": "Data Collection - GET Shipping Method",
  "owner": "Target Plus",
  "description": "Validate the shipping_methods provided by the partner are correct",
  "hint": "",
  "notes": "",
  "sort": 19
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "1.1",
  "section": "Create Items - Standalone Item",
  "owner": "Partner",
  "description": "Create standalone (SA) item utilizing valid UPC, item type, and Brand = Valor Fitness",
  "hint": "SKU: \nproduct_id/id:\nTCIN:",
  "notes": "Note: \n1) Brand must be Valor Fitness due to a Stage environment limitation.\n\n2) Barcodes for the Stage environment need not be the same that's tied to the product.\nIt can be some random numbers which meets the barcode checksum.\n\n3) The JSON example files are only for reference as a template for your item data submission . You must update the  attributes and values listed to match you Item Type's assigned attribute list.\n\n4) Do not include Logistics attributes in item content data. Those attributes are updated via the Update Product Logistics endpoint. Refer to the \"Updating Logistics\" section in the Guide.\n\n5) TCIN ( Target.com Identification Number ) is usually a 8 or 10 digit number",
  "sort": 20
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "1.2",
  "section": "Create Items - Standalone Item",
  "owner": "Partner",
  "description": "Check for the item's listing_status and validation_status",
  "hint": "listing_status : \nvalidation_status :",
  "notes": "You can use the products_catalog endpoint with the expand=fields,product_statuses parameter to know all about your item(s)\n\nImportant note\nEvery update to an item will create a new version of the item and you will have to look at the validation_status and  listing_status of the latest version where latest:true\n\nDuring validation (validation_status) the item will under go a series of system checks for some of the basic things like Barcode,  Approved item type check, Mandatory attribute fields, Predefined value checks etc.\n\nThe validation_status will initially be INITIATED and\n> If the item passes all the system checks the validation_status will be updated to VALIDATED ( will usually take 3 to 5 mins ) and listing_status will be updated to PENDING and the item will be available for manual review.\n\n> If the item fails the system checks the validation_status will be updated as ERROR and listing_status will be updated as REJECTED.",
  "sort": 21
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "1.3",
  "section": "Create Items - Standalone Item",
  "owner": "Target Plus",
  "description": "Update item listing status to Approved",
  "hint": "",
  "notes": "",
  "sort": 22
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "1.4",
  "section": "Create Items - Standalone Item",
  "owner": "Partner",
  "description": "Confirm item listing status has been updated to Approved",
  "hint": "listing_status :\nvalidation_status :",
  "notes": "",
  "sort": 23
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "1.5",
  "section": "Create Items - Standalone Item",
  "owner": "Partner",
  "description": "Create price for item",
  "hint": "Price (list/sale/map) :",
  "notes": "Price will always need to be sent after the item has been created. Refer to cell G60\n\nList Price= Regular Price\nOffer Price= Sale or Discounted Price\nMAP= Minimum Advertised Price\n \nList Price should always be the highest.\nOffer (Sale) Price is when you are selling the item at a discount and will show up XX% off List Price\nMAP Price is the minimum price you want the item to sell for.\nIf you send an Offer price lower than List, you will receive an error.                                                                                         \nNote: prices must be greater than 0.00.",
  "sort": 24
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "1.6",
  "section": "Create Items - Standalone Item",
  "owner": "Partner",
  "description": "Create inventory for item",
  "hint": "Inventory:",
  "notes": "Inventory will always need to be sent after the item has been created.",
  "sort": 25
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "1.7",
  "section": "Create Items - Standalone Item",
  "owner": "Target Plus",
  "description": "Validate price and inventory has been created for item",
  "hint": "Price:\nInventory:",
  "notes": "",
  "sort": 26
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "2.1",
  "section": "Create Items - Parent/Child with Size Variation",
  "owner": "Partner",
  "description": "Create parent (VAP) and two child (VC) items which have size variations",
  "hint": "Parent SKU:\nParent TCIN:\nChild SKU1:\nChild TCIN1:\nChild SKU2:\nChild TCIN2:",
  "notes": "Note:\nOnly SKU(external_id) is required for VAPs. A Barcode is not required for VAPs and should not be sent as it will cause issues with the item relationships.\n\nNote:\nSince Item variation.theme is Size, do not include attributes related to size and any other attribute that will vary at VC level in the VAP (Parent). These varying attributes will have be defined only at the VCs\n\nMore details are documented on the Basic Item Requirements pdf from the shared folder",
  "sort": 27
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "2.2",
  "section": "Create Items - Parent/Child with Size Variation",
  "owner": "Target Plus",
  "description": "Update item listing status to Approved",
  "hint": "",
  "notes": "",
  "sort": 28
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "2.3",
  "section": "Create Items - Parent/Child with Size Variation",
  "owner": "Partner",
  "description": "Confirm item listing status has been updated to Approved",
  "hint": "",
  "notes": "",
  "sort": 29
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "2.4",
  "section": "Create Items - Parent/Child with Size Variation",
  "owner": "Partner",
  "description": "Create price for item",
  "hint": "Price1:\nPrice2:",
  "notes": "Price will always need to be sent after the item has been created.\n  \nVAPs (Parent) items are just a shell that hold a set of VCs under them. \nYou should not be updating Price and Inventory for VAP.",
  "sort": 30
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "2.5",
  "section": "Create Items - Parent/Child with Size Variation",
  "owner": "Partner",
  "description": "Create inventory for item",
  "hint": "Inventory1:\nInventory2:",
  "notes": "Inventory will always need to be sent after the item has been created.",
  "sort": 31
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "2.6",
  "section": "Create Items - Parent/Child with Size Variation",
  "owner": "Target Plus",
  "description": "Validate price and inventory has been created for item",
  "hint": "Price1:\nInventory1:\nPrice2:\nInventory2:",
  "notes": "",
  "sort": 32
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "3.1",
  "section": "Create Items - Parent/Child with Color Variation",
  "owner": "Partner",
  "description": "Create parent (VAP) and two child (VC) items which have color variations",
  "hint": "Parent SKU:\nParent TCIN:\nChild SKU1:\nChild TCIN1:\nChild SKU2:\nChild TCIN2:",
  "notes": "Note:\nSince Item variation.theme is Color, do not include attributes related to color and any other attribute that will vary at VC level in the VAP (Parent). These varying attributes will have be defined only at the VCs",
  "sort": 33
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "3.2",
  "section": "Create Items - Parent/Child with Color Variation",
  "owner": "Target Plus",
  "description": "Update item listing status to Approved",
  "hint": "",
  "notes": "",
  "sort": 34
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "3.3",
  "section": "Create Items - Parent/Child with Color Variation",
  "owner": "Partner",
  "description": "Confirm item listing status has been updated to Approved",
  "hint": "",
  "notes": "",
  "sort": 35
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "3.4",
  "section": "Create Items - Parent/Child with Color Variation",
  "owner": "Partner",
  "description": "Create price for item",
  "hint": "Price1:\nPrice2:",
  "notes": "Price will always need to be sent after the item has been created.",
  "sort": 36
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "3.5",
  "section": "Create Items - Parent/Child with Color Variation",
  "owner": "Partner",
  "description": "Create inventory for item",
  "hint": "Inventory1:\nInventory2:",
  "notes": "Inventory will always need to be sent after the item has been created.",
  "sort": 37
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "3.6",
  "section": "Create Items - Parent/Child with Color Variation",
  "owner": "Target Plus",
  "description": "Validate price and inventory has been created for item",
  "hint": "Price1:\nInventory1:\nPrice2:\nInventory2:",
  "notes": "",
  "sort": 38
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "4.1",
  "section": "Create Items - Parent/Child with Size and Color Variation",
  "owner": "Partner",
  "description": "Create parent (VAP) and two child (VC) items which a size and color variation",
  "hint": "Parent SKU:\nParent TCIN:\nChild SKU1:\nChild TCIN1:\nChild SKU2:\nChild TCIN2:",
  "notes": "Note:\nSince Item variation.theme is Size & Color, do not include attributes related to size, color and any other attribute that will vary at VC level in the VAP (Parent). These varying attributes will have be defined only at the VCs",
  "sort": 39
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "4.2",
  "section": "Create Items - Parent/Child with Size and Color Variation",
  "owner": "Target Plus",
  "description": "Update item listing status to Approved",
  "hint": "",
  "notes": "",
  "sort": 40
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "4.3",
  "section": "Create Items - Parent/Child with Size and Color Variation",
  "owner": "Partner",
  "description": "Confirm item listing status has been updated to Approved",
  "hint": "",
  "notes": "",
  "sort": 41
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "4.4",
  "section": "Create Items - Parent/Child with Size and Color Variation",
  "owner": "Partner",
  "description": "Create price for item",
  "hint": "Price1:\nPrice2:",
  "notes": "Price will always need to be sent after the item has been created.",
  "sort": 42
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "4.5",
  "section": "Create Items - Parent/Child with Size and Color Variation",
  "owner": "Partner",
  "description": "Create inventory for item",
  "hint": "Inventory1:\nInventory2:",
  "notes": "Inventory will always need to be sent after the item has been created.",
  "sort": 43
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "4.6",
  "section": "Create Items - Parent/Child with Size and Color Variation",
  "owner": "Target Plus",
  "description": "Validate price and inventory has been created for item",
  "hint": "Price1:\nInventory1:\nPrice2:\nInventory2:",
  "notes": "",
  "sort": 44
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "5.1",
  "section": "Create Items - Rejected Item",
  "owner": "Partner",
  "description": "Create standalone (SA) item utilizing valid UPC, item type, and Brand = Valor Fitness",
  "hint": "SKU:\nTCIN:",
  "notes": "",
  "sort": 45
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "5.2",
  "section": "Create Items - Rejected Item",
  "owner": "Target Plus",
  "description": "Update item listing status to Rejected",
  "hint": "",
  "notes": "",
  "sort": 46
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "5.3",
  "section": "Create Items - Rejected Item",
  "owner": "Partner",
  "description": "Confirm item listing status has been updated to Rejected",
  "hint": "",
  "notes": "",
  "sort": 47
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "5.4",
  "section": "Create Items - Rejected Item",
  "owner": "Partner",
  "description": "Create price for item",
  "hint": "Price:",
  "notes": "",
  "sort": 48
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "5.5",
  "section": "Create Items - Rejected Item",
  "owner": "Partner",
  "description": "Create inventory for item",
  "hint": "Inventory:",
  "notes": "",
  "sort": 49
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "5.6",
  "section": "Create Items - Rejected Item",
  "owner": "Target Plus",
  "description": "Validate price and inventory has been created for item",
  "hint": "Price:\nInventory:",
  "notes": "",
  "sort": 50
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "6.1",
  "section": "Create Items - Suspended Item",
  "owner": "Partner",
  "description": "Create standalone (SA) item utilizing valid UPC, item type, and Brand = Valor Fitness",
  "hint": "SKU:\nTCIN:",
  "notes": "",
  "sort": 51
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "6.2",
  "section": "Create Items - Suspended Item",
  "owner": "Target Plus",
  "description": "Update item listing status to Approved",
  "hint": "",
  "notes": "",
  "sort": 52
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "6.3",
  "section": "Create Items - Suspended Item",
  "owner": "Partner",
  "description": "Confirm item listing status has been updated to Approved",
  "hint": "",
  "notes": "",
  "sort": 53
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "6.4",
  "section": "Create Items - Suspended Item",
  "owner": "Partner",
  "description": "Create price for item",
  "hint": "Price:",
  "notes": "Price will always need to be sent after the item has been created.",
  "sort": 54
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "6.5",
  "section": "Create Items - Suspended Item",
  "owner": "Partner",
  "description": "Create inventory for item",
  "hint": "Inventory:",
  "notes": "Inventory will always need to be sent after the item has been created.",
  "sort": 55
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "6.6",
  "section": "Create Items - Suspended Item",
  "owner": "Target Plus",
  "description": "Validate price and inventory has been created for item",
  "hint": "Price:\nInventory:",
  "notes": "",
  "sort": 56
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "6.7",
  "section": "Create Items - Suspended Item",
  "owner": "Target Plus",
  "description": "Change item listing status to Suspended",
  "hint": "",
  "notes": "",
  "sort": 57
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "6.8",
  "section": "Create Items - Suspended Item",
  "owner": "Partner",
  "description": "Confirm item listing status has been updated to Suspended",
  "hint": "Reason :",
  "notes": "",
  "sort": 58
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "7.1",
  "section": "Create Items - Unlisted Item",
  "owner": "Partner",
  "description": "Create standalone (SA) item utilizing valid UPC, item type, and Brand = Valor Fitness- Include EVERY attribute that is associated to the item type (regardless of required or not)",
  "hint": "SKU:\nTCIN:",
  "notes": "Variation Attributes, Parent title, Parent Image url  should not be used for Stand Alone (SA) items. \n\nDo not include Logistics attributes ( Shipping Exclusion, Fulfillment Two Day Shipping Eligible, Fulfillment Add On and return policy ) while listing the item content. Logistics attribute will have to be sent after the item is created, over the product_logistics endpoint.",
  "sort": 59
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "7.2",
  "section": "Create Items - Unlisted Item",
  "owner": "Target Plus",
  "description": "Update item listing status to Approved",
  "hint": "",
  "notes": "",
  "sort": 60
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "7.3",
  "section": "Create Items - Unlisted Item",
  "owner": "Partner",
  "description": "Confirm item listing status has been updated to Approved",
  "hint": "",
  "notes": "",
  "sort": 61
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "7.4",
  "section": "Create Items - Unlisted Item",
  "owner": "Partner",
  "description": "Create price for item",
  "hint": "Price:",
  "notes": "Price will always need to be sent after the item has been created.",
  "sort": 62
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "7.5",
  "section": "Create Items - Unlisted Item",
  "owner": "Partner",
  "description": "Create inventory for item",
  "hint": "Inventory:",
  "notes": "Inventory will always need to be sent after the item has been created.",
  "sort": 63
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "7.6",
  "section": "Create Items - Unlisted Item",
  "owner": "Partner",
  "description": "Create Logistics data allowing 2-day shipping, shipping exclusions and designate the item is an add-on item- ask Target for Return Policy ID.",
  "hint": "Values sent:",
  "notes": "Use Return Policy ID -  AAB                                            \nNote: Parents are not buyable and shouldn't be updated.",
  "sort": 64
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "7.7",
  "section": "Create Items - Unlisted Item",
  "owner": "Target Plus",
  "description": "Validate price, inventory and logistics data has been created for item",
  "hint": "Price:\nInventory:\nLogistics Data:",
  "notes": "",
  "sort": 65
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "7.8",
  "section": "Create Items - Unlisted Item",
  "owner": "Partner",
  "description": "Change item listing status to Unlisted",
  "hint": "",
  "notes": "",
  "sort": 66
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "7.9",
  "section": "Create Items - Unlisted Item",
  "owner": "Target Plus",
  "description": "Confirm item listing status has been updated to Unlisted",
  "hint": "",
  "notes": "",
  "sort": 67
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "8.1",
  "section": "Update Items - Item Attribute(s)",
  "owner": "Partner",
  "description": "Update two of the following attributes: size, color, dimensions, weight.",
  "hint": "SKU:\nTCIN:\nUpdate1:\nUpdate2:",
  "notes": "",
  "sort": 68
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "8.2",
  "section": "Update Items - Item Attribute(s)",
  "owner": "Target Plus",
  "description": "Validate the outlined updates to the attributes",
  "hint": "Update1:\nUpdate2:",
  "notes": "",
  "sort": 69
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "9.1",
  "section": "Update Items - Price(s)",
  "owner": "Partner",
  "description": "Update the following price fields: MAP, OFFER, and LIST PRICE",
  "hint": "SKU:\nTCIN:\nMAP:\nOFFER:\nLIST PRICE:",
  "notes": "List Price= Regular Price\nOffer Price= Sale or Discounted Price\nMAP= Minimum Advertised Price\n \nList Price should always be the highest.\nOffer (Sale) Price is when you are selling the item at a discount and will show up XX% off List Price\nMAP Price is the minimum price you want the item to sell for.\nIf you send an Offer price lower than List, you will receive an error.                                                                                         \nNote: prices must be greater than 0.00.",
  "sort": 70
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "9.2",
  "section": "Update Items - Price(s)",
  "owner": "Target Plus",
  "description": "Validate the pricing updates",
  "hint": "MAP:\nOFFER:\nLIST PRICE:",
  "notes": "",
  "sort": 71
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "10.1",
  "section": "Update Items - Inventory",
  "owner": "Partner",
  "description": "Update the inventory on hand for the item",
  "hint": "SKU:\nTCIN:\nFirst DC Inventory:\nSecond DC Inventory:",
  "notes": "",
  "sort": 72
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "10.2",
  "section": "Update Items - Inventory",
  "owner": "Target Plus",
  "description": "Validate the inventory has been updated for the item",
  "hint": "First DC Inventory:\nSecond DC Inventory:",
  "notes": "",
  "sort": 73
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "11.1",
  "section": "Update Items - Variation Child (VC) (if applicable)",
  "owner": "Partner",
  "description": "Update two of the following attributes for the VC tied to a Variation Parent (VAP) item: size, color, dimensions, weight",
  "hint": "SKU:\nTCIN:\nUpdate1:\nUpdate2:",
  "notes": "",
  "sort": 74
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "11.2",
  "section": "Update Items - Variation Child (VC) (if applicable)",
  "owner": "Target Plus",
  "description": "Validate the attributes have been updated for the item",
  "hint": "Update1:\nUpdate2:",
  "notes": "",
  "sort": 75
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "12.1",
  "section": "Update Items - Update Logistics Data",
  "owner": "Partner",
  "description": "Update two of the following attributes for a SA item: Item is an add-on,  Eligible for 2-day shipping, Shipping exclusion, Return Policy",
  "hint": "SKU:\nTCIN:\nUpdate1:\nUpdate2:",
  "notes": "Use Return Policy ID -  AAB                                            \nNote: Parents are not buyable and shouldn't be updated.",
  "sort": 76
 },
 {
  "sheet": "Item Create-Update",
  "scenario": "12.2",
  "section": "Update Items - Update Logistics Data",
  "owner": "Target Plus",
  "description": "Validate the attributes have been updated for the item",
  "hint": "Update1:\nUpdate2:",
  "notes": "",
  "sort": 77
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "1.1",
  "section": "Order Fulfillment - Single Item with Multiple Quantities, Partial Quantity Shipment",
  "owner": "Target Plus",
  "description": "Release purchase order containing a single item with a quantity > 1",
  "hint": "Order:",
  "notes": "You will not see billing address in production.  Do not develop using this information.",
  "sort": 78
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "1.2",
  "section": "Order Fulfillment - Single Item with Multiple Quantities, Partial Quantity Shipment",
  "owner": "Partner",
  "description": "Acknowledge the order has been received",
  "hint": "",
  "notes": "Email address will be blank",
  "sort": 79
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "1.3",
  "section": "Order Fulfillment - Single Item with Multiple Quantities, Partial Quantity Shipment",
  "owner": "Target Plus",
  "description": "Validate the order has been flagged as \"Acknowledged\"",
  "hint": "",
  "notes": "",
  "sort": 80
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "1.4",
  "section": "Order Fulfillment - Single Item with Multiple Quantities, Partial Quantity Shipment",
  "owner": "Partner",
  "description": "Create shipment/fulfillment containing a single quantity, including tracking number and shipping method and cancel the unshipped quantity",
  "hint": "Shipment id: \nTracking: \nMethod:",
  "notes": "You must send an inventory update via API to reflect a change in inventory when an order is shipped.                                                                                                                                                                                                                                                                 SCAC code, Level of Service and Shipping Method are all defaults.  \nYou can chose to sending via your prefered carrier that is listed in the Portal.",
  "sort": 81
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "1.5",
  "section": "Order Fulfillment - Single Item with Multiple Quantities, Partial Quantity Shipment",
  "owner": "Target Plus",
  "description": "Validate shipment/fulfillment of quantity = 1",
  "hint": "Shipment id: \nTracking: \nMethod:",
  "notes": "",
  "sort": 82
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "2.1",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Ship One Item Complete",
  "owner": "Target Plus",
  "description": "Release purchase order containing multiple items (lines), each with a quantity > 1",
  "hint": "Order:",
  "notes": "",
  "sort": 83
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "2.2",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Ship One Item Complete",
  "owner": "Partner",
  "description": "Acknowledge the order has been received",
  "hint": "",
  "notes": "",
  "sort": 84
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "2.3",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Ship One Item Complete",
  "owner": "Target Plus",
  "description": "Validate the order has been flagged as \"Acknowledged\"",
  "hint": "",
  "notes": "",
  "sort": 85
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "2.4",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Ship One Item Complete",
  "owner": "Partner",
  "description": "Create complete shipment/fulfillment shipping one item complete and one item with a quantity = 1 (partial)\nand Cancel the unshipped quantity",
  "hint": "Shipment id: \nTracking: \nMethod:",
  "notes": "",
  "sort": 86
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "2.5",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Ship One Item Complete",
  "owner": "Target Plus",
  "description": "Validate shipment/fulfillment",
  "hint": "Shipment id: \nTracking: \nMethod:",
  "notes": "",
  "sort": 87
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "3.1",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Shipment",
  "owner": "Target Plus",
  "description": "Release purchase order containing multiple items (lines), each with a quantity > 1",
  "hint": "Order:",
  "notes": "",
  "sort": 88
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "3.2",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Shipment",
  "owner": "Partner",
  "description": "Acknowledge the order has been received",
  "hint": "",
  "notes": "",
  "sort": 89
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "3.3",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Shipment",
  "owner": "Target Plus",
  "description": "Validate the order has been flagged as \"Acknowledged\"",
  "hint": "",
  "notes": "",
  "sort": 90
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "3.4",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Shipment",
  "owner": "Partner",
  "description": "Create complete shipment/fulfillment shipping a quantity = 1 for each item and\nCancel the unshipped quantity",
  "hint": "Shipment id: \nTracking: \nMethod:",
  "notes": "",
  "sort": 91
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "3.5",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Shipment",
  "owner": "Target Plus",
  "description": "Validate shipment/fulfillment",
  "hint": "Shipment id: \nTracking: \nMethod:",
  "notes": "",
  "sort": 92
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "4.1",
  "section": "Order Fulfillment - Multiple Items with Multiple Quantities, Complete Shipment",
  "owner": "Target Plus",
  "description": "Release purchase order containing multiple items (lines), each with a quantity > 1",
  "hint": "Order:",
  "notes": "",
  "sort": 93
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "4.2",
  "section": "Order Fulfillment - Multiple Items with Multiple Quantities, Complete Shipment",
  "owner": "Partner",
  "description": "Acknowledge the order has been received",
  "hint": "",
  "notes": "",
  "sort": 94
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "4.3",
  "section": "Order Fulfillment - Multiple Items with Multiple Quantities, Complete Shipment",
  "owner": "Target Plus",
  "description": "Validate the order has been flagged as \"Acknowledged\"",
  "hint": "",
  "notes": "",
  "sort": 95
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "4.4",
  "section": "Order Fulfillment - Multiple Items with Multiple Quantities, Complete Shipment",
  "owner": "Partner",
  "description": "Create complete shipment/fulfillment containing all items and quantities included on the order",
  "hint": "Shipment id: \nTracking: \nMethod:",
  "notes": "",
  "sort": 96
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "4.5",
  "section": "Order Fulfillment - Multiple Items with Multiple Quantities, Complete Shipment",
  "owner": "Target Plus",
  "description": "Validate shipment/fulfillment",
  "hint": "Shipment id: \nTracking: \nMethod:",
  "notes": "",
  "sort": 97
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "5.1",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Cancellation",
  "owner": "Target Plus",
  "description": "Release purchase order containing multiple items (lines), each with a quantity > 1",
  "hint": "Order:",
  "notes": "",
  "sort": 98
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "5.2",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Cancellation",
  "owner": "Partner",
  "description": "Acknowledge the order has been received",
  "hint": "",
  "notes": "",
  "sort": 99
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "5.3",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Cancellation",
  "owner": "Target Plus",
  "description": "Validate the order has been flagged as \"Acknowledged\"",
  "hint": "",
  "notes": "",
  "sort": 100
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "5.4",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Cancellation",
  "owner": "Partner",
  "description": "Update one of the items as cancelled",
  "hint": "Cancellation Reason:",
  "notes": "",
  "sort": 101
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "5.5",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Cancellation",
  "owner": "Target Plus",
  "description": "Validate item cancellation",
  "hint": "Cancellation Reason:",
  "notes": "",
  "sort": 102
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "6.1",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Cancellation",
  "owner": "Target Plus",
  "description": "Release purchase order containing multiple items (lines), each with a quantity > 1",
  "hint": "Order:",
  "notes": "",
  "sort": 103
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "6.2",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Cancellation",
  "owner": "Partner",
  "description": "Acknowledge the order has been received",
  "hint": "",
  "notes": "",
  "sort": 104
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "6.3",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Cancellation",
  "owner": "Target Plus",
  "description": "Validate the order has been flagged as \"Acknowledged\"",
  "hint": "",
  "notes": "",
  "sort": 105
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "6.4",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Cancellation",
  "owner": "Partner",
  "description": "Update all items to cancelled",
  "hint": "Cancellation Reason:",
  "notes": "",
  "sort": 106
 },
 {
  "sheet": "Order Fulfillment",
  "scenario": "6.5",
  "section": "Order Fulfillment - Multiple items with Multiple Quantities, Partial Cancellation",
  "owner": "Target Plus",
  "description": "Validate item cancellation",
  "hint": "Cancellation Reason:",
  "notes": "",
  "sort": 107
 },
 {
  "sheet": "Reporting",
  "scenario": "1.1",
  "section": "Reporting - View Available Reports",
  "owner": "Partner",
  "description": "Request a list of reports available for use",
  "hint": "List the download_url for three reports:",
  "notes": "Note: All information on available reports can be found on plus.target.com",
  "sort": 108
 },
 {
  "sheet": "Reporting",
  "scenario": "1.2",
  "section": "Reporting - View Available Reports",
  "owner": "Target Plus",
  "description": "Validate the results from the Scenario Identifiers are valid",
  "hint": "",
  "notes": "ORDERS, ITEM_ERRORS, INVENTORY, ALLOWED_ITEM_TYPES",
  "sort": 109
 },
 {
  "sheet": "Reporting",
  "scenario": "2.1",
  "section": "Reporting - Create a Report Request",
  "owner": "Partner",
  "description": "Create a request for a new report to find item errors.",
  "hint": "id:\nformat:",
  "notes": "",
  "sort": 110
 },
 {
  "sheet": "Reporting",
  "scenario": "3.1",
  "section": "Reporting - Get the Report Results",
  "owner": "Partner",
  "description": "Request the results for the report you requested be created in scenario 2.1",
  "hint": "status: \ndownload_url:",
  "notes": "",
  "sort": 111
 },
 {
  "sheet": "Reporting",
  "scenario": "3.2",
  "section": "Reporting - Get the Report Results",
  "owner": "Target Plus",
  "description": "Validate the URL from scenario 3.1",
  "hint": "",
  "notes": "",
  "sort": 112
 },
 {
  "sheet": "Reporting",
  "scenario": "4.1",
  "section": "Reporting - Cancelling a Report",
  "owner": "Partner",
  "description": "Create a request for a new report to find all orders created over the past 30 days",
  "hint": "id:",
  "notes": "JSON body to request report for a specific time line\n\n{\n   \"type\": \"ORDERS\",\n   \"format\": \"JSON\",\n   \"start_date\": \"2024-03-01T00:00:00.000Z\",\n   \"end_date\": \"2024-03-22T00:00:00.000Z\"\n}",
  "sort": 113
 },
 {
  "sheet": "Reporting",
  "scenario": "4.2",
  "section": "Reporting - Cancelling a Report",
  "owner": "Partner",
  "description": "Request the cancellation of the report you requested be created in scenario 4.1",
  "hint": "",
  "notes": "Note: Report request placed in a terminal state. If not COMPLETE, the report is now CANCELED. If COMPLETE, the report stays COMPLETE. Nothing is deleted.",
  "sort": 114
 },
 {
  "sheet": "Reporting",
  "scenario": "4.3",
  "section": "Reporting - Cancelling a Report",
  "owner": "Partner",
  "description": "Request the results for the report you just cancelled",
  "hint": "status:",
  "notes": "",
  "sort": 115
 },
 {
  "sheet": "Reporting",
  "scenario": "4.4",
  "section": "Reporting - Cancelling a Report",
  "owner": "Target Plus",
  "description": "Validate the URL, report time range and cancellation of the report from scenario 4.1",
  "hint": "",
  "notes": "",
  "sort": 116
 },
 {
  "sheet": "Reporting",
  "scenario": "5.1",
  "section": "Reporting - Following the Report Process",
  "owner": "Partner",
  "description": "Create a request for a new Allowed Item Type report",
  "hint": "id:",
  "notes": "",
  "sort": 117
 },
 {
  "sheet": "Reporting",
  "scenario": "5.2",
  "section": "Reporting - Following the Report Process",
  "owner": "Partner",
  "description": "Request the results for the report you requested be created in scenario 5.1",
  "hint": "download url:",
  "notes": "",
  "sort": 118
 },
 {
  "sheet": "Reporting",
  "scenario": "6.1",
  "section": "Reporting - Inventory Report",
  "owner": "Partner",
  "description": "Create a request for a new INVENTORY report for published items",
  "hint": "id:",
  "notes": "{\n\t\"type\": \"INVENTORY\",\n\t\"format\": \"CSV\",\n\t\"parameters\": {\n\t\t\"is_published\": true\n\t}\n}\n\n\nNote : Inventory report without is_published param will fetch both published and unpublished item.",
  "sort": 119
 },
 {
  "sheet": "Reporting",
  "scenario": "6.2",
  "section": "Reporting - Inventory Report",
  "owner": "Partner",
  "description": "Request the results for the report you requested be created in scenario 6.1",
  "hint": "download url:",
  "notes": "",
  "sort": 120
 },
 {
  "sheet": "Reporting",
  "scenario": "6.3",
  "section": "Reporting - Inventory Report",
  "owner": "Partner",
  "description": "Create a request for a new INVENTORY report for unpublished items",
  "hint": "id:",
  "notes": "{\n\t\"type\": \"INVENTORY\",\n\t\"format\": \"CSV\",\n\t\"parameters\": {\n\t\t\"is_published\": false\n\t}\n}",
  "sort": 121
 },
 {
  "sheet": "Reporting",
  "scenario": "6.4",
  "section": "Reporting - Inventory Report",
  "owner": "Partner",
  "description": "Request the results for the report you requested be created in scenario 6.3",
  "hint": "download url:",
  "notes": "",
  "sort": 122
 },
 {
  "sheet": "Reporting",
  "scenario": "6.5",
  "section": "Reporting - Inventory Report",
  "owner": "Target Plus",
  "description": "Validate the URL from scenario 6.2 and 6.4",
  "hint": "",
  "notes": "",
  "sort": 123
 },
 {
  "sheet": "Error Path",
  "scenario": "1.1",
  "section": "Error Path - Invalid Tracking Information",
  "owner": "Target Plus",
  "description": "Release purchase order containing a single item with a quantity > 1",
  "hint": "order#:",
  "notes": "",
  "sort": 124
 },
 {
  "sheet": "Error Path",
  "scenario": "1.2",
  "section": "Error Path - Invalid Tracking Information",
  "owner": "Partner",
  "description": "Acknowledge the order has been received",
  "hint": "",
  "notes": "we have already shipped this order and traking number is valid",
  "sort": 125
 },
 {
  "sheet": "Error Path",
  "scenario": "1.3",
  "section": "Error Path - Invalid Tracking Information",
  "owner": "Target Plus",
  "description": "Validate the order has been flagged as \"Acknowledged\"",
  "hint": "",
  "notes": "",
  "sort": 126
 },
 {
  "sheet": "Error Path",
  "scenario": "1.4",
  "section": "Error Path - Invalid Tracking Information",
  "owner": "Partner",
  "description": "Create shipment/fulfillment containing a mismatching tracking number and shipping method (ex: USPS tracking number and UPSGround ship method)",
  "hint": "Tracking:\nMethod:\nError Received:",
  "notes": "Note 1: If you receive an error for a fulfillment, you will want to ensure you correct quickly and accordingly to ensure the guest is notified of the shipment of their item(s)\n\nNote 2: The system does not validate the accuracy of the Shipping Method-Tracking Number pairing, but rather it validates the formatting of the Tracking number i.e. is if the Tracking number used has the right number of digits and if the shipping method used is an approved ship method for the partner.\nHowever, this is not guaranteed to catch all issues as some carrier tracking numbers have similar lengths. It is expected that your team updates valid carrier/tracking number combination from your end.\nThus to simulate the error try removing some digits from a valid tracking number.",
  "sort": 127
 },
 {
  "sheet": "Error Path",
  "scenario": "2.1",
  "section": "Error Path - Invalid Item Type",
  "owner": "Partner",
  "description": "Create standalone (SA) item utilizing valid UPC, item type = nasal spray, and Brand = Valor Fitness",
  "hint": "SKU: \nError Received:",
  "notes": "Note: \nIf you want to list under an item type that is not currently approved, contact your Onboarding Project Manager or Category Manager to request an update to the Allowed Item Types.\n\nLook out for an error related authorization",
  "sort": 128
 },
 {
  "sheet": "Error Path",
  "scenario": "2.2",
  "section": "Error Path - Invalid Item Type",
  "owner": "Target Plus",
  "description": "Validate the item has erred for an invalid item type",
  "hint": "",
  "notes": "",
  "sort": 129
 },
 {
  "sheet": "Error Path",
  "scenario": "2.3",
  "section": "Error Path - Invalid Item Type",
  "owner": "Partner",
  "description": "Update the item type to one which is valid per your legalization",
  "hint": "",
  "notes": "",
  "sort": 130
 },
 {
  "sheet": "Error Path",
  "scenario": "2.4",
  "section": "Error Path - Invalid Item Type",
  "owner": "Target Plus",
  "description": "Confirm update has been sent. Update item status = Approved",
  "hint": "",
  "notes": "",
  "sort": 131
 },
 {
  "sheet": "Error Path",
  "scenario": "3.1",
  "section": "Error Path - Invalid Brand",
  "owner": "Partner",
  "description": "Create standalone (SA) item utilizing valid UPC, item type, and Brand = Artisinal Widgets",
  "hint": "SKU:\nError Received:",
  "notes": "Note: If you are sending a valid, previously approved brand and receiving an error, work with your Target Plus Item Data Specialist to have the brand added.",
  "sort": 132
 },
 {
  "sheet": "Error Path",
  "scenario": "3.2",
  "section": "Error Path - Invalid Brand",
  "owner": "Target Plus",
  "description": "Validate the item has erred for an invalid Brand",
  "hint": "",
  "notes": "",
  "sort": 133
 }
];
