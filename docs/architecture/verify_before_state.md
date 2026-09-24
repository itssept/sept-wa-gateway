# Issue 11: Verify-Before-State (The Shoe Test) Architectural Specification

## Incident Context
Yara sent a photo of a shoe from a designer's Instagram and asked if it was in stores. The previous model answered with an invented product name, SKU, 3-currency prices, and false store availability at Harrods/Selfridges/Saks. The shoe was an unreleased runway piece. The bot built a broken link, failed to re-verify when told, got a sourcer's country wrong, and offered to save invented facts to the wiki.

## Core Invariants Implemented
1. **Never state without real-time lookup**: No lookup = "I can't verify this yet".
2. **Verified URL links only**: Links only come from pages opened and verified via HTTP before sending. Never constructed.
3. **Temporal awareness & release lifecycle**: Evaluate post date against runtime date (2026-09-24). Pre-show teaser != drop. Brand site first.
4. **Wiki item fact provenance**: Reject unsourced or `estimated_by_agent` item facts.
5. **WhatsApp outbound gate**: Strict verification parity before any message reaches WhatsApp.
6. **Broken link full re-verification**: Broken link report triggers full re-verification of the entire premise, answer, and sources from scratch.
7. **Sourcer country resolution**: Strict lookup in sourcers registry; no speculative geography.
