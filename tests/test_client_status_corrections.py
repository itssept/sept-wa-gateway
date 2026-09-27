"""
Unit and integration tests for Issue 5 Client Status Corrections & Voice Note Sync.
"""

import unittest
from src.modules.ledger.client_status_corrections import (
    CORRECTED_CLIENT_RECORDS,
    CounterpartyDisambiguator,
    CategoryMatchingGuardrail
)
from src.modules.ledger.voice_note_status_sync import VoiceNoteStatusSync

class TestClientStatusCorrections(unittest.TestCase):

    def test_mariam_disambiguation(self):
        r4 = CounterpartyDisambiguator.disambiguate_mariam("Room 4")
        self.assertEqual(r4["client_name"], "Mariam Lutfallah")
        self.assertEqual(r4["invoice_number"], "INV-20328")

        r5 = CounterpartyDisambiguator.disambiguate_mariam("Room 5")
        self.assertEqual(r5["client_name"], "Mariam Bucheeri")
        self.assertEqual(r5["tracking_number"], "DHL 9244331224")
        self.assertEqual(r5["lifecycle_status"], "delivered")

    def test_category_matching_guardrail(self):
        valid = CategoryMatchingGuardrail.validate_request_match("Bags", "Apparel")
        self.assertFalse(valid)

        sold_out_res = CategoryMatchingGuardrail.handle_sold_out("req_dina_01", "Dina", "Chanel Bag")
        self.assertEqual(sold_out_res["status"], "sold_out")
        self.assertFalse(sold_out_res["allow_fallback_to_other_categories"])

    def test_voice_note_status_sync(self):
        transcript = "The sunglasses arrived and were delivered to Mayfair, and Omar has been paid via Revolut."
        mutations = VoiceNoteStatusSync.parse_transcript_for_mutations(transcript, {"entity_id": "deal_najla_01"})
        
        keywords = [m["matched_keyword"] for m in mutations]
        self.assertIn("delivered", keywords)
        self.assertIn("paid", keywords)

if __name__ == "__main__":
    unittest.main()
