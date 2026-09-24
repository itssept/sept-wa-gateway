"""
test_verified_reporting.py
Verification test suite for SEPT verified reporting invariants.
"""

import unittest
from reporting_guardrails import MessageDeliveryRecord, VerifiedReportingEngine

class TestVerifiedReporting(unittest.TestCase):
    def test_delivery_states(self):
        m1 = MessageDeliveryRecord("m1", "client@wa", "queued", False)
        self.assertIn("queued", VerifiedReportingEngine.get_delivery_status(m1))

        m2 = MessageDeliveryRecord("m2", "client@wa", "attempting_to_send", False)
        self.assertIn("attempting to send", VerifiedReportingEngine.get_delivery_status(m2))

        m3 = MessageDeliveryRecord("m3", "client@wa", "sent", True)
        self.assertIn("Sent (Delivery Confirmed)", VerifiedReportingEngine.get_delivery_status(m3))

        m4 = MessageDeliveryRecord("m4", "client@wa", "failed_to_send", False, "timeout")
        self.assertIn("failed to send", VerifiedReportingEngine.get_delivery_status(m4))

    def test_search_execution(self):
        self.assertEqual(
            VerifiedReportingEngine.report_search(False, 0, "Birkin 30"),
            'Search has not been run for query "Birkin 30".'
        )
        self.assertEqual(
            VerifiedReportingEngine.report_search(True, 0, "Birkin 30"),
            'Search executed: No listing found for "Birkin 30".'
        )

    def test_voice_note_guardrails(self):
        self.assertEqual(
            VerifiedReportingEngine.transcribe_voice_note(False),
            "I couldn't process this voice note."
        )
        self.assertEqual(
            VerifiedReportingEngine.handle_voice_pushback(),
            "I couldn't process this voice note."
        )

if __name__ == "__main__":
    unittest.main()
