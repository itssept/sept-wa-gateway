"""
test_item_identity.py — Comprehensive Test Suite for fix-03-item-identity.

Acceptance Criteria:
1. Replaying the Les Intemporels case keeps "Pre-Fall 2013 Paris-Edinburgh" and does NOT override with "Chanel Byzance".
2. The same piece sent in two different chats resolves to ONE canonical piece_id.
3. Two genuinely different similar-looking pieces do NOT merge (false-positive test).
4. Rule 41 (Provenance Priority): sourcer stated season/collection/year/provenance stored as stated_by_sourcer.
"""

import json
import asyncio
from executor import aio, executor
from item_identity_resolver import ItemIdentityResolver, normalize_text_attribute, compute_perceptual_image_hash

async def run_all_tests():
    executor.print("=================================================================")
    executor.print("RUNNING FIX-03-ITEM-IDENTITY ACCEPTANCE & REGRESSION SUITE")
    executor.print("=================================================================\n")

    resolver = ItemIdentityResolver()
    test_results = []

    def log_test(test_name: str, passed: bool, details: str):
        test_results.append({
            "test_name": test_name,
            "passed": passed,
            "details": details
        })
        status_str = "PASS" if passed else "FAIL"
        executor.print(f"[{status_str}] {test_name}\n    -> {details}\n")

    # --------------------------------------------------------------------------
    # Test 1: Les Intemporels Paris-Edinburgh Case (Rule 41 Provenance Priority)
    # --------------------------------------------------------------------------
    executor.print("--- Test 1: Replay Les Intemporels Case (Rule 41 Provenance Priority) ---")
    les_intemporels_sourcer_spec = {
        "brand": "Chanel",
        "model": "Pre-Fall 2013 Paris-Edinburgh Burgundy Tassel Flap Bag",
        "season": "Pre-Fall",
        "collection": "Paris-Edinburgh Métiers d'Art",
        "year": "2013",
        "size": "Medium / 25cm",
        "colour": "Burgundy",
        "material": "Aged Calfskin",
        "hardware": "Ruthenium",
        "provenance_text": "Chanel Pre-Fall 2013 Paris-Edinburgh Collection from private collector"
    }

    # Vision model hallucination/guess trying to override with "Chanel Byzance"
    vision_model_guess = {
        "silhouette": "Structured flap bag with fringe tassel",
        "model_guess": "Chanel Paris-Byzance Pre-Fall 2011",
        "inferred_collection": "Paris-Byzance 2011",
        "visual_notes": "Antique ruthenium medallion and decorative tassel embellishment resembling Byzance motifs."
    }

    sourcer_meta_1 = {
        "sourcer_handle_or_name": "@lesintemporels.paris",
        "phone": "+961 81 324 102"
    }

    res_1 = resolver.resolve_and_ingest_piece(
        chat_id="whatsapp_chat_vip_client_group",
        message_id="msg_turn_101",
        sourcer_stated_spec=les_intemporels_sourcer_spec,
        visual_inference=vision_model_guess,
        sourcer_meta=sourcer_meta_1,
        image_data="phash:a1b2c3d4e5f60011"
    )

    piece_1 = res_1["resolved_piece"]
    
    t1_pass = (
        "Pre-Fall 2013 Paris-Edinburgh" in piece_1["model"] and
        "Paris-Byzance" not in piece_1["model"] and
        piece_1["provenance"] == "stated_by_sourcer" and
        piece_1["stated_by_sourcer"]["year"] == "2013" and
        piece_1["stated_by_sourcer"]["collection"] == "Paris-Edinburgh Métiers d'Art" and
        piece_1["internal_visual_observations"]["discarded_visual_model_guess"] == "Chanel Paris-Byzance Pre-Fall 2011" and
        piece_1["sourcer_base_country_code"] == "LB"
    )

    log_test(
        "Criterion 1: Replaying Les Intemporels case retains 'Pre-Fall 2013 Paris-Edinburgh' without Byzance override",
        t1_pass,
        f"Resolved Model: '{piece_1['model']}', Provenance: '{piece_1['provenance']}', Discarded Guess: '{piece_1['internal_visual_observations']['discarded_visual_model_guess']}'"
    )

    # --------------------------------------------------------------------------
    # Test 2: Cross-Chat Canonical Piece ID Resolution (Same Piece, Two Chats)
    # --------------------------------------------------------------------------
    executor.print("--- Test 2: Same piece sent in two different chats resolves to ONE piece_id ---")
    
    # Same physical piece sent 3 days later in a 1:1 direct chat with a personal shopper
    res_2 = resolver.resolve_and_ingest_piece(
        chat_id="whatsapp_1on1_operator_direct",
        message_id="msg_turn_205",
        sourcer_stated_spec=les_intemporels_sourcer_spec,
        visual_inference=vision_model_guess,
        sourcer_meta=sourcer_meta_1,
        image_data="phash:a1b2c3d4e5f60011"
    )

    piece_2 = res_2["resolved_piece"]

    t2_pass = (
        res_1["piece_id"] == res_2["piece_id"] and
        res_2["is_deduplicated_across_chats"] == True and
        piece_2["frequency_seen"] == 2 and
        len(piece_2["associated_chats"]) == 2
    )

    log_test(
        "Criterion 2: Same physical piece sent across 2 different chats resolves to identical piece_id",
        t2_pass,
        f"Chat 1 ID: {res_1['piece_id']}, Chat 2 ID: {res_2['piece_id']}, Deduplicated: {res_2['is_deduplicated_across_chats']}, Frequency: {piece_2['frequency_seen']}"
    )

    # --------------------------------------------------------------------------
    # Test 3: False-Positive Separation (Two genuinely different similar-looking pieces)
    # --------------------------------------------------------------------------
    executor.print("--- Test 3: Two genuinely different similar-looking pieces do NOT merge ---")
    
    # Piece A: Hermès Birkin 25 Togo Gold with GHW from sourcer EDP
    birkin_gold_ghw = {
        "brand": "Hermès",
        "model": "Birkin 25",
        "season": "2024",
        "size": "25",
        "colour": "Gold",
        "material": "Togo Leather",
        "hardware": "Gold Hardware (GHW)",
        "provenance_text": "B25 Gold Togo GHW full set from boutique"
    }
    sourcer_edp = {"sourcer_handle_or_name": "@edp_luxury", "phone": "+33 6 12 34 56 78"}

    res_birkin_a = resolver.resolve_and_ingest_piece(
        chat_id="chat_group_hermes_dealers",
        message_id="msg_h1",
        sourcer_stated_spec=birkin_gold_ghw,
        visual_inference={"silhouette": "Birkin top handle", "visual_notes": "Gold leather with gold clasp"},
        sourcer_meta=sourcer_edp,
        image_data="phash:1111222233334444"
    )

    # Piece B: Hermès Birkin 25 Togo Gold with PHW (Palladium Hardware) from sourcer EDP (different piece!)
    birkin_gold_phw = {
        "brand": "Hermès",
        "model": "Birkin 25",
        "season": "2024",
        "size": "25",
        "colour": "Gold",
        "material": "Togo Leather",
        "hardware": "Palladium Hardware (PHW)",
        "provenance_text": "B25 Gold Togo PHW brand new in box"
    }

    res_birkin_b = resolver.resolve_and_ingest_piece(
        chat_id="chat_group_hermes_dealers",
        message_id="msg_h2",
        sourcer_stated_spec=birkin_gold_phw,
        visual_inference={"silhouette": "Birkin top handle", "visual_notes": "Gold leather with silver clasp"},
        sourcer_meta=sourcer_edp,
        image_data="phash:5555666677778888"
    )

    # Piece C: Chanel Paris-Byzance Genuine Bag from a different sourcer (Luv Story)
    chanel_byzance_genuine = {
        "brand": "Chanel",
        "model": "Paris-Byzance Pre-Fall 2011 Flap Bag",
        "season": "Pre-Fall",
        "collection": "Paris-Byzance",
        "year": "2011",
        "size": "Medium",
        "colour": "Burgundy",
        "material": "Calfskin",
        "hardware": "Aged Gold",
        "provenance_text": "Authentic Paris-Byzance 2011 from vintage estate"
    }
    sourcer_luvstory = {"sourcer_handle_or_name": "@its_aluvstory", "phone": "+44 7700 900077"}

    res_byzance = resolver.resolve_and_ingest_piece(
        chat_id="chat_vintage_chanel",
        message_id="msg_byz_1",
        sourcer_stated_spec=chanel_byzance_genuine,
        visual_inference={"silhouette": "Flap bag with byzance medallion", "visual_notes": "Aged gold coins"},
        sourcer_meta=sourcer_luvstory,
        image_data="phash:9999888877776666"
    )

    t3_pass = (
        res_birkin_a["piece_id"] != res_birkin_b["piece_id"] and
        res_1["piece_id"] != res_byzance["piece_id"] and
        res_birkin_a["piece_id"] != res_1["piece_id"] and
        len(resolver.pieces_ledger) == 4
    )

    log_test(
        "Criterion 3: Two genuinely different similar-looking pieces do NOT merge (False-Positive Test)",
        t3_pass,
        f"Birkin GHW ID: {res_birkin_a['piece_id']} != Birkin PHW ID: {res_birkin_b['piece_id']} | Paris-Edinburgh ID: {res_1['piece_id']} != Paris-Byzance ID: {res_byzance['piece_id']}"
    )

    # --------------------------------------------------------------------------
    # Test 4: Provenance Priority with Visual Discrepancy & Ambiguous Handling
    # --------------------------------------------------------------------------
    executor.print("--- Test 4: Rule 41 Strict Provenance Tagging & Visual Inference Demotion ---")
    
    test_dior_saddle = {
        "brand": "Dior",
        "model": "Galliano 2004 Rasta Saddle Bag",
        "season": "Spring/Summer",
        "year": "2004",
        "collection": "Rasta / Trotter Collection",
        "size": "Medium",
        "colour": "Beige / Red / Yellow / Green",
        "material": "Trotter Canvas / Leather",
        "hardware": "Silver Tone",
        "provenance_text": "Archival John Galliano 2004 Rasta saddle from private archive"
    }
    vision_dior_guess = {
        "silhouette": "Asymmetrical saddle bag",
        "model_guess": "Contemporary Oblique Saddle Bag",
        "visual_notes": "Saddle curve with CD charms and tricolor trim"
    }
    
    res_dior = resolver.resolve_and_ingest_piece(
        chat_id="chat_dior_archival",
        message_id="msg_dior_1",
        sourcer_stated_spec=test_dior_saddle,
        visual_inference=vision_dior_guess,
        sourcer_meta=sourcer_luvstory,
        image_data="phash:3333444455556666"
    )
    piece_dior = res_dior["resolved_piece"]

    t4_pass = (
        piece_dior["model"] == "Galliano 2004 Rasta Saddle Bag" and
        piece_dior["provenance"] == "stated_by_sourcer" and
        piece_dior["year"] == "2004" and
        piece_dior["internal_visual_observations"]["discarded_visual_model_guess"] == "Contemporary Oblique Saddle Bag" and
        piece_dior["internal_visual_observations"]["override_attempt_suppressed"] == True
    )

    log_test(
        "Criterion 4: Rule 41 correctly preserves archival sourcer claims over contemporary visual model inferences",
        t4_pass,
        f"Model: '{piece_dior['model']}', Provenance: '{piece_dior['provenance']}', Suppressed Guess: '{piece_dior['internal_visual_observations']['discarded_visual_model_guess']}'"
    )

    # --------------------------------------------------------------------------
    # Store Test Artifacts
    # --------------------------------------------------------------------------
    await aio.store_artifact(
        identifier="fix_03_item_identity_test_results",
        title="Fix 03: Item Identity & Rule 41 Acceptance Test Results",
        artifact_type="table",
        data=test_results
    )

    pieces_ledger_rows = list(resolver.pieces_ledger.values())
    formatted_ledger_rows = []
    for row in pieces_ledger_rows:
        formatted_ledger_rows.append({
            "piece_id": row["piece_id"],
            "brand": row["brand"],
            "model": row["model"],
            "season_year": f"{row.get('season') or ''} {row.get('year') or ''}".strip(),
            "colour": row["colour"],
            "hardware": row["hardware"],
            "provenance": row["provenance"],
            "sourcer_id": row["sourcer_id"],
            "frequency_seen": row["frequency_seen"],
            "associated_chats_count": len(row["associated_chats"])
        })

    await aio.store_artifact(
        identifier="central_pieces_ledger_sample",
        title="Central Pieces Ledger Sample (Multi-Chat Canonical Resolution)",
        artifact_type="table",
        data=formatted_ledger_rows
    )

    total_tests = len(test_results)
    passed_tests = sum(1 for t in test_results if t["passed"])
    failed_tests = total_tests - passed_tests
    
    executor.print("\n" + "="*65)
    executor.print(f"ACCEPTANCE TEST SUMMARY: {passed_tests}/{total_tests} PASSED ({failed_tests} FAILED)")
    executor.print("="*65 + "\n")

async def main():
    await run_all_tests()