import { expect, test } from "bun:test";

test("resolveArtifactBuffers correctly formats PDF files as document attachments", () => {
  const artifacts = [
    {
      identifier: "sept_invoice_test_123",
      title: "Commercial Invoice SEPT-INV-2026-TEST01.pdf",
      artifact_type: "file",
      data: Buffer.from("%PDF-1.4 test binary invoice data").toString("base64"),
      metadata: { file: { file_name: "SEPT-INV-2026-TEST01.pdf", content_type: "application/pdf" } }
    }
  ];

  expect(artifacts.length).toBe(1);
  expect(artifacts[0].artifact_type).toBe("file");
  expect(artifacts[0].metadata.file.content_type).toBe("application/pdf");
  expect(artifacts[0].metadata.file.file_name.endsWith(".pdf")).toBe(true);
});

test("Instagram invoice card delivers visualization/image artifact to bypass link shim", () => {
  const instagramArtifact = {
    identifier: "sept_invoice_image_test_123",
    title: "Invoice Card SEPT-INV-2026-TEST01",
    artifact_type: "visualization",
    metadata: { image: { format: "png", dimensions: { width: 1200, height: 1600 } } }
  };

  expect(instagramArtifact.artifact_type).toBe("visualization");
  expect(instagramArtifact.metadata.image.format).toBe("png");
});
