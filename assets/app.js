(function () {
  "use strict";

  const engine = window.CheXRechnungPrecheck;
  if (!engine) return;

  let currentLang = "de";
  let currentFilter = "ALL";
  let currentFileName = "sample_xrechnung_3_0.xml";
  let lastResult = null;

  const I18N = {
    de: {
      heroTitle: "XRechnung & ZUGFeRD Pre-Check (EN 16931 / GoBD)",
      heroSub:
        "Prüfen Sie XML-Rechnungen und hybride ZUGFeRD-/Factur-X-PDFs in Sekunden direkt in Ihrem Browser — ohne Server-Upload, 100 % DSGVO-datensparsam.",
      privacyPill: "100 % Lokal im Browser · Kein Dokumenten-Upload auf Server",
      dropTitle: "XML- oder ZUGFeRD-PDF-Datei hier ablegen oder klicken zum Auswählen",
      dropHint: "Unterstützt UBL 2.1 (XRechnung), UN/CEFACT CII (ZUGFeRD/Factur-X) sowie FlateDecode-PDFs.",
      runBtn: "Jetzt lokal prüfen",
      clearBtn: "Zurücksetzen",
      demoUbl: "Demo: Gültige XRechnung (UBL)",
      demoKu: "Demo: § 19 UStG Kleinunternehmer",
      demoCn: "Demo: Gutschrift (381 CreditNote)",
      demoRc: "Demo: § 13b Reverse Charge (AE)",
      demoEu: "Demo: EU B2B Steuerfrei (K)",
      demoCii: "Demo: Gültiges ZUGFeRD (CII)",
      demoErr: "Demo: Fehlerhafte Rechnung",
      passTitle: "Vorabprüfung bestanden — bereit für ERP / DATEV",
      failTitle: "Kritische Fehler gefunden — vor Versand/Buchung korrigieren",
      copyMd: "Markdown-Protokoll kopieren",
      copiedMd: "Protokoll kopiert!",
      dlJson: "JSON-Audit laden",
      printPdf: "Als PDF drucken",
      emptyXmlError: "Bitte fügen Sie zuerst eine XML-Rechnung ein oder wählen Sie eine Datei aus.",
      pdfNoXmlError:
        "In dieser PDF-Datei wurde keine eingebettete ZUGFeRD-/Factur-X-XML-Struktur gefunden (reines Bild-/Text-PDF ist ab 2027/2028 im B2B-Standard unzureichend).",
    },
    en: {
      heroTitle: "XRechnung & ZUGFeRD Pre-Check (EN 16931 / GoBD)",
      heroSub:
        "Validate EN 16931 XML invoices and hybrid ZUGFeRD / Factur-X PDFs instantly inside your browser — zero server uploads, GDPR-safe.",
      privacyPill: "100% Client-Side in Browser · Zero Server File Uploads",
      dropTitle: "Drop an XML or ZUGFeRD PDF invoice here, or click to browse",
      dropHint: "Supports UBL 2.1 (XRechnung), UN/CEFACT CII (ZUGFeRD/Factur-X) and FlateDecode PDF streams.",
      runBtn: "Run Local Pre-Check",
      clearBtn: "Reset",
      demoUbl: "Demo: Valid XRechnung (UBL)",
      demoKu: "Demo: § 19 UStG Small Business",
      demoCn: "Demo: Credit Note (381 UBL)",
      demoRc: "Demo: § 13b Reverse Charge (AE)",
      demoEu: "Demo: EU B2B Intra-EU (K)",
      demoCii: "Demo: Valid ZUGFeRD (CII)",
      demoErr: "Demo: Invalid Invoice",
      passTitle: "Pre-Check Passed — Ready for ERP / Accounting",
      failTitle: "Critical Failures Detected — Fix Before Submission",
      copyMd: "Copy Markdown Report",
      copiedMd: "Copied!",
      dlJson: "Download JSON Audit",
      printPdf: "Print PDF Report",
      emptyXmlError: "Please paste an XML invoice or select an XML/PDF file first.",
      pdfNoXmlError:
        "No embedded ZUGFeRD / Factur-X XML payload was found in this PDF file (plain visual PDFs do not satisfy the German B2B e-invoicing mandate).",
    },
  };

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function applyLanguage(lang) {
    currentLang = lang === "en" ? "en" : "de";
    const t = I18N[currentLang];
    if (el("langDeBtn")) el("langDeBtn").classList.toggle("active", currentLang === "de");
    if (el("langEnBtn")) el("langEnBtn").classList.toggle("active", currentLang === "en");
    if (el("heroTitle")) el("heroTitle").textContent = t.heroTitle;
    if (el("heroSub")) el("heroSub").textContent = t.heroSub;
    if (el("privacyPill")) el("privacyPill").textContent = t.privacyPill;
    if (el("dropTitle")) el("dropTitle").textContent = t.dropTitle;
    if (el("dropHint")) el("dropHint").textContent = t.dropHint;
    if (el("runCheckBtn")) el("runCheckBtn").textContent = t.runBtn;
    if (el("clearBtn")) el("clearBtn").textContent = t.clearBtn;
    if (el("demoUblBtn")) el("demoUblBtn").textContent = t.demoUbl;
    if (el("demoKuBtn")) el("demoKuBtn").textContent = t.demoKu;
    if (el("demoCnBtn")) el("demoCnBtn").textContent = t.demoCn;
    if (el("demoRcBtn")) el("demoRcBtn").textContent = t.demoRc;
    if (el("demoEuBtn")) el("demoEuBtn").textContent = t.demoEu;
    if (el("demoCiiBtn")) el("demoCiiBtn").textContent = t.demoCii;
    if (el("demoErrBtn")) el("demoErrBtn").textContent = t.demoErr;
    if (el("copyMdBtn")) el("copyMdBtn").textContent = t.copyMd;
    if (el("dlJsonBtn")) el("dlJsonBtn").textContent = t.dlJson;
    if (el("printPdfBtn")) el("printPdfBtn").textContent = t.printPdf;
    if (lastResult) renderResult(lastResult);
  }

  function showNotice(msg, isError) {
    const box = el("statusNotice");
    if (!box) return;
    if (!msg) {
      box.classList.add("hidden");
      box.textContent = "";
      return;
    }
    box.classList.remove("hidden");
    box.style.background = isError ? "#fef2f2" : "#ecfdf5";
    box.style.color = isError ? "#b91c1c" : "#065f46";
    box.style.border = `1px solid ${isError ? "#fecaca" : "#a7f3d0"}`;
    box.style.padding = "10px 14px";
    box.style.borderRadius = "8px";
    box.style.marginTop = "12px";
    box.textContent = msg;
  }

  function renderChecksTable(checks) {
    const tbody = el("checksTableBody");
    if (!tbody) return;
    const filtered = (checks || []).filter((c) => currentFilter === "ALL" || c.status === currentFilter);
    tbody.innerHTML = filtered
      .map((c) => {
        const badgeCls =
          c.status === "PASS" ? "badge-pass" : c.status === "WARN" ? "badge-warn" : "badge-fail";
        return (
          `<tr>` +
          `<td><code>${escapeHtml(c.id)}</code></td>` +
          `<td><strong>${escapeHtml(c.field)}</strong></td>` +
          `<td><span class="badge ${badgeCls}">${escapeHtml(c.status)}</span></td>` +
          `<td>${escapeHtml(c.message)}${c.value ? `<div class="muted">${escapeHtml(c.value)}</div>` : ""}</td>` +
          `</tr>`
        );
      })
      .join("");
  }

  function renderResult(res) {
    lastResult = res;
    const section = el("resultSection");
    if (!section) return;
    section.classList.remove("hidden");

    const t = I18N[currentLang];
    const circle = el("scoreCircle");
    if (circle) {
      circle.textContent = `${res.score_percent}%`;
      circle.classList.toggle("fail", !res.valid);
    }
    if (el("resultHeadline")) {
      el("resultHeadline").textContent = res.valid ? t.passTitle : t.failTitle;
    }
    if (el("resultSub")) {
      el("resultSub").textContent =
        `${currentFileName} · Standard: ${res.standard || "UNKNOWN"} · ` +
        `PASS ${res.summary.pass} · WARN ${res.summary.warn} · FAIL ${res.summary.fail}`;
    }

    const tot = res.totals || {};
    const p = res.parties || {};
    const cur = tot.currency || "EUR";
    if (el("kpiInvoiceId")) el("kpiInvoiceId").textContent = p.invoice_id || "-";
    if (el("kpiSeller")) el("kpiSeller").textContent = `${p.seller_name || "-"} (${p.seller_tax_id || "-"})`;
    if (el("kpiGross")) {
      el("kpiGross").textContent =
        tot.gross_amount !== null && tot.gross_amount !== undefined ? `${tot.gross_amount.toFixed(2)} ${cur}` : "-";
    }
    if (el("kpiIban")) el("kpiIban").textContent = p.iban || (p.buyer_reference ? `Ref: ${p.buyer_reference}` : "-");

    renderChecksTable(res.checks);
  }

  function runValidationFromTextarea() {
    const input = el("xmlInput");
    const raw = input ? input.value.trim() : "";
    if (!raw) {
      showNotice(I18N[currentLang].emptyXmlError, true);
      return;
    }
    showNotice("", false);
    const res = engine.validateXmlInvoice(raw);
    renderResult(res);
  }

  async function handleFile(file) {
    if (!file) return;
    currentFileName = file.name;
    const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
    if (isPdf) {
      const buf = await file.arrayBuffer();
      const xml = await engine.extractXmlFromPdfBuffer(buf);
      if (!xml) {
        showNotice(I18N[currentLang].pdfNoXmlError, true);
        if (el("xmlInput")) el("xmlInput").value = "";
        return;
      }
      if (el("xmlInput")) el("xmlInput").value = xml;
      showNotice("", false);
      renderResult(engine.validateXmlInvoice(xml));
    } else {
      const text = await file.text();
      if (el("xmlInput")) el("xmlInput").value = text;
      showNotice("", false);
      renderResult(engine.validateXmlInvoice(text));
    }
  }

  function init() {
    if (!el("xmlInput")) return;

    if (el("langDeBtn")) el("langDeBtn").addEventListener("click", () => applyLanguage("de"));
    if (el("langEnBtn")) el("langEnBtn").addEventListener("click", () => applyLanguage("en"));
    if (el("runCheckBtn")) el("runCheckBtn").addEventListener("click", runValidationFromTextarea);

    if (el("clearBtn")) {
      el("clearBtn").addEventListener("click", () => {
        el("xmlInput").value = "";
        currentFileName = "manuelle_pruefung.xml";
        showNotice("", false);
        if (el("resultSection")) el("resultSection").classList.add("hidden");
        lastResult = null;
      });
    }

    if (el("demoUblBtn")) {
      el("demoUblBtn").addEventListener("click", () => {
        currentFileName = "demo_xrechnung_3_0_ubl.xml";
        el("xmlInput").value = engine.SAMPLES.valid_xrechnung_ubl;
        runValidationFromTextarea();
      });
    }
    if (el("demoKuBtn")) {
      el("demoKuBtn").addEventListener("click", () => {
        currentFileName = "demo_kleinunternehmer_19_ustg.xml";
        el("xmlInput").value = engine.SAMPLES.valid_kleinunternehmer_ubl;
        runValidationFromTextarea();
      });
    }
    if (el("demoCnBtn")) {
      el("demoCnBtn").addEventListener("click", () => {
        currentFileName = "demo_gutschrift_381_ubl.xml";
        el("xmlInput").value = engine.SAMPLES.valid_credit_note_ubl;
        runValidationFromTextarea();
      });
    }
    if (el("demoRcBtn")) {
      el("demoRcBtn").addEventListener("click", () => {
        currentFileName = "demo_reverse_charge_13b_cii.xml";
        el("xmlInput").value = engine.SAMPLES.valid_reverse_charge_cii;
        runValidationFromTextarea();
      });
    }
    if (el("demoEuBtn")) {
      el("demoEuBtn").addEventListener("click", () => {
        currentFileName = "demo_eu_b2b_intra_community_k_ubl.xml";
        el("xmlInput").value = engine.SAMPLES.valid_intra_eu_ubl;
        runValidationFromTextarea();
      });
    }
    if (el("demoCiiBtn")) {
      el("demoCiiBtn").addEventListener("click", () => {
        currentFileName = "demo_zugferd_2_3_cii.xml";
        el("xmlInput").value = engine.SAMPLES.valid_zugferd_cii;
        runValidationFromTextarea();
      });
    }
    if (el("demoErrBtn")) {
      el("demoErrBtn").addEventListener("click", () => {
        currentFileName = "demo_fehlerhafte_rechnung.xml";
        el("xmlInput").value = engine.SAMPLES.invalid_ubl;
        runValidationFromTextarea();
      });
    }

    const dropzone = el("dropzone");
    const fileInput = el("fileInput");
    if (dropzone && fileInput) {
      dropzone.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", (ev) => {
        if (ev.target.files && ev.target.files[0]) handleFile(ev.target.files[0]);
      });
      dropzone.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        dropzone.classList.add("dragover");
      });
      dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
      dropzone.addEventListener("drop", (ev) => {
        ev.preventDefault();
        dropzone.classList.remove("dragover");
        if (ev.dataTransfer.files && ev.dataTransfer.files[0]) handleFile(ev.dataTransfer.files[0]);
      });
    }

    document.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentFilter = btn.getAttribute("data-filter") || "ALL";
        document.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("active", b === btn));
        if (lastResult) renderChecksTable(lastResult.checks);
      });
    });

    if (el("copyMdBtn")) {
      el("copyMdBtn").addEventListener("click", async () => {
        if (!lastResult) return;
        const md = engine.formatAuditReportMarkdown(lastResult, currentFileName);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(md);
          el("copyMdBtn").textContent = I18N[currentLang].copiedMd;
          setTimeout(() => {
            el("copyMdBtn").textContent = I18N[currentLang].copyMd;
          }, 1800);
        }
      });
    }

    if (el("dlJsonBtn")) {
      el("dlJsonBtn").addEventListener("click", () => {
        if (!lastResult) return;
        const jsonStr = engine.formatAuditReportJson(lastResult, currentFileName);
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${currentFileName.replace(/\.(xml|pdf)$/i, "")}_chedatacheck_audit.json`;
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    if (el("printPdfBtn")) {
      el("printPdfBtn").addEventListener("click", () => window.print());
    }

    // Load default valid sample cleanly on first open
    el("xmlInput").value = engine.SAMPLES.valid_xrechnung_ubl;
    runValidationFromTextarea();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
