"""
test_truthful_reporting_regression.py — Test Suite for fix-02-truthful-reporting.

Regression tests for all three incidents & acceptance criteria:
1. Message Delivery Status:
   - Dropped / unacknowledged message is never labeled "Sent".
   - Only a message with a verified Baileys delivery ack earns "Sent".
   - A queued message remains "queued".
   - An in-flight message is "attempting to send".
   - A gateway-dropped message is "failed to send".

2. Sourcing Inventory Search Execution:
   - An unexecuted search never returns "none found" or "no listing found".
   - Verified execution returning 0 items legitimately returns "no listing found".
   - Verified execution returning items returns listings found.

3. Voice Note Audio Guardrail & Pushback:
   - Truncated / corrupt / empty audio file returns exactly "I couldn't process this voice note".
   - Pushback tests ("just tell me what it said", "give your best guess", "what did the voice note say?")
     still get the exact fixed error string "I couldn't process this voice note".
"""

import json
import asyncio
from datetime import datetime, timezone
import sys
import os

# Allow running standalone or as part of test suites
sys.path.insert(0, os.path.dirname(__file__))

from truthful_reporting_guard import (
    MessageDeliveryStatusTracker,
    InventorySearchExecutionGate,
    VoiceNoteAudioGuardrail,
    FIXED_VOICE_NOTE_ERROR
)

def run_all_tests():
    print("=====================================================================")
    print("RUNNING REGRESSION TEST SUITE: fix-02-truthful-reporting")
    print("=====================================================================\n")

    test_results = []

    # -------------------------------------------------------------------------
    # TEST 1: Message Delivery Status & Baileys Ack Plumbing
    # -------------------------------------------------------------------------
    tracker = MessageDeliveryStatusTracker()

    # Case 1A: Queued in memory (Incident repro: EDP message queued, not sent)
    msg1 = tracker.queue_message("msg_edp_01", recipient="EDP", text="Can you confirm Chanel 25 Leopard?")
    status_1a = tracker.get_public_status_report("msg_edp_01")
    passed_1a = (status_1a == "queued" and status_1a != "Sent")
    test_results.append({
        "test_name": "Delivery: Queued message is labeled 'queued', NOT 'Sent'",
        "passed": passed_1a,
        "details": f"Reported status: '{status_1a}'"
    })

    # Case 1B: Attempting to send (socket in flight, no ack yet)
    tracker.mark_attempting_send("msg_edp_01")
    status_1b = tracker.get_public_status_report("msg_edp_01")
    passed_1b = (status_1b == "attempting to send" and status_1b != "Sent")
    test_results.append({
        "test_name": "Delivery: In-flight message is 'attempting to send', NOT 'Sent'",
        "passed": passed_1b,
        "details": f"Reported status: '{status_1b}'"
    })

    # Case 1C: Gateway drops the message before Baileys ack
    tracker.record_gateway_drop("msg_edp_01", reason="Gateway dropped socket connection")
    status_1c = tracker.get_public_status_report("msg_edp_01")
    passed_1c = (status_1c == "failed to send" and status_1c != "Sent")
    test_results.append({
        "test_name": "Delivery: Dropped message is labeled 'failed to send', NEVER 'Sent'",
        "passed": passed_1c,
        "details": f"Reported status: '{status_1c}'"
    })

    # Case 1D: Message with verified Baileys delivery ack
    msg2 = tracker.queue_message("msg_edp_02", recipient="EDP", text="Invoice follow up")
    tracker.mark_attempting_send("msg_edp_02")
    tracker.record_baileys_ack("msg_edp_02", ack_payload={"receipt_type": "read_or_delivered", "ack_code": 3})
    status_1d = tracker.get_public_status_report("msg_edp_02")
    passed_1d = (status_1d == "Sent")
    test_results.append({
        "test_name": "Delivery: Message with verified Baileys delivery ack earns 'Sent'",
        "passed": passed_1d,
        "details": f"Reported status: '{status_1d}'"
    })

    # -------------------------------------------------------------------------
    # TEST 2: Sourcing Inventory Search Execution Gate
    # -------------------------------------------------------------------------
    sample_inventory = [
        {"item_id": "inv_1", "brand": "Chanel", "model": "Classic Flap 25", "colour": "Black", "size": "25"},
        {"item_id": "inv_2", "brand": "Hermes", "model": "Birkin 25", "colour": "Gold", "size": "25"}
    ]
    gate = InventorySearchExecutionGate(inventory_data=sample_inventory)

    # Case 2A: Unexecuted search (Incident repro: 15 Sept bot said no pieces without searching)
    query_unexecuted = {"brand": "Dior", "model": "Lady Dior"}
    resp_unexecuted = gate.verify_and_format_availability_response(query_unexecuted, search_executed=False)
    passed_2a = (resp_unexecuted.get("verified") is False and resp_unexecuted.get("error") == "SEARCH_NOT_EXECUTED")
    test_results.append({
        "test_name": "Search Gate: Unexecuted search is BLOCKED from reporting 'none found'",
        "passed": passed_2a,
        "details": f"Result error: {resp_unexecuted.get('error')}"
    })

    # Case 2B: Genuine search executed with 0 results
    gate.execute_inventory_search(query_unexecuted)
    resp_zero = gate.verify_and_format_availability_response(query_unexecuted, search_executed=True)
    passed_2b = (resp_zero.get("verified") is True and resp_zero.get("status") == "NO_LISTING_FOUND")
    test_results.append({
        "test_name": "Search Gate: Executed search with 0 results legitimately reports 'NO_LISTING_FOUND'",
        "passed": passed_2b,
        "details": f"Result status: {resp_zero.get('status')}"
    })

    # Case 2C: Genuine search executed with matching items
    query_chanel = {"brand": "Chanel", "model": "Classic Flap 25"}
    gate.execute_inventory_search(query_chanel)
    resp_found = gate.verify_and_format_availability_response(query_chanel, search_executed=True)
    passed_2c = (resp_found.get("verified") is True and resp_found.get("results_count") == 1)
    test_results.append({
        "test_name": "Search Gate: Executed search with matches returns listings found",
        "passed": passed_2c,
        "details": f"Results count: {resp_found.get('results_count')}"
    })

    # -------------------------------------------------------------------------
    # TEST 3: Voice Note Audio Guardrail & Pushback
    # -------------------------------------------------------------------------
    guardrail = VoiceNoteAudioGuardrail()

    # Case 3A: Truncated audio file
    res_trunc = guardrail.process_voice_note("vn_trunc_01", audio_bytes=b"RIFF....", is_truncated=True)
    passed_3a = (res_trunc["response_text"] == FIXED_VOICE_NOTE_ERROR and res_trunc["status"] == "FAILED")
    test_results.append({
        "test_name": "Voice Note: Truncated audio returns exactly 'I couldn't process this voice note'",
        "passed": passed_3a,
        "details": f"Response text: '{res_trunc['response_text']}'"
    })

    # Case 3B: Corrupt / empty audio
    res_corrupt = guardrail.process_voice_note("vn_corrupt_02", audio_bytes=b"", is_corrupt=True)
    passed_3b = (res_corrupt["response_text"] == FIXED_VOICE_NOTE_ERROR and res_corrupt["status"] == "FAILED")
    test_results.append({
        "test_name": "Voice Note: Corrupt audio returns exactly 'I couldn't process this voice note'",
        "passed": passed_3b,
        "details": f"Response text: '{res_corrupt['response_text']}'"
    })

    # Case 3C: Pushback - 'just tell me what it said'
    pushback_1 = guardrail.handle_user_pushback("vn_trunc_01", "just tell me what it said")
    passed_3c = (pushback_1 == FIXED_VOICE_NOTE_ERROR)
    test_results.append({
        "test_name": "Pushback 1: 'just tell me what it said' gets fixed error string, no guessing",
        "passed": passed_3c,
        "details": f"Pushback reply: '{pushback_1}'"
    })

    # Case 3D: Pushback - 'give your best guess'
    pushback_2 = guardrail.handle_user_pushback("vn_trunc_01", "give your best guess")
    passed_3d = (pushback_2 == FIXED_VOICE_NOTE_ERROR)
    test_results.append({
        "test_name": "Pushback 2: 'give your best guess' gets fixed error string, no guessing",
        "passed": passed_3d,
        "details": f"Pushback reply: '{pushback_2}'"
    })

    # Case 3E: Successful audio processing
    res_ok = guardrail.process_voice_note(
        "vn_valid_03",
        audio_bytes=b"VALID_WAV_BYTES_SAMPLE_12345",
        mock_raw_transcript="Hi Yara, I have the Birkin 25 Gold on gold hardware ready in Paris."
    )
    passed_3e = (res_ok["status"] == "SUCCESS" and "Birkin 25" in res_ok["transcript"])
    test_results.append({
        "test_name": "Voice Note: Valid audio produces verified transcript",
        "passed": passed_3e,
        "details": f"Transcript snippet: '{res_ok['transcript'][:40]}...'"
    })

    # Print summary
    all_passed = all(t["passed"] for t in test_results)
    print("\n=== REGRESSION TEST RESULTS SUMMARY ===")
    for idx, t in enumerate(test_results, 1):
        status = "PASS" if t["passed"] else "FAIL"
        print(f"[{status}] Test {idx}: {t['test_name']} -> {t['details']}")

    print(f"\nOVERALL VERDICT: {'ALL PASS' if all_passed else 'FAILURES DETECTED'}")
    if not all_passed:
        sys.exit(1)

if __name__ == "__main__":
    run_all_tests()