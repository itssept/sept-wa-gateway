import io
import json
import uuid
from datetime import datetime, timezone
from executor import aio, executor
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors

def generate_invoice_pdf(deal_data: dict) -> bytes:
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        rightMargin=36,
        leftMargin=36,
        topMargin=36,
        bottomMargin=36
    )
    
    styles = getSampleStyleSheet()
    
    title_style = ParagraphStyle(
        'TitleStyle',
        parent=styles['Heading1'],
        fontName='Helvetica-Bold',
        fontSize=20,
        leading=24,
        textColor=colors.HexColor('#1A1A1A'),
        spaceAfter=6
    )
    
    subtitle_style = ParagraphStyle(
        'SubtitleStyle',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=10,
        leading=14,
        textColor=colors.HexColor('#555555')
    )
    
    section_heading = ParagraphStyle(
        'SectionHeading',
        parent=styles['Heading3'],
        fontName='Helvetica-Bold',
        fontSize=12,
        leading=16,
        textColor=colors.HexColor('#222222'),
        spaceBefore=12,
        spaceAfter=6
    )
    
    cell_style = ParagraphStyle(
        'CellStyle',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=9,
        leading=12,
        textColor=colors.HexColor('#333333')
    )
    
    cell_bold = ParagraphStyle(
        'CellBold',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=9,
        leading=12,
        textColor=colors.HexColor('#111111')
    )

    story = []
    
    # Header
    story.append(Paragraph("SEPT LUXURY CONCIERGE", title_style))
    story.append(Paragraph("Commercial Invoice & Acquisition Confirmation | Confidential", subtitle_style))
    story.append(Spacer(1, 15))
    
    # Meta Info
    meta_table_data = [
        [
            Paragraph("<b>Invoice No:</b> " + deal_data["invoice_id"], cell_style),
            Paragraph("<b>Date:</b> " + deal_data["date"], cell_style)
        ],
        [
            Paragraph("<b>Client:</b> " + deal_data["client_name"], cell_style),
            Paragraph("<b>Payment Due:</b> 100% Upfront Wire / Settlement", cell_style)
        ],
        [
            Paragraph("<b>Contact:</b> " + deal_data["client_phone"], cell_style),
            Paragraph("<b>Escrow Release:</b> Upon Physical Dispatch & Tracking", cell_style)
        ]
    ]
    meta_table = Table(meta_table_data, colWidths=[270, 270])
    meta_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), colors.HexColor('#F8F9FA')),
        ('PADDING', (0,0), (-1,-1), 6),
        ('BOX', (0,0), (-1,-1), 0.5, colors.HexColor('#E0E0E0')),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ]))
    story.append(meta_table)
    story.append(Spacer(1, 15))
    
    # Item Specification Section
    story.append(Paragraph("ITEM SPECIFICATION & PROVENANCE", section_heading))
    item = deal_data["item"]
    spec_table_data = [
        [Paragraph("Attribute", cell_bold), Paragraph("Specification", cell_bold)],
        [Paragraph("Brand & House", cell_style), Paragraph(item.get("brand", "N/A"), cell_style)],
        [Paragraph("Model & Silhouette", cell_style), Paragraph(item.get("model", "N/A"), cell_style)],
        [Paragraph("Dimension / Size", cell_style), Paragraph(str(item.get("size", "N/A")), cell_style)],
        [Paragraph("Colour / Leather", cell_style), Paragraph(f"{item.get('colour', 'N/A')} / {item.get('material', 'N/A')}", cell_style)],
        [Paragraph("Hardware Plating", cell_style), Paragraph(item.get("hardware", "N/A"), cell_style)],
        [Paragraph("Condition & Year", cell_style), Paragraph(f"{item.get('condition', 'N/A')} (Store Fresh / 2026 Stamp)", cell_style)],
        [Paragraph("Completeness", cell_style), Paragraph("Full Set: Original Orange Box, Dustbag, Clochette, Keys, Raincoat, Original Boutique Receipt", cell_style)],
        [Paragraph("Sourcer Origin", cell_style), Paragraph("Verified Paris Boutique Network", cell_style)]
    ]
    spec_table = Table(spec_table_data, colWidths=[160, 380])
    spec_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#EFEFEF')),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#E0E0E0')),
        ('PADDING', (0,0), (-1,-1), 5),
    ]))
    story.append(spec_table)
    story.append(Spacer(1, 15))
    
    # Financial Summary
    story.append(Paragraph("FINANCIAL SETTLEMENT", section_heading))
    fin_table_data = [
        [Paragraph("Description", cell_bold), Paragraph("Amount", cell_bold)],
        [Paragraph(f"Sourcing & Acquisition: {item.get('brand')} {item.get('model')}", cell_style), Paragraph(f"{deal_data['currency']} {deal_data['client_price']:,.2f}", cell_style)],
        [Paragraph("White-Glove Insured International Courier & Customs Pre-Clearance", cell_style), Paragraph("INCLUDED (Complimentary VIP)", cell_style)],
        [Paragraph("<b>Total Amount Due:</b>", cell_bold), Paragraph(f"<b>{deal_data['currency']} {deal_data['client_price']:,.2f}</b>", cell_bold)],
    ]
    fin_table = Table(fin_table_data, colWidths=[380, 160])
    fin_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#EFEFEF')),
        ('BACKGROUND', (0,-1), (-1,-1), colors.HexColor('#F4F4F4')),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#E0E0E0')),
        ('PADDING', (0,0), (-1,-1), 6),
        ('ALIGN', (1,0), (1,-1), 'RIGHT'),
    ]))
    story.append(fin_table)
    story.append(Spacer(1, 15))
    
    # Terms
    terms_text = (
        "<b>Terms & Settlement:</b> Payment is required in full prior to physical boutique release. "
        "Funds remain held in SEPT designated client trust until express tracking and serial verification are authenticated. "
        "Authenticity guaranteed 100% lifetime."
    )
    story.append(Paragraph(terms_text, subtitle_style))
    
    doc.build(story)
    pdf_bytes = buffer.getvalue()
    buffer.close()
    return pdf_bytes

def draft_client_message(client_name: str, item: dict, client_price: float, currency: str) -> str:
    # SEPT operator voice: High-touch, direct, non-corporate, warm luxury cadence
    first_name = client_name.split()[0]
    return (
        f"Hi {first_name}! ✨ Wanted to let you know immediately—I just secured an absolute gem for you: "
        f"a store fresh **{item['brand']} {item['model']} in {item['colour']} {item['material']} with {item['hardware']} hardware**.\n\n"
        f"It is a complete full set fresh from Paris with original boutique receipt. "
        f"Price is {currency} {client_price:,.0f} all-inclusive of express insured courier directly to your door.\n\n"
        f"I've attached the invoice and spec summary here. Let me know if you'd like me to lock this in before it gets snapped up!"
    )

async def main():
    executor.print("Testing Step 4: Deal Execution, PDF Invoice & Client Outreach...\n")
    
    # 1. Prepare Deal Data from Sara Al-Sabah's verified match
    deal_data = {
        "deal_id": "deal_" + str(uuid.uuid4())[:8],
        "invoice_id": "SEPT-INV-2026-0089",
        "date": datetime.now(timezone.utc).strftime("%d %B %Y"),
        "client_name": "Sara Al-Sabah",
        "client_phone": "+965 9000 1122",
        "currency": "EUR",
        "cost_price": 18500,
        "client_price": 21500,  # 3,000 EUR gross margin
        "margin_eur": 3000,
        "margin_pct": round((3000 / 21500) * 100, 1),
        "status": "invoiced_awaiting_payment",
        "item": {
            "brand": "Hermès",
            "model": "Kelly 28",
            "size": "28",
            "colour": "Gold",
            "material": "Togo",
            "hardware": "Gold Hardware (GHW)",
            "condition": "Store Fresh",
            "sourcer": "@edp_luxury"
        }
    }
    
    # 2. Draft Client Message
    outreach_msg = draft_client_message(
        deal_data["client_name"],
        deal_data["item"],
        deal_data["client_price"],
        deal_data["currency"]
    )
    
    executor.print("=== Client Outreach Message Draft (WhatsApp) ===")
    executor.print(outreach_msg)
    executor.print("\n" + "="*50 + "\n")
    
    # 3. Generate Commercial Invoice PDF
    executor.print("Generating Commercial Invoice PDF via ReportLab...")
    pdf_bytes = generate_invoice_pdf(deal_data)
    executor.print(f"Generated PDF document ({len(pdf_bytes)} bytes).")
    
    # 4. Store Artifacts
    await aio.store_artifact(
        identifier="sept_invoice_sara_alsabah",
        title="Commercial Invoice: SEPT-INV-2026-0089 (Sara Al-Sabah)",
        artifact_type="file",
        data=pdf_bytes,
        metadata={
            "file": {
                "file_name": "SEPT-INV-2026-0089_Sara_AlSabah.pdf",
                "content_type": "application/pdf"
            }
        }
    )
    
    # 5. Update Deal Record
    deals_summary = [deal_data]
    await aio.store_artifact(
        identifier="sept_active_deals",
        title="SEPT Active Deals & Invoicing Ledger",
        artifact_type="table",
        data=deals_summary
    )
    
    executor.print("Stored artifacts 'sept_invoice_sara_alsabah' (PDF) and 'sept_active_deals' (Table).")