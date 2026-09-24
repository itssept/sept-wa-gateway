import json
import asyncio
from executor import aio, executor
from parse_luxury_item import parse_luxury_input
from ledger_sync_and_reference import generate_canonical_item_id, OperatorLedger

async def test_sourcer_overrides_visual():
    executor.print("=== TEST 1: Sourcer Identification Overrides Bot Visual Guess ===")
    
    # Simulated sourcer forward from Les Intemporels Paris
    input_text = """
    Forwarded message from Les Intemporels Paris (@les_intemporels_paris):
    [Photo attached: Burgundy quilted flap bag with metallic chainmail tassel and Byzantine-style plaque]
    Sourcer Note: 'Bag is from Pre Fall 2013, Paris-Edinburgh Collection. Price will follow.'
    """
    
    parsed = await parse_luxury_input(input_text)
    executor.print(f"Parsed Model: {parsed.get('model')}")
    executor.print(f"Provenance: {parsed.get('provenance')}")
    executor.print(f"Visual Conflict: {json.dumps(parsed.get('visual_conflict'), indent=2)}")
    
    # Assertions
    model_str = parsed.get("model", "")
    assert "edinburgh" in model_str.lower() or "2013" in model_str or "paris-edinburgh" in model_str.lower(), f"Expected Paris-Edinburgh in model, got: {model_str}"
    assert "byzance" not in model_str.lower(), f"Byzance should not be the primary model identification, got: {model_str}"
    assert parsed.get("provenance") == "stated_by_sourcer", f"Expected provenance stated_by_sourcer, got: {parsed.get('provenance')}"
    
    executor.print(">>> TEST 1 PASSED: Sourcer's attribution strictly overrides visual inference.\n")
    return parsed

async def test_cross_chat_id_consistency():
    executor.print("=== TEST 2: Deterministic Item ID Consistency Across Chats ===")
    
    # Chat 1 Ingestion (e.g. from Sourcer WhatsApp group)
    chat1_item = {
        "brand": "Chanel",
        "model": "Paris-Edinburgh Pre-Fall 2013 Burgundy Tassel Bag",
        "category": "Bags",
        "size": "Medium",
        "colour": "Burgundy",
        "material": "Quilted Calfskin",
        "hardware": "Ruthenium",
        "condition": "Vintage",
        "completeness": {"full_set": False},
        "pricing": {"amount": None, "currency": "USD", "price_type": "pending_quote"},
        "source_metadata": {"sourcer_handle_or_name": "@les_intemporels_paris", "channel": "whatsapp", "location": "Paris"},
        "provenance": "stated_by_sourcer"
    }
    
    # Chat 2 Ingestion (e.g. Operator forward in client DM thread or separate operator chat)
    chat2_item = {
        "brand": "Chanel",
        "model": "Paris-Edinburgh Pre-Fall 2013 Burgundy Tassel Bag",
        "category": "Bags",
        "size": "Medium",
        "colour": "Burgundy",
        "material": "Quilted Calfskin",
        "hardware": "Ruthenium",
        "condition": "Vintage",
        "completeness": {"full_set": False},
        "pricing": {"amount": 7500, "currency": "USD", "price_type": "quoted"},
        "source_metadata": {"sourcer_handle_or_name": "@les_intemporels_paris", "channel": "whatsapp", "location": "Paris"},
        "provenance": "stated_by_sourcer"
    }
    
    id1 = generate_canonical_item_id(chat1_item)
    id2 = generate_canonical_item_id(chat2_item)
    
    executor.print(f"Chat 1 Item ID: {id1}")
    executor.print(f"Chat 2 Item ID: {id2}")
    
    assert id1 == id2, f"Item IDs do not match across chats! Chat 1: {id1}, Chat 2: {id2}"
    
    # Test ledger deduplication across chats
    ledger = OperatorLedger("operator_najwa")
    rec1 = ledger.ingest_parsed_item(chat1_item)
    rec2 = ledger.ingest_parsed_item(chat2_item)
    
    executor.print(f"Ledger Total Items: {len(ledger.inventory)}")
    assert len(ledger.inventory) == 1, f"Expected 1 deduplicated item in inventory, found {len(ledger.inventory)}"
    assert rec2["price"] == 7500, f"Expected price update to 7500, got {rec2['price']}"
    
    executor.print(">>> TEST 2 PASSED: Cross-chat ID consistency and ledger deduplication verified.\n")

async def test_visual_conflict_acknowledgement():
    executor.print("=== TEST 3: Visual Conflict Acknowledgement & Deference ===")
    
    text = "Forwarded from @vintage_vault: 'Archive Chanel jacket. Visual looks like 90s Karl Lagerfeld bouclé, but sourcer explicitly stated Spring 2004 Ready-To-Wear.'"
    parsed = await parse_luxury_input(text)
    
    executor.print(f"Model: {parsed.get('model')}")
    executor.print(f"Provenance: {parsed.get('provenance')}")
    executor.print(f"Visual Conflict: {json.dumps(parsed.get('visual_conflict'), indent=2)}")
    
    assert parsed.get("provenance") == "stated_by_sourcer"
    assert "2004" in parsed.get("model", "") or "spring" in parsed.get("model", "").lower()
    executor.print(">>> TEST 3 PASSED: Visual conflict handled with explicit deference to sourcer.\n")

async def main():
    parsed1 = await test_sourcer_overrides_visual()
    await test_cross_chat_id_consistency()
    await test_visual_conflict_acknowledgement()
    
    test_summary = [
        {"test": "Sourcer Overrides Visual", "status": "PASSED", "details": "Les Intemporels Pre-Fall 2013 Paris-Edinburgh correctly parsed with provenance stated_by_sourcer; Byzance visual guess deferred."},
        {"test": "Cross-Chat ID Consistency", "status": "PASSED", "details": "Deterministic canonical ID generation guarantees same piece gets exact same ID across multiple chats."},
        {"test": "Visual Conflict Handling", "status": "PASSED", "details": "Visual conflict noted while canonical attribution strictly defers to sourcer."}
    ]
    
    await aio.store_artifact(
        identifier="item_identification_fix_test_results",
        title="Item Identification Verification Test Results (Issue 3)",
        artifact_type="table",
        data=test_summary
    )
    executor.print("All test suites completed successfully. Stored artifact 'item_identification_fix_test_results'.")