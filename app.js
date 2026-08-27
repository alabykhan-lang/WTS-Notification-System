"use strict";

(() => {
  const API = window.WTS_NOTIFY_API;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const state = (window.WTS_NOTIFY_STATE = {
    summary: null,
    contacts: [],
    classes: [],
    messages: [],
    remoteTemplates: [],
    provider: null,
    selected: new Set(),
    connected: false,
    importBatchId: null,
    importRows: [],
  });

  const errorCopy = {
    ADMIN_AUTH_OR_PERMISSION_FAILED: "Your Staff Portal session has expired. Please sign in again.",
    APPROVED_TEMPLATE_REQUIRED: "Choose an approved Bahasha template first.",
    BAHASHA_LIVE_DELIVERY_NOT_ENABLED: "Live WhatsApp delivery is not enabled yet. Check the Bahasha connection settings.",
    BAHASHA_LIVE_PROVIDER_NOT_READY: "Bahasha is not ready for live delivery yet.",
    CLASS_REQUIRED: "Choose a class first.",
    INVALID_CLASS: "That class is no longer active. Refresh and choose another class.",
    NO_ELIGIBLE_PARENT_GROUPS: "There are no opted-in parent contacts ready in this class.",
    SELECTED_RECIPIENTS_REQUIRED: "Select at least one ready parent.",
    WHATSAPP_CHANNEL_NOT_ALLOWED: "WhatsApp is not enabled for this school.",
  };

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

  function friendlyError(error) {
    const code = String(error?.code || error?.message || "");
    return errorCopy[code] || String(error?.message || error || "Something went wrong.");
  }

  function classNameFor(key) {
    if (!key) return "Choose a class";
    return (
      state.classes.find((item) => item.class_key === key)?.display_name ||
      prettify(key)
    );
  }

  function toast(message, type = "") {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = friendlyError({ message });
    $("#toasts")?.append(node);
    setTimeout(() => node.remove(), 4800);
  }

  function keyOf(contact) {
    return contact?.group_key || `guardian:${contact?.recipient_id || ""}`;
  }

  function childrenOf(contact) {
    if (Array.isArray(contact?.children) && contact.children.length) return contact.children;
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

  function isReady(contact) {
    return contact?.eligible === true || contact?.eligible === 1 || contact?.eligible === "true";
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

  function populateClassSelect(selector) {
    const select = $(selector);
    if (!select) return;
    const current = select.value;
    const options = ['<option value="">Choose a class</option>'];
    state.classes.forEach((item) => {
      options.push(
        `<option value="${escapeHtml(item.class_key)}">${escapeHtml(item.display_name)}${item.student_count != null ? ` · ${escapeHtml(item.student_count)} students` : ""}</option>`,
      );
    });
    select.innerHTML = options.join("");
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }

  async function loadClasses() {
    const data = await API.recipientRead("classes");
    state.classes = data.classes || [];
    populateClassSelect("#composeClass");
    populateClassSelect("#importClass");
    return state.classes;
  }

  function updateSummaryCards(summary, recipients) {
    const parents = recipients?.guardians || {};
    $("#mContacts").textContent = parents.total || 0;
    $("#mChildren").textContent = summary?.contacts?.active || 0;
    $("#mOptin").textContent = parents.opted_in || 0;
  }

  async function loadSummary() {
    const [summary, recipients] = await Promise.all([
      API.read("summary"),
      API.recipientRead("summary"),
    ]);
    state.summary = summary;
    updateSummaryCards(summary, recipients);
    setConnected(true);
    await loadClasses();
    if (window.WTS_NOTIFY_PROVIDER?.loadStatus) {
      void window.WTS_NOTIFY_PROVIDER.loadStatus({ silent: true });
    }
    if ($("#view-compose")?.classList.contains("active")) {
      await loadClassRecipients($("#composeClass")?.value || "");
    }
    if ($("#view-delivery")?.classList.contains("active")) {
      await loadMessages();
    }
    return summary;
  }

  async function loadClassRecipients(classKey, { resetSelection = false } = {}) {
    if (resetSelection) state.selected.clear();
    if (!classKey) {
      state.contacts = [];
      renderSendRecipients();
      renderSendState();
      return [];
    }
    try {
      const data = await API.recipientRead("recipients", {
        recipientType: "guardian",
        status: "",
        classKey,
        pilotOnly: false,
        limit: 1000,
      });
      state.contacts = (data.recipients || []).filter(
        (contact) => contact.recipient_type !== "staff",
      );
      const currentKeys = new Set(state.contacts.map(keyOf));
      state.selected = new Set([...state.selected].filter((key) => currentKeys.has(key)));
      renderSendRecipients();
      renderSendState();
      return state.contacts;
    } catch (error) {
      toast(friendlyError(error), "error");
      return [];
    }
  }

  function selectedTemplate() {
    const value = $("#templateSelect")?.value || "";
    const separator = value.indexOf("::");
    if (separator < 0) return null;
    try {
      const name = decodeURIComponent(value.slice(0, separator));
      const language = decodeURIComponent(value.slice(separator + 2));
      return state.remoteTemplates.find(
        (item) => item.name === name && (item.language || item.language_code || "en_US") === language,
      ) || { name, language };
    } catch {
      return null;
    }
  }

  function renderSendRecipients() {
    const rows = $("#sendContactRows");
    if (!rows) return;
    if (!$("#composeClass")?.value) {
      rows.innerHTML = '<div class="empty-inline">Choose a class first.</div>';
      return;
    }
    if (!state.contacts.length) {
      rows.innerHTML = '<div class="empty-inline">No parent contacts found in this class.</div>';
      return;
    }
    rows.innerHTML = state.contacts
      .map((contact) => {
        const key = keyOf(contact);
        const ready = isReady(contact);
        const children = childrenText(contact) || "No child link shown";
        const reason = ready
          ? "Ready"
          : contact.whatsapp_number
            ? "Needs opt-in or verification"
            : "WhatsApp number missing";
        return `<label class="send-contact ${ready ? "" : "not-ready"}">
          <input type="checkbox" data-send-contact="${escapeHtml(key)}" ${state.selected.has(key) ? "checked" : ""} ${ready ? "" : "disabled"} />
          <span><b>${escapeHtml(contact.display_name || "Parent")}</b><small>${escapeHtml(children)}</small><small>${escapeHtml(contact.whatsapp_number || "No WhatsApp number")}</small></span>
          <span class="badge ${ready ? "ready" : ""}">${escapeHtml(reason)}</span>
        </label>`;
      })
      .join("");

    $$('[data-send-contact]').forEach((checkbox) => {
      checkbox.onchange = () => {
        if (checkbox.checked) state.selected.add(checkbox.dataset.sendContact);
        else state.selected.delete(checkbox.dataset.sendContact);
        renderSendState();
      };
    });
  }

  function renderSendState() {
    const ready = state.contacts.filter(isReady);
    const selectedReady = ready.filter((contact) => state.selected.has(keyOf(contact)));
    const audience = $("input[name=audience]:checked")?.value || "all";
    const template = selectedTemplate();
    const classKey = $("#composeClass")?.value || "";
    const count = audience === "selected" ? selectedReady.length : ready.length;
    if ($("#allCount")) $("#allCount").textContent = `${ready.length} parent${ready.length === 1 ? "" : "s"}`;
    if ($("#selectedCount")) $("#selectedCount").textContent = `${selectedReady.length} selected`;
    if ($("#sendContacts")) $("#sendContacts").hidden = audience !== "selected";
    if ($("#selectAllSend")) $("#selectAllSend").disabled = !ready.length;

    let review = "Choose a template and class to continue.";
    if (template && classKey) {
      review = audience === "selected"
        ? `${selectedReady.length} ready parent${selectedReady.length === 1 ? "" : "s"} selected in ${classNameFor(classKey)}.`
        : `${ready.length} ready parent${ready.length === 1 ? "" : "s"} in ${classNameFor(classKey)}.`;
      if (!count) review = `No ready parent contacts are available in ${classNameFor(classKey)}.`;
    } else if (template) {
      review = "Choose a class to see its ready parent contacts.";
    }
    if ($("#sendReview")) $("#sendReview").textContent = review;
    const deliveryReady = state.provider?.live_delivery_ready === true;
    const canSend = Boolean(template && classKey && count && deliveryReady);
    if ($("#sendButton")) $("#sendButton").disabled = !canSend;
  }

  function templateBody(template) {
    if (!template) return "";
    if (template.body || template.body_text || template.text || template.content) {
      return template.body || template.body_text || template.text || template.content;
    }
    const body = (template.components || []).find(
      (component) => String(component.type || "").toUpperCase() === "BODY",
    );
    return body?.text || "";
  }

  function renderTemplatePreview() {
    const preview = $("#templatePreview");
    if (!preview) return;
    const template = selectedTemplate();
    if (!template) {
      preview.textContent = "The approved Bahasha message will appear here after you choose a template.";
      renderSendState();
      return;
    }
    const text = templateBody(template);
    const variables = (template.expected_variables?.body || [])
      .map((item) => item.param_name)
      .filter((item) => item !== undefined && item !== null);
    preview.innerHTML = text
      ? `<strong>Approved message</strong><br>${escapeHtml(text)}${variables.length ? `<br><small>Automatic details: ${escapeHtml(variables.join(", "))}</small>` : ""}`
      : `<strong>${escapeHtml(template.name)}</strong><br>Bahasha will use the approved message text.${variables.length ? `<br><small>Automatic details: ${escapeHtml(variables.join(", "))}</small>` : ""}`;
    renderSendState();
  }

  function renderTemplateSelect() {
    const select = $("#templateSelect");
    if (!select) return;
    const current = select.value;
    const approved = (state.remoteTemplates || []).filter(
      (item) => String(item.status || "").toUpperCase() === "APPROVED",
    );
    select.innerHTML = [
      '<option value="">Choose an approved message</option>',
      ...approved.map((template) => {
        const language = template.language || template.language_code || "en_US";
        const value = `${encodeURIComponent(template.name)}::${encodeURIComponent(language)}`;
        return `<option value="${escapeHtml(value)}">${escapeHtml(template.name)} · ${escapeHtml(language)}</option>`;
      }),
    ].join("");
    if ([...select.options].some((option) => option.value === current)) select.value = current;
    else if (approved.length === 1) {
      const only = approved[0];
      select.value = `${encodeURIComponent(only.name)}::${encodeURIComponent(only.language || only.language_code || "en_US")}`;
    }
    renderTemplatePreview();
  }

  function setProviderData(data) {
    state.provider = data || null;
    state.remoteTemplates = Array.isArray(data?.templates) ? data.templates : [];
    renderTemplateSelect();
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

  function messageTemplate(message) {
    return message?.payload?.whatsapp_template_name || message?.template_name || "Selected Bahasha template";
  }

  function renderMessages() {
    const list = $("#messageList");
    if (!list) return;
    list.innerHTML = state.messages.length
      ? state.messages
          .map((message) => {
            const status = displayStatus(message);
            const deletable = ["draft", "cancelled", "skipped"].includes(status);
            const childSummary = messageChildren(message);
            const scope = message?.payload?.class_key && message.payload.class_key !== "all"
              ? classNameFor(message.payload.class_key)
              : "All classes";
            const date = message.created_at
              ? new Date(message.created_at).toLocaleString("en-NG")
              : "—";
            return `<article class="message"><div class="message-head"><div><strong>${escapeHtml(message.recipient_name || "Parent")}</strong><small>${escapeHtml(scope)} · ${escapeHtml(message.destination_masked || "WhatsApp")}</small></div><span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span></div>${childSummary ? `<div class="message-children"><b>Children:</b> ${escapeHtml(childSummary)}</div>` : ""}<p><b>Template:</b> ${escapeHtml(messageTemplate(message))}</p><div class="message-actions"><small>${escapeHtml(date)}${message.last_error ? ` · ${escapeHtml(message.last_error)}` : ""}</small>${deletable ? `<button class="message-delete" data-delete-message="${escapeHtml(message.id)}" type="button">Delete</button>` : ""}</div></article>`;
          })
          .join("")
      : '<div class="empty card">No parent messages found.</div>';

    $$('[data-delete-message]').forEach((button) => {
      button.onclick = async () => {
        if (!confirm("Delete this draft message?")) return;
        button.disabled = true;
        try {
          await API.messageWrite("deleteMessage", { messageId: button.dataset.deleteMessage });
          toast("Draft deleted.", "success");
          await loadMessages();
        } catch (error) {
          toast(friendlyError(error), "error");
          button.disabled = false;
        }
      };
    });
  }

  async function loadMessages() {
    try {
      const data = await API.read("messages", { status: "" });
      const filter = $("#messageStatus")?.value || "";
      const all = (data.messages || []).filter((message) => message.recipient_type !== "staff");
      state.messages = filter ? all.filter((message) => displayStatus(message) === filter) : all;
      const drafts = all.filter((message) => ["draft", "cancelled", "skipped"].includes(displayStatus(message))).length;
      $("#deliverySummary").textContent = `${all.length} parent message${all.length === 1 ? "" : "s"} · ${drafts} draft${drafts === 1 ? "" : "s"} can be deleted.`;
      renderMessages();
    } catch (error) {
      toast(friendlyError(error), "error");
    }
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
        } else quoted = !quoted;
      } else if (character === delimiter && !quoted) {
        row.push(field.trim());
        field = "";
      } else if ((character === "\n" || character === "\r") && !quoted) {
        if (character === "\r" && source[index + 1] === "\n") index += 1;
        row.push(field.trim());
        if (row.some(Boolean)) rows.push(row);
        row = [];
        field = "";
      } else field += character;
    }
    row.push(field.trim());
    if (row.some(Boolean)) rows.push(row);
    if (rows.length < 2) return [];
    const headers = rows.shift().map((header) => header.trim());
    return rows.map((values) => {
      const result = {};
      headers.forEach((header, index) => { result[header] = values[index] || ""; });
      if (typeof result.preferredChannels === "string") {
        result.preferredChannels = result.preferredChannels.split(/[|;]/).map((value) => value.trim().toLowerCase()).filter(Boolean);
      }
      if (typeof result.isPrimary === "string") result.isPrimary = ["true", "1", "yes", "y"].includes(result.isPrimary.toLowerCase());
      return result;
    });
  }

  function renderImportPreview(result, rows = []) {
    const preview = $("#importPreviewCard");
    if (!preview) return;
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
          const matched = row.match_status === "matched";
          return `<div class="import-row ${matched ? "" : "invalid"}"><b>${escapeHtml(row.row_number || index + 2)}</b><span><strong>${escapeHtml(row.student_name || row.studentName || "Student")}</strong><small>${escapeHtml(row.student_admission_number || row.studentAdmissionNumber || "No admission number")}</small></span><span><strong>${escapeHtml(row.guardian_name || row.guardianName || "Guardian")}</strong><small>${escapeHtml(row.whatsapp_number || row.whatsappNumber || row.phone || "No WhatsApp number")}</small></span><span class="badge ${matched ? "ready" : "failed"}">${escapeHtml(errors.length ? errors.join(", ") : row.match_status || "staged")}</span></div>`;
        }).join("")
      : '<div class="empty-inline">No rows to preview.</div>';
  }

  async function importSource() {
    const pasted = $("#importText")?.value.trim();
    if (pasted) return { text: pasted, filename: "pasted-contacts.csv" };
    const file = $("#importFile")?.files?.[0];
    if (!file) return { text: "", filename: "" };
    return { text: await file.text(), filename: file.name };
  }

  async function validateImport() {
    const button = $("#validateImport");
    const classKey = $("#importClass")?.value || "";
    if (!classKey) return toast("Choose the class for these contacts first.", "error");
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      const source = await importSource();
      const rows = parseCsv(source.text);
      if (!rows.length) throw new Error("Choose a CSV file or paste a CSV with a header row and at least one contact.");
      state.importRows = rows;
      const result = await API.guardianImportWrite("validateBatch", {
        classKey,
        batchName: `${classNameFor(classKey)} guardian contacts`,
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
      $("#importResult").innerHTML = `<strong>Contacts checked</strong><br>${escapeHtml(result.valid_rows || 0)} row(s) can be saved to ${escapeHtml(classNameFor(classKey))}; ${escapeHtml(result.invalid_rows || 0)} row(s) need review.`;
      $("#applyImport").disabled = !(result.valid_rows > 0 && ["validated", "partially_valid"].includes(result.status));
      toast("Contact check complete.", "success");
    } catch (error) {
      $("#importResult").textContent = friendlyError(error);
      toast(friendlyError(error), "error");
    } finally {
      button.disabled = false;
      button.textContent = "Check contacts";
    }
  }

  async function applyImport() {
    if (!state.importBatchId) return;
    if (!confirm("Save the valid contacts for this class?")) return;
    const button = $("#applyImport");
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      const result = await API.guardianImportWrite("applyBatch", { batchId: state.importBatchId });
      $("#importResult").innerHTML = `<strong>Contacts saved</strong><br>${escapeHtml(result.applied_rows || 0)} row(s) saved · ${escapeHtml(result.failed_rows || 0)} issue(s) remain.`;
      toast("Contacts saved in WTS.", "success");
      await loadSummary();
      if ($("#composeClass")?.value === $("#importClass")?.value) await loadClassRecipients($("#composeClass").value);
    } catch (error) {
      toast(friendlyError(error), "error");
    } finally {
      button.disabled = false;
      button.textContent = "Save contacts";
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

  function showView(name) {
    if (!state.connected) return;
    $$(".view").forEach((section) => section.classList.toggle("active", section.id === `view-${name}`));
    $$(".nav").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
    const title = { overview: "Home", compose: "Send message", delivery: "Delivery reports" }[name] || "Home";
    const subtitle = {
      overview: "Send approved WhatsApp messages to parents.",
      compose: "Choose a template, choose a class, choose the parents.",
      delivery: "See sent, delivered, failed and draft messages.",
    }[name] || "Send approved WhatsApp messages to parents.";
    $("#title").textContent = title;
    $("#subtitle").textContent = subtitle;
    if (name === "compose") {
      renderSendRecipients();
      if ($("#composeClass")?.value) void loadClassRecipients($("#composeClass").value);
      renderSendState();
    }
    if (name === "delivery") void loadMessages();
  }

  $$(".nav").forEach((button) => { button.onclick = () => showView(button.dataset.view); });
  $$('[data-go]').forEach((button) => { button.onclick = () => showView(button.dataset.go); });
  $("#templateSelect").onchange = renderTemplatePreview;
  $("#composeClass").onchange = () => {
    state.selected.clear();
    void loadClassRecipients($("#composeClass").value, { resetSelection: true });
  };
  $$('input[name="audience"]').forEach((input) => { input.onchange = renderSendState; });
  $("#selectAllSend").onclick = () => {
    state.contacts.filter(isReady).forEach((contact) => state.selected.add(keyOf(contact)));
    renderSendRecipients();
    renderSendState();
  };
  $("#validateImport").onclick = validateImport;
  $("#applyImport").onclick = applyImport;
  $("#downloadImportTemplate").onclick = downloadImportTemplate;
  $("#importFile").onchange = async () => {
    const file = $("#importFile").files?.[0];
    if (file) $("#importText").value = await file.text();
  };
  $("#messageStatus").onchange = loadMessages;
  $("#clearDrafts").onclick = async () => {
    if (!confirm("Delete all draft messages? Sent and failed messages will stay.")) return;
    const button = $("#clearDrafts");
    button.disabled = true;
    try {
      const result = await API.messageWrite("deleteDrafts", {});
      toast(`${result.deleted || 0} draft message(s) deleted.`, "success");
      await loadMessages();
    } catch (error) {
      toast(friendlyError(error), "error");
    } finally {
      button.disabled = false;
    }
  };
  $("#refresh").onclick = () => loadSummary().catch((error) => {
    toast(friendlyError(error), "error");
    if (/AUTH|PERMISSION|session/i.test(String(error?.message || error))) returnToPortal();
  });
  $("#login").onclick = returnToPortal;
  $("#gateForm").onsubmit = (event) => {
    event.preventDefault();
    $("#authError").textContent = "Connecting…";
    if (window.WTS_NOTIFICATION_IDENTITY?.beginSso) void window.WTS_NOTIFICATION_IDENTITY.beginSso();
    else window.location.assign("/api/sso-start");
  };

  window.WTS_NOTIFY_UI = {
    toast,
    escapeHtml,
    classNameFor,
    childrenOf,
    keyOf,
    loadSummary,
    loadClasses,
    loadContacts: () => loadClassRecipients($("#composeClass")?.value || ""),
    loadMessages,
    renderTemplateSelect,
    renderTemplatePreview,
    selectedTemplate,
    setProviderData,
    showView,
  };

  setConnected(false);
})();
