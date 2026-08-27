"use strict";

(() => {
  const API = window.WTS_NOTIFY_API;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const state = (window.WTS_NOTIFY_STATE = {
    summary: null,
    contacts: [],
    estimateContacts: [],
    classes: [],
    messages: [],
    internalTemplates: [],
    remoteTemplates: [],
    provider: null,
    selected: new Set(),
    connected: false,
    importBatchId: null,
    importRows: [],
  });

  const escapeHtml = (value) =>
    String(value ?? "").replace(
      /[&<>'"]/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          "'": "&#39;",
          '"': "&quot;",
        })[character],
    );

  const prettify = (value) =>
    String(value || "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());

  function classNameFor(key) {
    if (!key || key === "all") return "All active classes";
    return (
      state.classes.find((item) => item.class_key === key)?.display_name ||
      prettify(key)
    );
  }

  function toast(message, type = "") {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = message;
    $("#toasts")?.append(node);
    setTimeout(() => node.remove(), 4800);
  }

  function keyOf(contact) {
    return contact.group_key || `guardian:${contact.recipient_id}`;
  }

  function childrenOf(contact) {
    if (Array.isArray(contact?.children) && contact.children.length) {
      return contact.children;
    }
    if (contact?.associated_name) {
      return [
        {
          contact_id: contact.recipient_id,
          student_id: contact.linked_person_id,
          name: contact.associated_name,
          class_name: contact.group_name,
          class_key: contact.group_name,
        },
      ];
    }
    return [];
  }

  function childrenText(contact) {
    return childrenOf(contact)
      .map(
        (child) =>
          `${child.name || "Student"}${child.class_name ? ` (${child.class_name})` : ""}`,
      )
      .join(", ");
  }

  function setConnected(connected, message = "") {
    state.connected = connected;
    document.body.classList.toggle("locked", !connected);
    $("#dot")?.classList.toggle("on", connected);
    if ($("#connectionText")) {
      $("#connectionText").textContent = connected
        ? "Staff Portal connected"
        : "Staff Portal authorization required";
    }
    if ($("#authError") && message) $("#authError").textContent = message;
  }

  function returnToPortal() {
    API.clearAuth();
    state.contacts = [];
    state.messages = [];
    state.selected.clear();
    setConnected(false);
    window.location.assign(`${window.WTS_CONFIG.portalOrigin}/workspace`);
  }

  function populateClassSelect(selector, includeAll = true) {
    const select = $(selector);
    if (!select) return;
    const current = select.value;
    const options = [];
    if (includeAll) options.push('<option value="all">All active classes</option>');
    else options.push('<option value="">Select an active class</option>');
    state.classes.forEach((item) => {
      options.push(
        `<option value="${escapeHtml(item.class_key)}">${escapeHtml(item.display_name)}${item.student_count != null ? ` · ${item.student_count} students` : ""}</option>`,
      );
    });
    select.innerHTML = options.join("");
    if ([...select.options].some((option) => option.value === current)) {
      select.value = current;
    }
  }

  async function loadClasses() {
    const data = await API.recipientRead("classes");
    state.classes = data.classes || [];
    populateClassSelect("#composeClass", true);
    populateClassSelect("#contactClass", true);
    populateClassSelect("#importClass", false);
    return state.classes;
  }

  function updateSummaryCards(summary, recipients) {
    const parents = recipients?.guardians || {};
    $("#mContacts").textContent = parents.total || 0;
    $("#mChildren").textContent = summary?.contacts?.active || 0;
    $("#mOptin").textContent = parents.opted_in || 0;
    $("#mDelivered").textContent =
      summary?.messages?.delivered || summary?.messages?.read || summary?.messages?.sent || 0;
    $("#mFailed").textContent = summary?.messages?.failed || 0;
  }

  async function loadSummary() {
    const [summary, recipients] = await Promise.all([
      API.read("summary"),
      API.recipientRead("summary"),
    ]);
    state.summary = summary;
    updateSummaryCards(summary, recipients);
    setConnected(true);
    loadClasses().catch((error) => toast(error.message, "error"));
    if (window.WTS_NOTIFY_PROVIDER?.loadStatus) {
      void window.WTS_NOTIFY_PROVIDER.loadStatus({ silent: true });
    }
    if ($("#view-compose")?.classList.contains("active")) void loadComposeEstimate();
    return summary;
  }

  function renderContacts() {
    const contacts = state.contacts;
    const ready = contacts.filter((contact) => contact.eligible).length;
    const children = contacts.reduce(
      (total, contact) => total + (Number(contact.child_count) || childrenOf(contact).length),
      0,
    );
    $("#contactSummary").textContent = `${contacts.length} parent group(s) · ${children} child link(s) in scope · ${ready} ready to send · ${state.selected.size} selected`;
    $("#contactScopeText").textContent =
      `Showing ${classNameFor($("#contactClass")?.value)}. Each row is one WhatsApp destination; children remain visible underneath.`;
    $("#contactEmpty").style.display = contacts.length ? "none" : "block";
    $("#contactRows").innerHTML = contacts
      .map((contact) => {
        const key = keyOf(contact);
        const children = childrenOf(contact);
        const childHtml = children.length
          ? `<div class="child-list">${children
              .map(
                (child) =>
                  `<div class="child-row"><b>${escapeHtml(child.name || "Student")}</b><span class="class-tag">${escapeHtml(child.class_name || classNameFor(child.class_key))}</span></div>`,
              )
              .join("")}</div>`
          : '<span class="muted-copy">No child link</span>';
        const readyHtml = contact.eligible
          ? '<span class="badge ready">Ready</span>'
          : `<span class="badge">${escapeHtml(contact.whatsapp_number ? "Review" : "No number")}</span><small>${escapeHtml(contact.consent_status === "partial" ? "Consent differs across child links" : "Needs consent, verification or a number")}</small>`;
        return `<tr>
          <td><input type="checkbox" data-contact="${escapeHtml(key)}" ${state.selected.has(key) ? "checked" : ""} aria-label="Select ${escapeHtml(contact.display_name || "parent group")}" /></td>
          <td><strong>${escapeHtml(contact.display_name || "Parent")}</strong><small>${escapeHtml(contact.member_count || 1)} child link(s) · ${escapeHtml(contact.group_key || "")}</small></td>
          <td>${childHtml}</td>
          <td><strong>${escapeHtml(contact.whatsapp_number || "Number missing")}</strong><small>${escapeHtml(contact.group_name || "")}</small></td>
          <td><span class="badge ${escapeHtml(contact.consent_status)}">${escapeHtml(contact.consent_status || "pending")}</span><small>${contact.verified ? "All linked numbers verified" : "Verification not complete"}</small></td>
          <td>${readyHtml}</td>
          <td><button class="ghost compact" data-edit-recipient="${escapeHtml(key)}" type="button">Edit link</button></td>
        </tr>`;
      })
      .join("");

    $$('[data-contact]').forEach((checkbox) => {
      checkbox.onchange = () => {
        if (checkbox.checked) state.selected.add(checkbox.dataset.contact);
        else state.selected.delete(checkbox.dataset.contact);
        renderContacts();
      };
    });
    $$('[data-edit-recipient]').forEach((button) => {
      button.onclick = () =>
        openRecipient(
          state.contacts.find((contact) => keyOf(contact) === button.dataset.editRecipient),
        );
    });
  }

  async function loadContacts() {
    try {
      const data = await API.recipientRead("recipients", {
        search: $("#contactSearch").value.trim(),
        recipientType: "guardian",
        // Fetch the complete group before filtering locally. The effective
        // consent status belongs to the group, not an individual child row.
        status: "",
        classKey: $("#contactClass").value,
        pilotOnly: false,
        limit: 1000,
      });
      const allContacts = (data.recipients || []).filter(
        (contact) => contact.recipient_type !== "staff",
      );
      const status = $("#contactStatus").value;
      state.contacts = status
        ? allContacts.filter((contact) => contact.consent_status === status)
        : allContacts;
      renderContacts();
      if (
        $("#composeClass").value === $("#contactClass").value &&
        !$("#contactSearch").value.trim() &&
        !$("#contactStatus").value
      ) {
        state.estimateContacts = state.contacts;
        renderComposeEstimate();
      }
    } catch (error) {
      toast(error.message, "error");
    }
  }

  let estimateRequest = 0;
  async function loadComposeEstimate() {
    const requestId = ++estimateRequest;
    try {
      const data = await API.recipientRead("recipients", {
        recipientType: "guardian",
        classKey: $("#composeClass").value,
        pilotOnly: false,
        limit: 1000,
      });
      if (requestId !== estimateRequest) return;
      state.estimateContacts = (data.recipients || []).filter(
        (contact) => contact.recipient_type !== "staff",
      );
      renderComposeEstimate();
    } catch (error) {
      if (requestId === estimateRequest) toast(error.message, "error");
    }
  }

  function renderComposeEstimate() {
    const all = state.estimateContacts || [];
    const eligible = all.filter((contact) => contact.eligible);
    const audience = $("#audience")?.value || "all";
    const selected = audience === "selected"
      ? eligible.filter((contact) => state.selected.has(keyOf(contact)))
      : eligible;
    const scope = classNameFor($("#composeClass")?.value);
    $("#recipientEstimate").innerHTML = `<b>${selected.length}</b><span>${audience === "selected" ? "selected eligible parent groups" : `eligible parent groups in ${escapeHtml(scope)}`}</span>`;
    const example = selected[0] || eligible[0];
    $("#mergePreviewText").textContent = example
      ? `${example.display_name || "This parent"} receives one WhatsApp message for the children in the selected scope.`
      : "No eligible parent group is available in this scope yet.";
    $("#mergePreviewChildren").innerHTML = example
      ? childrenOf(example)
          .map(
            (child) =>
              `<div>${escapeHtml(child.name || "Student")} <span class="class-tag">${escapeHtml(child.class_name || classNameFor(child.class_key))}</span></div>`,
          )
          .join("") || "The template will contain the common message only."
      : "No eligible group selected yet.";
  }

  function openRecipient(contact) {
    if (!contact) return;
    const memberIds = Array.isArray(contact.member_ids) ? contact.member_ids : [];
    const representative = memberIds[0] || contact.recipient_id;
    $("#recipientTitle").textContent = `Parent contact: ${contact.display_name || "Parent"}`;
    $("#recipientChildren").textContent = `This group contains ${contact.member_count || 1} child link(s): ${childrenText(contact) || "No child name available"}. Editing updates the representative child link; use a class import for the rest.`;
    $("#recipientId").value = representative || "";
    $("#recipientWhatsapp").value = contact.whatsapp_number || "";
    $("#recipientConsent").value = ["pending", "opted_in", "opted_out", "revoked"].includes(contact.consent_status) ? contact.consent_status : "pending";
    $("#recipientConsentSource").value = "";
    $("#recipientVerified").checked = Boolean(contact.verified);
    $("#recipientDialog").showModal();
  }

  async function saveRecipient(event) {
    event.preventDefault();
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      await API.recipientWrite("saveRecipient", {
        recipientId: $("#recipientId").value,
        recipientType: "guardian",
        phone: $("#recipientWhatsapp").value,
        whatsappNumber: $("#recipientWhatsapp").value,
        consentStatus: $("#recipientConsent").value,
        consentSource: $("#recipientConsentSource").value,
        preferredLanguage: "en",
        verified: $("#recipientVerified").checked,
        pilotEnabled: false,
      });
      $("#recipientDialog").close();
      toast("Parent child link saved.", "success");
      await Promise.all([loadContacts(), loadSummary()]);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  function messageChildren(message) {
    const children = message?.payload?.children;
    if (Array.isArray(children) && children.length) {
      return children
        .map((child) => `${child.name || "Student"}${child.class_name ? ` (${child.class_name})` : ""}`)
        .join(", ");
    }
    return message?.payload?.children_summary || message?.payload?.associated_name || "";
  }

  function displayStatus(message) {
    return String(
      message?.payload?.bahasha_delivery_status ||
        message?.payload?.meta_delivery_status ||
        message?.status ||
        "draft",
    ).toLowerCase();
  }

  async function loadMessages() {
    try {
      const data = await API.read("messages", {
        // Provider delivery statuses are stored in the payload by the
        // existing shared status routine, so filter after reading the rows.
        status: "",
      });
      const allMessages = (data.messages || []).filter(
        (message) => message.recipient_type !== "staff",
      );
      const selectedStatus = $("#messageStatus").value;
      state.messages = selectedStatus
        ? allMessages.filter((message) => displayStatus(message) === selectedStatus)
        : allMessages;
      $("#messageList").innerHTML = state.messages.length
        ? state.messages
            .map((message) => {
              const childSummary = messageChildren(message);
              const status = displayStatus(message);
              return `<article class="message"><div class="message-head"><div><strong>${escapeHtml(message.recipient_name || "Parent")}</strong><small>${escapeHtml(message.payload?.class_key && message.payload.class_key !== "all" ? classNameFor(message.payload.class_key) : "All classes")} · ${escapeHtml(message.payload?.child_count || 0)} child link(s) · WhatsApp · ${escapeHtml(message.destination_masked || "")}</small></div><span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span></div>${childSummary ? `<div class="message-children"><b>Children in message:</b> ${escapeHtml(childSummary)}</div>` : ""}<p>${escapeHtml(message.message)}</p><small>${message.template_name ? `Template: ${escapeHtml(message.template_name)} · ` : ""}${new Date(message.created_at).toLocaleString("en-NG")}${message.last_error ? ` · ${escapeHtml(message.last_error)}` : ""}</small></article>`;
            })
            .join("")
        : '<div class="empty card">No parent messages found.</div>';
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function loadInternalTemplates() {
    const data = await API.read("templates");
    state.internalTemplates = data.templates || [];
    renderInternalTemplates();
    return state.internalTemplates;
  }

  function renderInternalTemplates() {
    const templates = state.internalTemplates || [];
    $("#internalTemplateCount").textContent = `${templates.length} records`;
    $("#internalTemplates").innerHTML = templates.length
      ? templates
          .map((template) => {
            const providerStatus = String(template.provider_template_status || "not_submitted").toLowerCase();
            const provider = template.provider_template_name
              ? `${template.provider_template_name} · ${template.provider_template_language || template.language_code || "en"}`
              : "No Bahasha mapping yet";
            return `<div class="template-item"><strong>${escapeHtml(template.template_name || template.template_code)}</strong><small>${escapeHtml(prettify(template.event_type || template.source_system))} · ${escapeHtml(template.language_code || "en")} · variables: ${escapeHtml((template.variable_keys || []).join(", ") || "none")}</small><small>${escapeHtml(provider)}</small><div class="template-meta"><span>${escapeHtml(template.status || "active")}</span><span class="${providerStatus === "approved" ? "approved" : "pending"}">${escapeHtml(providerStatus)}</span></div></div>`;
          })
          .join("")
      : '<div class="empty">No WTS templates found.</div>';
  }

  function renderRemoteTemplates() {
    const templates = state.remoteTemplates || [];
    const count = $("#remoteTemplateCount");
    if (count) count.textContent = state.provider ? `${templates.filter((item) => item.status === "APPROVED").length} approved` : "Not checked";
    $("#remoteTemplates").innerHTML = templates.length
      ? templates
          .map((template) => `<div class="template-item"><strong>${escapeHtml(template.name || "Unnamed template")}</strong><small>${escapeHtml(template.language || template.language_code || "—")} · ${escapeHtml(template.category || "—")}</small><small>${escapeHtml((template.expected_variables?.body || []).map((variable) => variable.param_name).join(", ") || "No body variables")}</small><div class="template-meta"><span class="${template.status === "APPROVED" ? "approved" : template.status === "PENDING" ? "pending" : ""}">${escapeHtml(template.status || "unknown")}</span></div></div>`)
          .join("")
      : '<div class="empty">No remote templates loaded. Check the Bahasha connection.</div>';
  }

  function renderTemplateSelect() {
    const select = $("#templateSelect");
    if (!select) return;
    const current = select.value;
    const approved = (state.remoteTemplates || []).filter((item) => item.status === "APPROVED");
    select.innerHTML = ['<option value="">Auto-map from message type</option>']
      .concat(
        approved.map((template) => {
          const value = `${encodeURIComponent(template.name)}::${encodeURIComponent(template.language || template.language_code || "en_US")}`;
          return `<option value="${escapeHtml(value)}">${escapeHtml(template.name)} · ${escapeHtml(template.language || template.language_code || "en_US")}</option>`;
        }),
      )
      .join("");
    if ([...select.options].some((option) => option.value === current)) select.value = current;
    $("#templateHelp").textContent = approved.length
      ? "Choose an approved remote template to pin this message; Auto-map uses the server purpose mapping."
      : "No APPROVED Bahasha templates are loaded. Check the connection and approve the template in Bahasha before delivery.";
  }

  function setProviderData(data) {
    state.provider = data;
    state.remoteTemplates = data.templates || [];
    renderRemoteTemplates();
    renderTemplateSelect();
  }

  function parseCsv(text) {
    const source = String(text || "").replace(/^\uFEFF/, "").trim();
    if (!source) return [];
    const firstLine = source.split(/\r?\n/, 1)[0];
    const delimiter = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character === '"') {
        if (quoted && source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === delimiter && !quoted) {
        row.push(field.trim());
        field = "";
      } else if ((character === "\n" || character === "\r") && !quoted) {
        if (character === "\r" && source[index + 1] === "\n") index += 1;
        row.push(field.trim());
        if (row.some(Boolean)) rows.push(row);
        row = [];
        field = "";
      } else {
        field += character;
      }
    }
    row.push(field.trim());
    if (row.some(Boolean)) rows.push(row);
    if (rows.length < 2) return [];
    const headers = rows.shift().map((header) => header.trim());
    return rows.map((values) => {
      const result = {};
      headers.forEach((header, index) => {
        result[header] = values[index] || "";
      });
      if (typeof result.preferredChannels === "string") {
        result.preferredChannels = result.preferredChannels
          .split(/[|;]/)
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
      }
      if (typeof result.isPrimary === "string") {
        result.isPrimary = ["true", "1", "yes", "y"].includes(result.isPrimary.toLowerCase());
      }
      return result;
    });
  }

  function renderImportPreview(result, rows = []) {
    const preview = $("#importPreviewCard");
    preview.hidden = false;
    const total = result?.total_rows ?? rows.length;
    const valid = result?.valid_rows ?? rows.length;
    const invalid = result?.invalid_rows ?? 0;
    $("#importPreviewTitle").textContent = `${total} row(s) · ${valid} valid · ${invalid} to review`;
    const status = $("#importPreviewStatus");
    status.textContent = result?.status || "preview";
    status.classList.toggle("ready", result?.status === "validated");
    status.classList.toggle("warn", result?.status === "partially_valid");
    status.classList.toggle("bad", result?.status === "invalid");
    $("#importRows").innerHTML = rows.length
      ? rows.map((row, index) => {
          const errors = Array.isArray(row.validation_errors) ? row.validation_errors : [];
          const statusText = row.match_status || "staged";
          return `<div class="import-row ${statusText === "matched" ? "" : "invalid"}"><b>${escapeHtml(row.row_number || index + 2)}</b><span><strong>${escapeHtml(row.student_name || row.studentName || "Student")}</strong><small>${escapeHtml(row.student_admission_number || row.studentAdmissionNumber || "No admission number")}</small></span><span><strong>${escapeHtml(row.guardian_name || row.guardianName || "Guardian")}</strong><small>${escapeHtml(row.whatsapp_number || row.whatsappNumber || row.phone || "No WhatsApp number")}</small></span><span class="badge ${statusText === "matched" ? "ready" : "failed"}">${escapeHtml(errors.length ? errors.join(", ") : statusText)}</span></div>`;
        }).join("")
      : '<div class="empty">No rows to preview.</div>';
  }

  async function importTextFromForm() {
    const pasted = $("#importText").value.trim();
    if (pasted) return { text: pasted, filename: "pasted-contacts.csv" };
    const file = $("#importFile").files?.[0];
    if (!file) return { text: "", filename: "" };
    return { text: await file.text(), filename: file.name };
  }

  async function validateImport(event) {
    event.preventDefault();
    const button = $("#validateImport");
    const classKey = $("#importClass").value;
    if (!classKey) {
      toast("Select the class this import belongs to first.", "error");
      return;
    }
    button.disabled = true;
    button.textContent = "Validating…";
    try {
      const source = await importTextFromForm();
      const rows = parseCsv(source.text);
      if (!rows.length) throw new Error("Choose a CSV file or paste a CSV with a header row and at least one contact.");
      state.importRows = rows;
      const result = await API.guardianImportWrite("validateBatch", {
        classKey,
        batchName: $("#importBatchName").value.trim() || `${classNameFor(classKey)} guardian contacts`,
        sourceFilename: source.filename,
        rows,
      });
      state.importBatchId = result.batch_id || null;
      let serverRows = rows;
      if (state.importBatchId) {
        const detail = await API.guardianImportRead("rows", { batchId: state.importBatchId });
        serverRows = detail.rows || rows;
      }
      renderImportPreview(result, serverRows);
      $("#importResult").innerHTML = `<strong>Class import validated</strong><br>${escapeHtml(result.valid_rows || 0)} row(s) can be applied to ${escapeHtml(classNameFor(classKey))}; ${escapeHtml(result.invalid_rows || 0)} row(s) need review.${result.class_mismatch_rows ? `<br>${escapeHtml(result.class_mismatch_rows)} row(s) belonged to another class and were held back.` : ""}`;
      $("#applyImport").disabled = !(result.valid_rows > 0 && ["validated", "partially_valid"].includes(result.status));
      toast("Class import validation complete.", "success");
    } catch (error) {
      toast(error.message, "error");
      $("#importResult").textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = "Validate class import";
    }
  }

  async function applyImport() {
    if (!state.importBatchId) return;
    if (!confirm("Apply the valid rows to the Central Registry? Invalid rows will remain unapplied.")) return;
    const button = $("#applyImport");
    button.disabled = true;
    button.textContent = "Applying…";
    try {
      const result = await API.guardianImportWrite("applyBatch", { batchId: state.importBatchId });
      $("#importResult").innerHTML = `<strong>Central Registry synchronized</strong><br>${escapeHtml(result.applied_rows || 0)} row(s) applied · ${escapeHtml(result.failed_rows || 0)} apply failure(s) · ${escapeHtml(result.explicit_opt_ins || 0)} explicit WhatsApp opt-in(s).`;
      toast("Guardian contacts applied to the Central Registry.", "success");
      await Promise.all([loadSummary(), loadContacts()]);
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    } finally {
      button.textContent = "Apply to Central Registry";
    }
  }

  function downloadImportTemplate() {
    const header = "studentAdmissionNumber,studentName,guardianName,relationship,phone,whatsappNumber,email,preferredChannels,isPrimary,preferredLanguage,consentStatus,consentSource,notes";
    const blob = new Blob([`${header}\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "wts-guardian-contacts-template.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function loadTemplates() {
    try {
      await loadInternalTemplates();
      if (window.WTS_NOTIFY_PROVIDER?.loadStatus) await window.WTS_NOTIFY_PROVIDER.loadStatus({ silent: true });
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function showView(name) {
    if (!state.connected) return;
    $$(".view").forEach((section) => section.classList.toggle("active", section.id === `view-${name}`));
    $$(".nav").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
    $("#title").textContent = {
      overview: "Notification overview",
      compose: "Send a parent message",
      contacts: "Parent directory",
      imports: "Import contacts by class",
      templates: "Templates & Bahasha",
      delivery: "Message delivery",
    }[name] || "Parent notifications";
    if (name === "contacts") void loadContacts();
    if (name === "compose") void loadComposeEstimate();
    if (name === "delivery") void loadMessages();
    if (name === "templates") void loadTemplates();
  }

  async function prepareAttendance() {
    const attendanceDate = prompt("Attendance date (YYYY-MM-DD)", new Date().toISOString().slice(0, 10));
    if (!attendanceDate) return;
    const academicSession = prompt("Academic session", "2026/2027");
    if (!academicSession) return;
    try {
      const result = await API.write("prepareAttendanceDrafts", { attendanceDate, academicSession });
      toast(`${result.draft_operations || 0} parent attendance alert(s) prepared.`, "success");
      await loadSummary();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  $$(".nav").forEach((button) => {
    button.onclick = () => showView(button.dataset.view);
  });
  $$('[data-go]').forEach((button) => {
    button.onclick = () => {
      const target = button.dataset.go;
      if (target === "compose" && $("#contactClass")?.value) $("#composeClass").value = $("#contactClass").value;
      if (target === "compose" && state.selected.size) $("#audience").value = "selected";
      showView(target);
    };
  });
  $("#contactFind").onclick = loadContacts;
  $("#contactStatus").onchange = loadContacts;
  $("#contactClass").onchange = loadContacts;
  $("#selectAll").onclick = () => {
    state.contacts.filter((contact) => contact.eligible).forEach((contact) => state.selected.add(keyOf(contact)));
    renderContacts();
  };
  $("#recipientForm").onsubmit = saveRecipient;
  $("#importForm").onsubmit = validateImport;
  $("#applyImport").onclick = applyImport;
  $("#downloadImportTemplate").onclick = downloadImportTemplate;
  $("#importFile").onchange = async () => {
    const file = $("#importFile").files?.[0];
    if (!file) return;
    $("#importText").value = await file.text();
    if (!$("#importBatchName").value) $("#importBatchName").value = file.name.replace(/\.[^.]+$/, "");
  };
  $("#prepareAttendance").onclick = prepareAttendance;
  $("#messageStatus").onchange = loadMessages;
  $("#composeClass").onchange = loadComposeEstimate;
  $("#audience").onchange = renderComposeEstimate;
  $("#refresh").onclick = () =>
    loadSummary().catch((error) => {
      toast(error.message, "error");
      if (/AUTH|PERMISSION|login/i.test(error.message)) returnToPortal();
    });
  $("#login").onclick = returnToPortal;
  $("#refreshTemplates").onclick = () => void loadTemplates();
  $("#gateForm").onsubmit = (event) => {
    event.preventDefault();
    $("#authError").textContent = "Connecting…";
    if (window.WTS_NOTIFICATION_IDENTITY?.beginSso) {
      void window.WTS_NOTIFICATION_IDENTITY.beginSso();
      return;
    }
    window.location.assign("/api/sso-start");
  };

  window.WTS_NOTIFY_UI = {
    toast,
    escapeHtml,
    loadSummary,
    loadClasses,
    loadContacts,
    loadMessages,
    loadTemplates,
    renderRemoteTemplates,
    renderTemplateSelect,
    setProviderData,
    showView,
  };

  setConnected(false);
})();
