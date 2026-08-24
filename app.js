"use strict";

(() => {
  const API = window.WTS_NOTIFY_API;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const state = (window.WTS_NOTIFY_STATE = {
    summary: null,
    contacts: [],
    messages: [],
    selected: new Set(),
    connected: false,
  });

  const escapeHtml = (value) =>
    String(value ?? "").replace(
      /[&<>'\"]/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          "'": "&#39;",
          '"': "&quot;",
        })[character],
    );

  function toast(message, type = "") {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = message;
    $("#toasts").append(node);
    setTimeout(() => node.remove(), 4300);
  }

  window.WTS_NOTIFY_UI = {
    toast,
    escapeHtml,
    loadSummary,
    loadContacts,
    loadMessages,
  };

  function keyOf(contact) {
    return `guardian:${contact.recipient_id}`;
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
    if ($("#authError")) $("#authError").textContent = message;
  }

  function returnToPortal() {
    API.clearAuth();
    state.contacts = [];
    state.messages = [];
    state.selected.clear();
    setConnected(false);
    window.location.assign(`${window.WTS_CONFIG.portalOrigin}/workspace`);
  }

  function showView(name) {
    if (!state.connected) return;
    $$(".view").forEach((section) =>
      section.classList.toggle("active", section.id === `view-${name}`),
    );
    $$(".nav").forEach((button) =>
      button.classList.toggle("active", button.dataset.view === name),
    );
    $("#title").textContent =
      name === "contacts"
        ? "Parent contacts"
        : name === "delivery"
          ? "Message delivery"
          : "Parent communication";
    if (name === "contacts") void loadContacts();
    if (name === "delivery") void loadMessages();
  }

  async function loadSummary() {
    const [summary, recipients] = await Promise.all([
      API.read("summary"),
      API.recipientRead("summary"),
    ]);
    state.summary = summary;
    const parents = recipients.guardians || {};
    $("#mContacts").textContent = parents.total || 0;
    $("#mOptin").textContent = parents.opted_in || 0;
    $("#mDelivered").textContent =
      summary.messages?.delivered || summary.messages?.sent || 0;
    $("#mFailed").textContent = summary.messages?.failed || 0;
    setConnected(true);
  }

  async function loadContacts() {
    try {
      const data = await API.recipientRead("recipients", {
        search: $("#contactSearch").value.trim(),
        recipientType: "guardian",
        status: $("#contactStatus").value,
        pilotOnly: false,
      });
      state.contacts = (data.recipients || []).filter(
        (contact) => contact.recipient_type !== "staff",
      );
      $("#contactEmpty").style.display = state.contacts.length
        ? "none"
        : "block";
      $("#contactRows").innerHTML = state.contacts
        .map((contact) => {
          const key = keyOf(contact);
          return `<tr>
          <td><input type="checkbox" data-contact="${escapeHtml(key)}" ${state.selected.has(key) ? "checked" : ""}></td>
          <td><strong>${escapeHtml(contact.display_name)}</strong></td>
          <td>${escapeHtml(contact.associated_name || "—")}<small>${escapeHtml(contact.group_name || "")} ${escapeHtml(contact.reference_number || "")}</small></td>
          <td>${escapeHtml(contact.whatsapp_number || "—")}</td>
          <td><span class="badge ${escapeHtml(contact.consent_status)}">${escapeHtml(contact.consent_status)}</span></td>
          <td>${contact.verified ? "Yes" : "No"}</td>
          <td><button class="ghost compact" data-edit-recipient="${escapeHtml(key)}">Edit</button></td>
        </tr>`;
        })
        .join("");

      $$("[data-contact]").forEach((checkbox) => {
        checkbox.onchange = () =>
          checkbox.checked
            ? state.selected.add(checkbox.dataset.contact)
            : state.selected.delete(checkbox.dataset.contact);
      });
      $$("[data-edit-recipient]").forEach((button) => {
        button.onclick = () =>
          openRecipient(
            state.contacts.find(
              (contact) => keyOf(contact) === button.dataset.editRecipient,
            ),
          );
      });
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function openRecipient(contact) {
    if (!contact) return;
    $("#recipientTitle").textContent =
      `Parent contact: ${contact.display_name}`;
    $("#recipientId").value = contact.recipient_id;
    $("#recipientWhatsapp").value = contact.whatsapp_number || "";
    $("#recipientConsent").value = contact.consent_status || "pending";
    $("#recipientConsentSource").value = "";
    $("#recipientVerified").checked = Boolean(contact.verified);
    $("#recipientDialog").showModal();
  }

  async function saveRecipient(event) {
    event.preventDefault();
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
      toast("Parent contact saved.", "success");
      await Promise.all([loadContacts(), loadSummary()]);
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function loadMessages() {
    try {
      const data = await API.read("messages", {
        status: $("#messageStatus").value,
      });
      state.messages = (data.messages || []).filter(
        (message) => message.recipient_type !== "staff",
      );
      $("#messageList").innerHTML = state.messages.length
        ? state.messages
            .map(
              (message) => `<article class="message">
            <div class="message-head"><div><strong>${escapeHtml(message.recipient_name || "Parent")}</strong><small>${escapeHtml(message.source_system || "WTS")} · WhatsApp · ${escapeHtml(message.destination_masked || "")}</small></div><span class="badge ${escapeHtml(message.status)}">${escapeHtml(message.status)}</span></div>
            <p>${escapeHtml(message.message)}</p>
            <small>${new Date(message.created_at).toLocaleString("en-NG")}${message.last_error ? ` · ${escapeHtml(message.last_error)}` : ""}</small>
          </article>`,
            )
            .join("")
        : '<div class="empty card">No parent messages found.</div>';
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function prepareAttendance() {
    const attendanceDate = prompt(
      "Attendance date (YYYY-MM-DD)",
      new Date().toISOString().slice(0, 10),
    );
    if (!attendanceDate) return;
    const academicSession = prompt("Academic session", "2026/2027");
    if (!academicSession) return;
    try {
      const result = await API.write("prepareAttendanceDrafts", {
        attendanceDate,
        academicSession,
      });
      toast(
        `${result.draft_operations || 0} parent attendance alert(s) prepared.`,
        "success",
      );
      await loadSummary();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  $$(".nav").forEach((button) => {
    button.onclick = () => showView(button.dataset.view);
  });
  $("#contactFind").onclick = loadContacts;
  $("#contactStatus").onchange = loadContacts;
  $("#selectAll").onclick = () => {
    state.contacts.forEach((contact) => state.selected.add(keyOf(contact)));
    void loadContacts();
  };
  $("#recipientForm").onsubmit = saveRecipient;
  $("#prepareAttendance").onclick = prepareAttendance;
  $("#messageStatus").onchange = loadMessages;
  $("#refresh").onclick = () =>
    loadSummary().catch((error) => {
      toast(error.message, "error");
      if (/AUTH|PERMISSION|login/i.test(error.message)) returnToPortal();
    });
  $("#login").onclick = returnToPortal;
  $("#gateForm").onsubmit = (event) => {
    event.preventDefault();
    $("#authError").textContent = "Connecting…";
    if (window.WTS_NOTIFICATION_IDENTITY?.beginSso) {
      void window.WTS_NOTIFICATION_IDENTITY.beginSso();
      return;
    }
    window.location.assign("/api/sso-start");
  };

  setConnected(false);
})();
