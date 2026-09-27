# Test suite for proactive runs engine (Issue 7)
import unittest
from proactive_runs import ProactiveEngine

class TestProactiveEngine(unittest.TestCase):
    def setUp(self):
        self.mock_inventory = [
            {
                "id": "inv-001",
                "brand": "Chanel",
                "model": "Classic Flap Medium",
                "size": "Medium",
                "colour": "Black",
                "hardware": "Gold",
                "condition": "Store Fresh",
                "price": 9800,
                "price_currency": "EUR",
                "created_at": "2026-09-24T08:00:00Z", # Today / Fresh
                "status": "available",
                "source_type": "sourcer"
            },
            {
                "id": "inv-002",
                "brand": "Hermes",
                "model": "Birkin 25",
                "size": "25",
                "colour": "Craie",
                "hardware": "Gold",
                "condition": "Store Fresh",
                "price": 24500,
                "price_currency": "EUR",
                "created_at": "2026-09-10T10:00:00Z", # 14 days ago / Stale
                "status": "available",
                "source_type": "sourcer"
            }
        ]
        
        self.mock_requests = [
            {
                "id": "req-001",
                "client_id": "c-001",
                "client_name": "Lana K.",
                "brand": "Chanel",
                "model": "Classic Flap Medium",
                "size": "Medium",
                "colour": "Black",
                "max_budget": 10500,
                "status": "active",
                "created_at": "2026-09-23T12:00:00Z"
            }
        ]
        
        self.mock_deals = [
            {
                "id": "deal-001",
                "client_name": "Lana K.",
                "item_desc": "Chanel Classic Flap",
                "status": "payment_pending",
                "amount": 10200,
                "currency": "EUR",
                "updated_at": "2026-09-22T08:00:00Z" # > 24h stalled
            }
        ]
        
        self.mock_sourcers = [
            {
                "id": "src-001",
                "sourcer_name": "Marcello (Milan)",
                "sourcer_handle": "+393331234567",
                "item_desc": "Hermes Kelly 28 Togo Noir GHW",
                "received_at": "2026-09-22T10:00:00Z", # > 24h unquoted
                "status": "quote_pending"
            }
        ]

    def test_inventory_aging_segmentation(self):
        engine = ProactiveEngine(
            inventory=self.mock_inventory,
            requests=self.mock_requests,
            deals=self.mock_deals,
            sourcer_quotes=self.mock_sourcers
        )
        fresh, stale = engine.analyze_inventory_aging()
        self.assertEqual(len(fresh), 1)
        self.assertEqual(len(stale), 1)
        self.assertEqual(fresh[0]["id"], "inv-001")
        self.assertEqual(stale[0]["id"], "inv-002")
        self.assertIn("confirm it's still available", stale[0]["age_warning"].lower())

    def test_deduplication(self):
        engine = ProactiveEngine(
            inventory=self.mock_inventory,
            requests=self.mock_requests,
            deals=self.mock_deals,
            sourcer_quotes=self.mock_sourcers
        )
        first_digest = engine.generate_morning_digest()
        self.assertIn("Chanel Classic Flap Medium", first_digest["message_body"])
        
        # Second run without changes should suppress repeated entries
        second_digest = engine.generate_morning_digest()
        self.assertIn("deduplicated", second_digest["message_body"].lower())

    def test_sourcer_24h_followups(self):
        engine = ProactiveEngine(
            inventory=self.mock_inventory,
            requests=self.mock_requests,
            deals=self.mock_deals,
            sourcer_quotes=self.mock_sourcers
        )
        followups = engine.draft_sourcer_followups()
        self.assertEqual(len(followups), 1)
        self.assertEqual(followups[0]["sourcer_name"], "Marcello (Milan)")
        self.assertIn("Kelly 28", followups[0]["draft_message"])

if __name__ == '__main__':
    unittest.main()
