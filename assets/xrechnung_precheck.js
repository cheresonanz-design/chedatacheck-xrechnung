/**
 * CheDataCheck (by VeriTakt Collective) — P4/B4 Client-Side Pre-Check Engine
 * Deterministic, zero-dependency EN 16931 / XRechnung 3.0 / ZUGFeRD 2.3 pre-flight validator.
 * Runs 100% locally in browser or Node.js (zero server uploads, DSGVO/GDPR-safe).
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CheXRechnungPrecheck = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SUPPORTED_TYPE_CODES = new Set(["380", "381", "384", "386", "389", "326", "751"]);

  function decodeEntities(str) {
    return String(str || "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim();
  }

  function findFirstBlock(xml, localNames) {
    for (const name of localNames) {
      const re = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9_-]+:)?${name}>`, "i");
      const m = xml.match(re);
      if (m) return m[1];
    }
    return "";
  }

  function findFirstText(xml, localNames) {
    for (const name of localNames) {
      const re = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${name}\\b[^>]*>([^<]*)</(?:[a-zA-Z0-9_-]+:)?${name}>`, "i");
      const m = xml.match(re);
      if (m && m[1].trim()) return decodeEntities(m[1]);
    }
    return "";
  }

  function countBlocks(xml, localName) {
    const re = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${localName}\\b[^>]*>`, "gi");
    const matches = xml.match(re);
    return matches ? matches.length : 0;
  }

  function checkWellFormedBasic(xml) {
    if (!xml || typeof xml !== "string" || !xml.trim().startsWith("<")) {
      return { ok: false, reason: "Input does not start with an XML root element (<...)." };
    }
    const clean = xml
      .replace(/<\?[\s\S]*?\?>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
    const tagRe = /<\/?([a-zA-Z_][\w:.-]*)(?:\s[^<>]*)?(\/?)>/g;
    const stack = [];
    let match;
    while ((match = tagRe.exec(clean)) !== null) {
      const full = match[0];
      const tag = match[1];
      const selfClosing = match[2] === "/";
      if (full.startsWith("</")) {
        const expected = stack.pop();
        if (expected !== tag) {
          return { ok: false, reason: `Mismatched XML closing tag </${tag}> (expected </${expected || "none"}>).` };
        }
      } else if (!selfClosing) {
        stack.push(tag);
      }
    }
    if (stack.length > 0) {
      return { ok: false, reason: `Unclosed XML element <${stack[stack.length - 1]}>.` };
    }
    return { ok: true, reason: "" };
  }

  function detectFormat(xml) {
    if (/<(?:[a-zA-Z0-9_-]+:)?CrossIndustryInvoice\b/i.test(xml)) return "CII";
    if (/<(?:[a-zA-Z0-9_-]+:)?(?:Invoice|CreditNote)\b/i.test(xml)) return "UBL";
    return "UNKNOWN";
  }

  function parseNumber(val) {
    if (!val) return NaN;
    const n = Number(String(val).replace(",", ".").trim());
    return Number.isFinite(n) ? n : NaN;
  }

  function validateIbanMod97(rawIban) {
    const clean = String(rawIban || "").replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(clean)) {
      return { valid: false, iban: clean, reason: "Invalid IBAN character/length structure." };
    }
    const rearranged = clean.slice(4) + clean.slice(0, 4);
    let remainder = 0;
    for (let i = 0; i < rearranged.length; i++) {
      const ch = rearranged[i];
      const expanded = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
      for (let j = 0; j < expanded.length; j++) {
        remainder = (remainder * 10 + Number(expanded[j])) % 97;
      }
    }
    return {
      valid: remainder === 1,
      iban: clean,
      reason: remainder === 1 ? "Valid ISO-13616 Mod-97 IBAN checksum." : "Failed ISO-13616 Mod-97 IBAN checksum.",
    };
  }

  function validateVatOrTaxId(rawId) {
    const clean = String(rawId || "").replace(/\s+/g, "").toUpperCase();
    if (!clean) return { status: "FAIL", reason: "Missing VAT ID (BT-31) or tax ID (BT-32)." };
    if (/^DE\d{9}$/.test(clean)) {
      return { status: "PASS", reason: `Valid German USt-IdNr format '${clean}'.` };
    }
    if (/^[A-Z]{2}[A-Z0-9]{2,14}$/.test(clean)) {
      return { status: "PASS", reason: `Valid EU VAT identifier format '${clean}'.` };
    }
    if (/^[\d\/-]{7,16}$/.test(clean)) {
      return {
        status: "PASS",
        reason: `Local tax number '${clean}' detected (Kleinunternehmer § 19 UStG / BT-32 compatible).`,
      };
    }
    return {
      status: "WARN",
      reason: `Uncommon tax/VAT format '${clean}' (expected e.g. DE123456789 or Steuernummer).`,
    };
  }

  function validateXmlInvoice(xml) {
    const checks = [];
    const addCheck = (id, field, status, message, value = "") => {
      checks.push({ id, field, status, message, value });
    };

    const wf = checkWellFormedBasic(xml);
    if (!wf.ok) {
      addCheck("XML-01", "XML Well-Formedness", "FAIL", wf.reason);
      return {
        valid: false,
        standard: "UNKNOWN",
        profile: "",
        score_percent: 0,
        checks,
        summary: { pass: 0, warn: 0, fail: 1 },
        totals: {},
        parties: {},
      };
    }
    addCheck("XML-01", "XML Well-Formedness", "PASS", "XML tags are structurally balanced.");

    const format = detectFormat(xml);
    if (format === "UNKNOWN") {
      addCheck("XML-02", "E-Invoice Root Schema", "FAIL", "Neither UBL 2.1 (<Invoice>/<CreditNote>) nor UN/CEFACT CII (<CrossIndustryInvoice>) root element found.");
      return {
        valid: false,
        standard: "UNKNOWN",
        profile: "",
        score_percent: 10,
        checks,
        summary: { pass: 1, warn: 0, fail: 1 },
        totals: {},
        parties: {},
      };
    }
    addCheck("XML-02", "E-Invoice Root Schema", "PASS", `Detected ${format === "UBL" ? "UBL 2.1" : "UN/CEFACT CII"} root element.`, format);

    let specId = "";
    let invoiceId = "";
    let issueDate = "";
    let dueDate = "";
    let paymentTerms = "";
    let typeCode = "";
    let currency = "";
    let buyerRef = "";
    let sellerBlock = "";
    let buyerBlock = "";
    let sellerName = "";
    let sellerVatOrTax = "";
    let buyerName = "";
    let netAmount = NaN;
    let taxAmount = NaN;
    let grossAmount = NaN;
    let payableAmount = NaN;
    let taxCategoryCode = "";
    let iban = "";
    let lineCount = 0;

    if (format === "UBL") {
      specId = findFirstText(xml, ["CustomizationID"]);
      invoiceId = findFirstText(xml, ["ID"]);
      issueDate = findFirstText(xml, ["IssueDate"]);
      dueDate = findFirstText(xml, ["DueDate"]);
      paymentTerms = findFirstText(findFirstBlock(xml, ["PaymentTerms"]), ["Note"]);
      typeCode = findFirstText(xml, ["InvoiceTypeCode", "CreditNoteTypeCode"]);
      currency = findFirstText(xml, ["DocumentCurrencyCode"]);
      buyerRef = findFirstText(xml, ["BuyerReference"]);
      sellerBlock = findFirstBlock(xml, ["AccountingSupplierParty"]);
      buyerBlock = findFirstBlock(xml, ["AccountingCustomerParty"]);
      sellerName = findFirstText(sellerBlock, ["RegistrationName", "Name"]);
      sellerVatOrTax = findFirstText(sellerBlock, ["CompanyID"]);
      buyerName = findFirstText(buyerBlock, ["RegistrationName", "Name"]);
      const paymentBlock = findFirstBlock(xml, ["PaymentMeans"]);
      const payeeAcct = findFirstBlock(paymentBlock, ["PayeeFinancialAccount"]);
      iban = findFirstText(payeeAcct, ["ID"]);
      const taxTotalBlock = findFirstBlock(xml, ["TaxTotal"]);
      taxAmount = parseNumber(findFirstText(taxTotalBlock, ["TaxAmount"]));
      const taxCatBlock = findFirstBlock(taxTotalBlock || xml, ["TaxCategory", "ClassifiedTaxCategory"]);
      taxCategoryCode = findFirstText(taxCatBlock, ["ID"]).toUpperCase();
      const monetaryBlock = findFirstBlock(xml, ["LegalMonetaryTotal"]);
      netAmount = parseNumber(findFirstText(monetaryBlock, ["TaxExclusiveAmount"]));
      grossAmount = parseNumber(findFirstText(monetaryBlock, ["TaxInclusiveAmount"]));
      payableAmount = parseNumber(findFirstText(monetaryBlock, ["PayableAmount"]));
      lineCount = countBlocks(xml, "InvoiceLine") + countBlocks(xml, "CreditNoteLine");
    } else {
      const ctxBlock = findFirstBlock(xml, ["ExchangedDocumentContext"]);
      specId = findFirstText(ctxBlock, ["ID"]) || findFirstText(xml, ["ID"]);
      const docBlock = findFirstBlock(xml, ["ExchangedDocument"]);
      invoiceId = findFirstText(docBlock, ["ID"]);
      issueDate = findFirstText(docBlock, ["DateTimeString"]);
      typeCode = findFirstText(docBlock, ["TypeCode"]);
      const settlementBlock = findFirstBlock(xml, ["ApplicableHeaderTradeSettlement"]);
      currency = findFirstText(settlementBlock, ["InvoiceCurrencyCode"]);
      const payTermsBlock = findFirstBlock(settlementBlock, ["SpecifiedTradePaymentTerms"]);
      dueDate = findFirstText(payTermsBlock, ["DateTimeString"]);
      paymentTerms = findFirstText(payTermsBlock, ["Description"]);
      const payMeansBlock = findFirstBlock(settlementBlock, ["SpecifiedTradeSettlementPaymentMeans"]);
      const creditorAcct = findFirstBlock(payMeansBlock, ["PayeePartyCreditorFinancialAccount"]);
      iban = findFirstText(creditorAcct, ["IBANID"]);
      const agreementBlock = findFirstBlock(xml, ["ApplicableHeaderTradeAgreement"]);
      buyerRef = findFirstText(agreementBlock, ["BuyerReference"]);
      sellerBlock = findFirstBlock(agreementBlock, ["SellerTradeParty"]);
      buyerBlock = findFirstBlock(agreementBlock, ["BuyerTradeParty"]);
      sellerName = findFirstText(sellerBlock, ["Name"]);
      sellerVatOrTax = findFirstText(sellerBlock, ["ID"]);
      buyerName = findFirstText(buyerBlock, ["Name"]);
      const tradeTaxBlock = findFirstBlock(settlementBlock, ["ApplicableTradeTax"]);
      taxCategoryCode = findFirstText(tradeTaxBlock, ["CategoryCode"]).toUpperCase();
      const sumBlock = findFirstBlock(settlementBlock, ["SpecifiedTradeSettlementHeaderMonetarySummation"]);
      netAmount = parseNumber(findFirstText(sumBlock, ["TaxBasisTotalAmount"]));
      taxAmount = parseNumber(findFirstText(sumBlock, ["TaxTotalAmount"]));
      grossAmount = parseNumber(findFirstText(sumBlock, ["GrandTotalAmount"]));
      payableAmount = parseNumber(findFirstText(sumBlock, ["DuePayableAmount"]));
      lineCount = countBlocks(xml, "IncludedSupplyChainTradeLineItem");
    }

    // BT-24 Specification Identifier
    const isEn16931 = /en16931|xrechnung|zugferd|factur-x/i.test(specId);
    if (!specId) {
      addCheck("BT-24", "Specification ID (Profile)", "FAIL", "Missing CustomizationID / GuidelineSpecifiedDocumentContextParameter.");
    } else if (!isEn16931) {
      addCheck("BT-24", "Specification ID (Profile)", "WARN", `Unrecognized profile identifier: ${specId}`, specId);
    } else {
      addCheck("BT-24", "Specification ID (Profile)", "PASS", "Valid EN 16931 / XRechnung / ZUGFeRD profile URI detected.", specId);
    }

    // BT-1 Invoice Number
    if (invoiceId) {
      addCheck("BT-1", "Invoice Number", "PASS", "Invoice number present.", invoiceId);
    } else {
      addCheck("BT-1", "Invoice Number", "FAIL", "Missing mandatory invoice number (BT-1).");
    }

    // BT-2 Issue Date
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(issueDate) || /^\d{8}$/.test(issueDate);
    if (!issueDate) {
      addCheck("BT-2", "Issue Date", "FAIL", "Missing mandatory issue date (BT-2).");
    } else if (!validDate) {
      addCheck("BT-2", "Issue Date", "WARN", `Date '${issueDate}' is not standard YYYY-MM-DD or YYYYMMDD.`, issueDate);
    } else {
      addCheck("BT-2", "Issue Date", "PASS", "Issue date format is valid.", issueDate);
    }

    // BT-3 Type Code
    if (!typeCode) {
      addCheck("BT-3", "Invoice Type Code", "FAIL", "Missing Invoice Type Code (e.g. 380 for commercial invoice).");
    } else if (!SUPPORTED_TYPE_CODES.has(typeCode)) {
      addCheck("BT-3", "Invoice Type Code", "WARN", `Type code '${typeCode}' is uncommon under EN 16931.`, typeCode);
    } else {
      addCheck("BT-3", "Invoice Type Code", "PASS", `Supported UNTDID 1001 type code '${typeCode}'.`, typeCode);
    }

    // BT-5 Currency
    if (/^[A-Z]{3}$/.test(currency)) {
      addCheck("BT-5", "Currency Code", "PASS", `ISO-4217 currency code '${currency}'.`, currency);
    } else {
      addCheck("BT-5", "Currency Code", "FAIL", "Missing or invalid 3-letter ISO-4217 currency code (BT-5).");
    }

    // BT-10 Buyer Reference / Leitweg-ID
    if (buyerRef) {
      addCheck("BT-10", "Buyer Reference / Leitweg-ID", "PASS", "BuyerReference present (required for XRechnung).", buyerRef);
    } else {
      addCheck("BT-10", "Buyer Reference / Leitweg-ID", "WARN", "BuyerReference (BT-10 / Leitweg-ID) is missing; mandatory in XRechnung public/B2G & recommended in B2B.");
    }

    // BG-4 Seller
    if (sellerName && sellerVatOrTax) {
      addCheck("BG-4", "Seller Identity", "PASS", `Seller '${sellerName}' present with tax/VAT ID '${sellerVatOrTax}'.`, sellerName);
    } else if (sellerName) {
      addCheck("BG-4", "Seller Identity", "FAIL", `Seller '${sellerName}' is missing VAT ID (BT-31) or local tax ID (BT-32) per § 14 UStG.`);
    } else {
      addCheck("BG-4", "Seller Identity", "FAIL", "Missing Seller party name and tax/VAT identifier (BG-4).");
    }

    // BT-31/32 VAT / Tax ID Syntax
    const vatRes = validateVatOrTaxId(sellerVatOrTax);
    addCheck("BT-31/32", "VAT / Tax ID Syntax", vatRes.status, vatRes.reason, sellerVatOrTax);

    // BG-7 Buyer
    if (buyerName) {
      addCheck("BG-7", "Buyer Identity", "PASS", `Buyer '${buyerName}' present.`, buyerName);
    } else {
      addCheck("BG-7", "Buyer Identity", "FAIL", "Missing Buyer party name (BG-7).");
    }

    // BG-22 Monetary Totals & Math Sanity
    if (Number.isFinite(netAmount) && Number.isFinite(grossAmount) && Number.isFinite(payableAmount)) {
      if (grossAmount + 0.001 < netAmount) {
        addCheck("BG-22", "Monetary Totals", "FAIL", `TaxInclusiveAmount (${grossAmount}) is smaller than TaxExclusiveAmount (${netAmount}).`);
      } else {
        addCheck("BG-22", "Monetary Totals", "PASS", `Net ${netAmount.toFixed(2)}, Gross ${grossAmount.toFixed(2)}, Payable ${payableAmount.toFixed(2)} ${currency || ""}.`.trim());
      }
    } else {
      addCheck("BG-22", "Monetary Totals", "FAIL", "Missing one or more mandatory monetary totals (Net, Gross, Payable).");
    }

    // BG-22-MATH Tax & Payable Sanity
    if (Number.isFinite(netAmount) && Number.isFinite(grossAmount) && Number.isFinite(payableAmount)) {
      if (payableAmount < 0) {
        addCheck("BG-22-MATH", "Tax & Payable Math Consistency", "FAIL", `PayableAmount (${payableAmount.toFixed(2)}) must not be negative for standard invoices.`);
      } else if (taxCategoryCode === "AE" && Number.isFinite(taxAmount) && Math.abs(taxAmount) > 0.001) {
        addCheck(
          "BG-22-MATH",
          "Tax & Payable Math Consistency",
          "FAIL",
          `Reverse Charge (§ 13b UStG / CategoryCode AE) requires TaxAmount = 0.00, got ${taxAmount.toFixed(2)}.`
        );
      } else if (Number.isFinite(taxAmount)) {
        const expectedGross = netAmount + taxAmount;
        if (Math.abs(expectedGross - grossAmount) > 0.02) {
          addCheck(
            "BG-22-MATH",
            "Tax & Payable Math Consistency",
            "FAIL",
            `Net (${netAmount.toFixed(2)}) + Tax (${taxAmount.toFixed(2)}) = ${expectedGross.toFixed(2)} does not match Gross (${grossAmount.toFixed(2)}).`
          );
        } else {
          const rcNote = taxCategoryCode === "AE" ? " (Reverse Charge § 13b UStG, AE)" : "";
          addCheck("BG-22-MATH", "Tax & Payable Math Consistency", "PASS", `Net + Tax (${taxAmount.toFixed(2)}) matches Gross (${grossAmount.toFixed(2)})${rcNote}.`);
        }
      } else {
        addCheck("BG-22-MATH", "Tax & Payable Math Consistency", "PASS", "Monetary totals non-negative and Gross >= Net.");
      }
    } else {
      addCheck("BG-22-MATH", "Tax & Payable Math Consistency", "FAIL", "Cannot verify Net/Tax/Gross math because header totals are missing.");
    }

    // BG-16 Payment Means / IBAN
    if (iban) {
      const ibanRes = validateIbanMod97(iban);
      addCheck("BG-16", "Payment Means / IBAN (Mod-97)", ibanRes.valid ? "PASS" : "FAIL", ibanRes.reason, ibanRes.iban);
    } else {
      addCheck("BG-16", "Payment Means / IBAN (Mod-97)", "WARN", "No payee IBAN (BG-16) found; recommended for touchless SEPA AP payment.");
    }

    // BT-9/20 Due Date or Payment Terms
    if (dueDate || paymentTerms) {
      const info = [dueDate ? `Due ${dueDate}` : "", paymentTerms ? `Terms: ${paymentTerms}` : ""].filter(Boolean).join(" · ");
      addCheck("BT-9/20", "Due Date / Payment Terms", "PASS", `Payment timing present (${info}).`, dueDate || paymentTerms);
    } else {
      addCheck("BT-9/20", "Due Date / Payment Terms", "WARN", "Neither DueDate (BT-9) nor PaymentTerms (BT-20) specified.");
    }

    // BG-25 Invoice Lines
    if (lineCount >= 1) {
      addCheck("BG-25", "Invoice Line Items", "PASS", `Found ${lineCount} invoice line item(s).`, String(lineCount));
    } else {
      addCheck("BG-25", "Invoice Line Items", "FAIL", "At least 1 invoice line item (BG-25) is required.");
    }

    const summary = {
      pass: checks.filter((c) => c.status === "PASS").length,
      warn: checks.filter((c) => c.status === "WARN").length,
      fail: checks.filter((c) => c.status === "FAIL").length,
    };
    const score = Math.round((summary.pass / checks.length) * 100);

    return {
      valid: summary.fail === 0,
      standard: format,
      profile: specId,
      score_percent: score,
      checks,
      summary,
      totals: {
        currency,
        net_amount: Number.isFinite(netAmount) ? netAmount : null,
        tax_amount: Number.isFinite(taxAmount) ? taxAmount : null,
        gross_amount: Number.isFinite(grossAmount) ? grossAmount : null,
        payable_amount: Number.isFinite(payableAmount) ? payableAmount : null,
        line_count: lineCount,
        tax_category: taxCategoryCode || "",
        reverse_charge: taxCategoryCode === "AE",
      },
      parties: {
        invoice_id: invoiceId,
        issue_date: issueDate,
        due_date: dueDate,
        buyer_reference: buyerRef,
        seller_name: sellerName,
        seller_tax_id: sellerVatOrTax,
        buyer_name: buyerName,
        iban,
      },
    };
  }

  function extractXmlFromString(text) {
    if (!text) return "";
    const patterns = [
      /<(?:[a-zA-Z0-9_-]+:)?CrossIndustryInvoice\b[\s\S]*?<\/(?:[a-zA-Z0-9_-]+:)?CrossIndustryInvoice>/i,
      /<(?:[a-zA-Z0-9_-]+:)?Invoice\b[\s\S]*?<\/(?:[a-zA-Z0-9_-]+:)?Invoice>/i,
      /<(?:[a-zA-Z0-9_-]+:)?CreditNote\b[\s\S]*?<\/(?:[a-zA-Z0-9_-]+:)?CreditNote>/i,
    ];
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m) return m[0];
    }
    return "";
  }

  function bytesToLatin1(uint8Array) {
    const bytes = uint8Array instanceof Uint8Array ? uint8Array : new Uint8Array(uint8Array);
    let out = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return out;
  }

  function latin1ToUtf8(latin1Str) {
    const bytes = new Uint8Array(latin1Str.length);
    for (let i = 0; i < latin1Str.length; i++) {
      bytes[i] = latin1Str.charCodeAt(i) & 0xff;
    }
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    if (typeof Buffer !== "undefined") {
      return Buffer.from(bytes).toString("utf-8");
    }
    return latin1Str;
  }

  /**
   * Synchronous scan for uncompressed embedded ZUGFeRD / Factur-X XML inside PDF bytes.
   */
  function extractXmlFromPdfBytes(uint8Array) {
    const latin1 = bytesToLatin1(uint8Array);
    const hit = extractXmlFromString(latin1);
    if (!hit) return "";
    return latin1ToUtf8(hit);
  }

  async function inflateChunk(chunkBytes) {
    if (typeof DecompressionStream !== "undefined") {
      for (const fmt of ["deflate", "deflate-raw"]) {
        try {
          const ds = new DecompressionStream(fmt);
          const writer = ds.writable.getWriter();
          writer.write(chunkBytes);
          writer.close();
          const buf = await new Response(ds.readable).arrayBuffer();
          return new Uint8Array(buf);
        } catch (_) {
          // Try next format
        }
      }
      return null;
    }
    if (typeof require === "function") {
      try {
        const zlib = require("zlib");
        try {
          return new Uint8Array(zlib.inflateSync(chunkBytes));
        } catch (_) {
          return new Uint8Array(zlib.inflateRawSync(chunkBytes));
        }
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  /**
   * Async extractor supporting both uncompressed and FlateDecode-compressed ZUGFeRD/Factur-X PDF streams.
   */
  async function extractXmlFromPdfBuffer(arrayBuffer) {
    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const direct = extractXmlFromPdfBytes(bytes);
    if (direct) return direct;

    const latin1 = bytesToLatin1(bytes);
    const streamRe = /stream(?:\r\n|\n|\r)([\s\S]*?)endstream/g;
    let m;
    while ((m = streamRe.exec(latin1)) !== null) {
      let body = m[1];
      if (body.endsWith("\r\n")) body = body.slice(0, -2);
      else if (body.endsWith("\n") || body.endsWith("\r")) body = body.slice(0, -1);
      if (!body.length) continue;

      const chunk = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i++) {
        chunk[i] = body.charCodeAt(i) & 0xff;
      }
      const inflated = await inflateChunk(chunk);
      if (!inflated || !inflated.length) continue;

      const text = typeof TextDecoder !== "undefined"
        ? new TextDecoder("utf-8", { fatal: false }).decode(inflated)
        : Buffer.from(inflated).toString("utf-8");
      const xml = extractXmlFromString(text);
      if (xml) return xml;
    }
    return "";
  }

  function formatAuditReportJson(result, filename = "invoice.xml") {
    return JSON.stringify(
      {
        tool: "CheDataCheck XRechnung & ZUGFeRD Pre-Check",
        provider: "CheDataCheck by VeriTakt Collective",
        filename,
        checked_at: new Date().toISOString(),
        valid: result.valid,
        standard: result.standard,
        profile: result.profile,
        score_percent: result.score_percent,
        summary: result.summary,
        totals: result.totals,
        parties: result.parties,
        checks: result.checks,
      },
      null,
      2
    );
  }

  function formatAuditReportMarkdown(result, filename = "invoice.xml") {
    const statusLabel = result.valid ? "PASS (Vorabpruefung bestanden)" : "FAIL (Fehler gefunden)";
    const t = result.totals || {};
    const p = result.parties || {};
    const cur = t.currency || "EUR";
    const lines = [
      `# CheDataCheck E-Rechnung Audit-Protokoll`,
      ``,
      `- **Datei:** \`${filename}\``,
      `- **Ergebnis:** **${statusLabel}** (${result.score_percent} % · PASS ${result.summary.pass} / WARN ${result.summary.warn} / FAIL ${result.summary.fail})`,
      `- **Standard / Profil:** ${result.standard || "UNKNOWN"}${result.profile ? ` — \`${result.profile}\`` : ""}`,
      `- **Rechnungsnummer / Datum:** ${p.invoice_id || "-"} · ${p.issue_date || "-"}`,
      `- **Aussteller / Empfaenger:** ${p.seller_name || "-"} (${p.seller_tax_id || "-"}) -> ${p.buyer_name || "-"}`,
      `- **Betraege (${cur}):** Netto ${t.net_amount !== null && t.net_amount !== undefined ? t.net_amount.toFixed(2) : "-"} · MwSt ${t.tax_amount !== null && t.tax_amount !== undefined ? t.tax_amount.toFixed(2) : "-"} · Brutto ${t.gross_amount !== null && t.gross_amount !== undefined ? t.gross_amount.toFixed(2) : "-"} · Positionen: ${t.line_count ?? 0}`,
      ``,
      `## EN 16931 / GoBD Pruefpunkte`,
      ``,
      `| ID | Prueffeld | Status | Befund |`,
      `| :--- | :--- | :--- | :--- |`,
    ];
    for (const c of result.checks || []) {
      const msg = String(c.message || "").replace(/\|/g, "/");
      lines.push(`| ${c.id} | ${c.field} | **${c.status}** | ${msg} |`);
    }
    lines.push(``);
    lines.push(`*Geprueft 100 % lokal im Browser ohne Server-Upload via CheDataCheck (by VeriTakt Collective).*`);
    return lines.join("\n");
  }

  const SAMPLES = {
    valid_xrechnung_ubl: `<?xml version="1.0" encoding="UTF-8"?>
<ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
             xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
             xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ID>RE-2026-0419</cbc:ID>
  <cbc:IssueDate>2026-11-23</cbc:IssueDate>
  <cbc:DueDate>2026-12-07</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>991-12345-67</cbc:BuyerReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>DE123456789</cbc:CompanyID>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>HanseOps Beratung GmbH</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Weserbau Mittelstand AG</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cac:PaymentMeansCode>58</cac:PaymentMeansCode>
    <cac:PayeeFinancialAccount>
      <cbc:ID>DE89370400440532013000</cbc:ID>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:PaymentTerms>
    <cbc:Note>14 Tage netto ohne Abzug</cbc:Note>
  </cac:PaymentTerms>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">380.00</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="EUR">2000.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">2380.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">2380.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
  </cac:InvoiceLine>
</ubl:Invoice>`,

    valid_zugferd_cii: `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
                          xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
                          xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>ZF-2026-209</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">20261123</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>PO-8891</ram:BuyerReference>
      <ram:SellerTradeParty>
        <ram:Name>Nordic Audit GmbH</ram:Name>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE987654321</ram:ID></ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>Elbwerk KMU GmbH</ram:Name>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <rsm:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:PayeePartyCreditorFinancialAccount>
          <ram:IBANID>DE89370400440532013000</ram:IBANID>
        </ram:PayeePartyCreditorFinancialAccount>
      </ram:SpecifiedTradeSettlementPaymentMeans>
      <ram:SpecifiedTradePaymentTerms>
        <ram:Description>Zahlbar innerhalb 30 Tage</ram:Description>
        <ram:DueDateDateTime><udt:DateTimeString format="102">20261223</udt:DateTimeString></ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:TaxBasisTotalAmount>1000.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount>190.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>1190.00</ram:GrandTotalAmount>
        <ram:DuePayableAmount>1190.00</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </rsm:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`,

    invalid_ubl: `<?xml version="1.0" encoding="UTF-8"?>
<ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
             xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
             xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
  <cbc:ID>ERR-2026-99</cbc:ID>
  <cbc:IssueDate>23.11.2026</cbc:IssueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EURO</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Unvollstaendig UG</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:PaymentMeans>
    <cac:PayeeFinancialAccount>
      <cbc:ID>DE00370400440532013000</cbc:ID>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">190.00</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="EUR">1000.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">1150.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">1150.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
</ubl:Invoice>`,

    valid_kleinunternehmer_ubl: `<?xml version="1.0" encoding="UTF-8"?>
<ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
             xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
             xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ID>RE-KU-2026-0118</cbc:ID>
  <cbc:IssueDate>2026-11-24</cbc:IssueDate>
  <cbc:DueDate>2026-12-08</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:Note>Kein Ausweis von Umsatzsteuer gemäß § 19 UStG (Kleinunternehmerregelung).</cbc:Note>
  <cbc:BuyerReference>991-00450-12</cbc:BuyerReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>60/123/45678</cbc:CompanyID>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Bremer IT-Studio Kleinunternehmer</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Kuestenwerk Mittelstand GmbH</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cac:PaymentMeansCode>58</cac:PaymentMeansCode>
    <cac:PayeeFinancialAccount>
      <cbc:ID>DE89370400440532013000</cbc:ID>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:PaymentTerms>
    <cbc:Note>14 Tage netto (§ 19 UStG)</cbc:Note>
  </cac:PaymentTerms>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">0.00</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="EUR">490.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">490.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">490.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
  </cac:InvoiceLine>
</ubl:Invoice>`,

    valid_credit_note_ubl: `<?xml version="1.0" encoding="UTF-8"?>
<ubl:CreditNote xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
                xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
                xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ID>GS-2026-0014</cbc:ID>
  <cbc:IssueDate>2026-11-24</cbc:IssueDate>
  <cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:Note>Vollstorno / Gutschrift zu Rechnung RE-2026-0042.</cbc:Note>
  <cbc:BuyerReference>991-12345-67</cbc:BuyerReference>
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>RE-2026-0042</cbc:ID>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>DE123456789</cbc:CompanyID>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>HanseOps Beratung GmbH</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Mittelstand Nord AG</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cac:PaymentMeansCode>58</cac:PaymentMeansCode>
    <cac:PayeeFinancialAccount>
      <cbc:ID>DE89370400440532013000</cbc:ID>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:PaymentTerms>
    <cbc:Note>Verrechnung / Gutschrift innerhalb 14 Tagen</cbc:Note>
  </cac:PaymentTerms>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">95.00</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="EUR">500.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">595.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">595.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:CreditNoteLine>
    <cbc:ID>1</cbc:ID>
  </cac:CreditNoteLine>
</ubl:CreditNote>`,

    valid_reverse_charge_cii: `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
                          xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
                          xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>RC-2026-0089</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">20261125</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>EU-B2B-2026-41</ram:BuyerReference>
      <ram:SellerTradeParty>
        <ram:Name>Alpine Tech Ops GmbH</ram:Name>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">ATU12345678</ram:ID></ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>Weserwerk Digital GmbH</ram:Name>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <rsm:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:PayeePartyCreditorFinancialAccount>
          <ram:IBANID>DE89370400440532013000</ram:IBANID>
        </ram:PayeePartyCreditorFinancialAccount>
      </ram:SpecifiedTradeSettlementPaymentMeans>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>0.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:ExemptionReason>Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG / Reverse Charge)</ram:ExemptionReason>
        <ram:BasisAmount>1800.00</ram:BasisAmount>
        <ram:CategoryCode>AE</ram:CategoryCode>
        <ram:RateApplicablePercent>0.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradePaymentTerms>
        <ram:Description>14 Tage netto (Reverse Charge § 13b UStG)</ram:Description>
        <ram:DueDateDateTime><udt:DateTimeString format="102">20261209</udt:DateTimeString></ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:TaxBasisTotalAmount>1800.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount>0.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>1800.00</ram:GrandTotalAmount>
        <ram:DuePayableAmount>1800.00</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </rsm:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`,
  };

  return {
    validateXmlInvoice,
    validateIbanMod97,
    validateVatOrTaxId,
    checkWellFormedBasic,
    detectFormat,
    extractXmlFromPdfBytes,
    extractXmlFromPdfBuffer,
    formatAuditReportJson,
    formatAuditReportMarkdown,
    SAMPLES,
  };
});
