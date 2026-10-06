import { expect, test } from "bun:test";
import {
  selectDocumentArtifactRefs,
  preferPdfInvoiceArtifacts,
  isWhatsAppAttachableMime,
  isAttachableArtifactType,
  looksLikeHtmlBytes,
} from "../src/promptql/promptqlAdapter.ts";

test("selectDocumentArtifactRefs drops json/markdown invoice sidecars", () => {
  const refs = selectDocumentArtifactRefs([
    {
      identifier: "invoice_dina_me_dolly",
      title: "invoice_dina_me_dolly",
      artifact_type: "json",
      artifact_reference: { artifact_id: "1", version: 0 },
    },
    {
      identifier: "invoice_dina_me_dolly_md",
      title: "x.md",
      artifact_type: "markdown",
      artifact_reference: { artifact_id: "2", version: 0 },
    },
    {
      identifier: "sept_invoice_dina",
      title: "SEPT-INV.pdf",
      artifact_type: "file",
      artifact_reference: { artifact_id: "3", version: 0 },
    },
  ]);
  expect(refs).toEqual([{ identifier: "sept_invoice_dina", type: "file" }]);
});

test("selectDocumentArtifactRefs drops an HTML invoice chip even when the name says invoice", () => {
  const refs = selectDocumentArtifactRefs([
    {
      identifier: "sept_invoice_html",
      title: "Commercial invoice.html",
      artifact_type: "file",
      artifact_reference: { artifact_id: "h", version: 0 },
    },
    {
      identifier: "invoice_card",
      title: "Invoice",
      artifact_type: "html",
      artifact_reference: { artifact_id: "c", version: 0 },
    },
  ]);
  expect(refs).toEqual([]);
});

test("looksLikeHtmlBytes rejects an HTML chip labeled as a pdf", () => {
  expect(looksLikeHtmlBytes(Buffer.from("<!DOCTYPE html><html><body>Invoice</body></html>"))).toBe(true);
  expect(looksLikeHtmlBytes(Buffer.from("  <html><body>chip</body></html>"))).toBe(true);
  expect(looksLikeHtmlBytes(Buffer.from("%PDF-1.4\n"))).toBe(false);
});

test("isWhatsAppAttachableMime allows pdf/images/text and rejects json/md/html", () => {
  expect(isWhatsAppAttachableMime("application/pdf")).toBe(true);
  expect(isWhatsAppAttachableMime("image/png")).toBe(true);
  expect(isWhatsAppAttachableMime("text/plain")).toBe(true);
  expect(isWhatsAppAttachableMime("application/json")).toBe(false);
  expect(isWhatsAppAttachableMime("text/markdown")).toBe(false);
  expect(isWhatsAppAttachableMime("text/html")).toBe(false);
  expect(isAttachableArtifactType("json")).toBe(false);
  expect(isAttachableArtifactType("markdown")).toBe(false);
  expect(isAttachableArtifactType("file")).toBe(true);
  expect(isAttachableArtifactType("text")).toBe(true);
});

test("preferPdfInvoiceArtifacts drops non-pdf invoice sidecars when a PDF exists", () => {
  const out = preferPdfInvoiceArtifacts([
    {
      ok: true,
      artifact: {
        identifier: "sept_invoice_x",
        title: "SEPT.pdf",
        fileName: "SEPT.pdf",
        mimeType: "application/pdf",
        bytes: Buffer.from("%PDF"),
      },
    },
    {
      ok: true,
      artifact: {
        identifier: "invoice_x_sheet",
        title: "sheet.xlsx",
        fileName: "sheet.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes: Buffer.from("PK"),
      },
    },
  ]);
  expect(out[0]!.ok).toBe(true);
  expect(out[1]!.ok).toBe(false);
  if (!out[1]!.ok) expect(out[1]!.reason).toBe("not_attachable");
});
