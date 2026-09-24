import json
from datetime import datetime
import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), '..'))

from src.guards.verifyBeforeStateGuard import VerifyBeforeStateGuard

def run_regression_tests():
    guard = VerifyBeforeStateGuard()
    test_results = []

    # 1. Reference Shoe Incident (Instagram Teaser / Pre-Show Runway)
    query_1 = {
        "image_url": "https://instagram.com/p/teaser_shoe_123.jpg",
        "source_context": "Yara sent photo from designer's Instagram. Caption hints at runway preview. Show is Tuesday.",
        "post_date": "2026-09-24",
        "lookups_performed": [{"target": "brand_official_site", "type": "catalog_search", "success": False}]
    }
    res_1 = guard.verify_item_query(query_1)
    t1_pass = (
        res_1["lifecycle_stage"] == "pre_release_teaser_runway" and
        res_1["sku"] is None and
        res_1["prices"] is None and
        res_1["retail_availability"] is None and
        res_1["can_add_to_wiki"] is False and
        "not yet in stores" in res_1["response_text"].lower()
    )
    test_results.append({"test_id": "TEST-1-SHOE-INCIDENT", "passed": t1_pass})

    # 2. URL / Link Gating & Construction Prevention
    c_link = guard.check_link_validity("https://www.harrods.com/en-gb/shopping/unreleased-shoe", open_and_verified=False)
    v_link = guard.check_link_validity("https://www.chanel.com/us/fashion/p/AS4297B25644AC885/", open_and_verified=True)
    t2_pass = (not c_link["permitted"]) and v_link["permitted"]
    test_results.append({"test_id": "TEST-2-LINK-VERIFICATION", "passed": t2_pass})

    # 3. Broken Link Pushback -> Full Re-Verification
    re_verif = guard.handle_broken_link_feedback("This link doesn't work", res_1)
    t3_pass = re_verif["action"] == "FULL_REVERIFICATION_TRIGGERED" and re_verif["recheck_item_premise"] is True
    test_results.append({"test_id": "TEST-3-BROKEN-LINK-REVERIFY-ALL", "passed": t3_pass})

    # 4. Wiki Fact Provenance & Rejection of Unsourced Item Facts
    wiki_unsourced = guard.verify_wiki_addition({"source": "unverified_llm_inference", "provenance": "estimated_by_agent"})
    wiki_sourced = guard.verify_wiki_addition({"source": "official_brand_catalog", "provenance": "stated_by_operator"})
    t4_pass = (not wiki_unsourced["allowed"]) and wiki_sourced["allowed"]
    test_results.append({"test_id": "TEST-4-WIKI-PROVENANCE", "passed": t4_pass})

    # 5. Sourcer Country Verification (Prevent Geo Inventions)
    s1 = guard.verify_sourcer_location("@lesintemporels.paris")
    s2 = guard.verify_sourcer_location("@unknown_supplier_99")
    t5_pass = (s1["country"] == "France" and s2["verified"] is False and s2["country"] == "Unknown")
    test_results.append({"test_id": "TEST-5-SOURCER-COUNTRY", "passed": t5_pass})

    # 6. WhatsApp Outbound Safety Gate
    wa_check_pass = res_1["whatsapp_safe"] and (res_1["sku"] is None) and (res_1["prices"] is None)
    test_results.append({"test_id": "TEST-6-WHATSAPP-SAFETY-GATE", "passed": wa_check_pass})

    # 7. Temporal Date & Release Stage Discrimination
    t7_pass = (guard.current_date.year == 2026 and res_1["lifecycle_stage"] == "pre_release_teaser_runway")
    test_results.append({"test_id": "TEST-7-TEMPORAL-RELEASE-REASONING", "passed": t7_pass})

    all_pass = all(t["passed"] for t in test_results)
    print(f"Regression Test Run: {sum(1 for t in test_results if t['passed'])}/{len(test_results)} passed.")
    assert all_pass, "Some tests failed!"
    return test_results

if __name__ == "__main__":
    run_regression_tests()
