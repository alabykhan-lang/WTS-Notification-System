import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const require = createRequire(import.meta.url);

test("the portal exposes a simple template, class and recipient workflow", async () => {
  const html = await read("index.html");
  const app = await read("app.js");
  const bulk = await read("bulk.js");
  const migration = await read("supabase/migrations/20260827080000_template_driven_notifications.sql");
  const multiClassMigration = await read("supabase/migrations/20260827123000_multi_class_parent_template_send.sql");
  assert.match(html, /Home/);
  assert.match(html, /Send message/);
  assert.match(html, /Delivery reports/);
  assert.match(html, /Choose a message template/);
  assert.match(html, /Choose the class/);
  assert.match(html, /All ready parents in this class/);
  assert.match(html, /Only the parents I select/);
  assert.match(html, /By class or section/);
  assert.match(html, /By parent/);
  assert.match(html, /Select parents and children/);
  assert.match(html, /Each parent appears once/);
  assert.match(html, /Import or update class contacts/);
  assert.match(html, /Sync all parents to Bahasha/);
  assert.doesNotMatch(html, /Message details/);
  assert.doesNotMatch(html, /Prepare parent messages/);
  assert.match(app, /recipientRead\("recipients"/);
  assert.match(app, /section:/);
  assert.match(app, /guardianImportWrite\("validateBatch"/);
  assert.match(app, /type: "guardian_group"/);
  assert.match(bulk, /selectedRecipients/);
  assert.match(bulk, /templateSend/);
  assert.match(app, /messageWrite\("deleteDrafts"/);
  assert.match(migration, /template_only/);
  assert.match(migration, /CLASS_REQUIRED/);
  assert.match(migration, /deleteDrafts/);
  assert.match(multiClassMigration, /v_class_key is null or s\.class_key = v_class_key/);
  assert.match(multiClassMigration, /next_term_resumption/);
  assert.match(multiClassMigration, /template_variables/);
});

test("template-only delivery never turns the template name into custom message text", () => {
  const source = require("node:fs").readFileSync(new URL("../api/_bahasha.js", import.meta.url), "utf8");
  assert.match(source, /message: payload\.template_only \? String\(payload\.custom_message \|\| ""\)/);
  assert.match(source, /BAHASHA_TEMPLATE_VARIABLE_INPUT_REQUIRED/);
});

test("Bahasha variables include the merged child context", () => {
  const previous = {
    token: process.env.BAHASHA_API_TOKEN,
    phone: process.env.BAHASHA_PHONE_NUMBER_ID,
  };
  process.env.BAHASHA_API_TOKEN = "bh_test_grouped";
  process.env.BAHASHA_PHONE_NUMBER_ID = "test-phone-id";
  const helper = require("../api/_bahasha.js");
  const message = helper.templateFor(
    {
      recipient_name: "Parent Group",
      message: "School announcement",
      payload: {
        purpose: "general_announcement",
        children_summary: "Student One (Primary 1), Student Two (Primary 3)",
      },
    },
    [
      {
        name: "wts_parent_notice",
        language: "en_US",
        status: "APPROVED",
        expected_variables: {
          body: [
            { param_name: "parent_name" },
            { param_name: "message" },
          ],
        },
      },
    ],
  );
  assert.match(message.variables.body.message, /Student One/);
  assert.match(message.variables.body.message, /Student Two/);
  if (previous.token === undefined) delete process.env.BAHASHA_API_TOKEN;
  else process.env.BAHASHA_API_TOKEN = previous.token;
  if (previous.phone === undefined) delete process.env.BAHASHA_PHONE_NUMBER_ID;
  else process.env.BAHASHA_PHONE_NUMBER_ID = previous.phone;
});

test("template-only delivery rejects a template that still needs manual message text", () => {
  const previous = {
    token: process.env.BAHASHA_API_TOKEN,
    phone: process.env.BAHASHA_PHONE_NUMBER_ID,
  };
  process.env.BAHASHA_API_TOKEN = "bh_test_grouped";
  process.env.BAHASHA_PHONE_NUMBER_ID = "test-phone-id";
  const helper = require("../api/_bahasha.js");
  assert.throws(
    () => helper.templateFor(
      {
        recipient_name: "Parent Group",
        message: "wts_parent_notice",
        payload: {
          template_only: true,
          children_summary: "Student One (Primary 1)",
        },
      },
      [
        {
          name: "wts_parent_notice",
          language: "en_US",
          status: "APPROVED",
          expected_variables: { body: [{ param_name: "message" }] },
        },
      ],
    ),
    (error) => error.code === "BAHASHA_TEMPLATE_VARIABLE_INPUT_REQUIRED",
  );
  if (previous.token === undefined) delete process.env.BAHASHA_API_TOKEN;
  else process.env.BAHASHA_API_TOKEN = previous.token;
  if (previous.phone === undefined) delete process.env.BAHASHA_PHONE_NUMBER_ID;
  else process.env.BAHASHA_PHONE_NUMBER_ID = previous.phone;
});

test("template-only delivery maps ward lists to the merged children automatically", () => {
  const previous = {
    token: process.env.BAHASHA_API_TOKEN,
    phone: process.env.BAHASHA_PHONE_NUMBER_ID,
  };
  process.env.BAHASHA_API_TOKEN = "bh_test_ward_list";
  process.env.BAHASHA_PHONE_NUMBER_ID = "test-phone-id";
  const helper = require("../api/_bahasha.js");
  const message = helper.templateFor(
    {
      recipient_name: "Parent Group",
      message: "wts_resumption_notice",
      payload: {
        template_only: true,
        whatsapp_template_name: "wts_resumption_notice",
        children_summary: "Student One (Primary 3), Student Two (Primary 3)",
      },
    },
    [
      {
        name: "wts_resumption_notice",
        language: "en_US",
        status: "APPROVED",
        expected_variables: { body: [{ param_name: "ward_list" }] },
      },
    ],
  );
  assert.equal(
    message.variables.body.ward_list,
    "Student One (Primary 3), Student Two (Primary 3)",
  );
  if (previous.token === undefined) delete process.env.BAHASHA_API_TOKEN;
  else process.env.BAHASHA_API_TOKEN = previous.token;
  if (previous.phone === undefined) delete process.env.BAHASHA_PHONE_NUMBER_ID;
  else process.env.BAHASHA_PHONE_NUMBER_ID = previous.phone;
});

test("template-only delivery formats the saved resumption date", () => {
  const previous = {
    token: process.env.BAHASHA_API_TOKEN,
    phone: process.env.BAHASHA_PHONE_NUMBER_ID,
  };
  process.env.BAHASHA_API_TOKEN = "bh_test_resumption_date";
  process.env.BAHASHA_PHONE_NUMBER_ID = "test-phone-id";
  const helper = require("../api/_bahasha.js");
  const message = helper.templateFor(
    {
      recipient_name: "Parent Group",
      message: "wts_resumption_notice",
      payload: {
        template_only: true,
        whatsapp_template_name: "wts_resumption_notice",
        children_summary: "Student One (Primary 3)",
        template_variables: { resumption_date: "2026-09-14" },
      },
    },
    [
      {
        name: "wts_resumption_notice",
        language: "en_US",
        status: "APPROVED",
        expected_variables: { body: [{ param_name: "resumption_date" }] },
      },
    ],
  );
  assert.equal(message.variables.body.resumption_date, "14 September 2026");
  if (previous.token === undefined) delete process.env.BAHASHA_API_TOKEN;
  else process.env.BAHASHA_API_TOKEN = previous.token;
  if (previous.phone === undefined) delete process.env.BAHASHA_PHONE_NUMBER_ID;
  else process.env.BAHASHA_PHONE_NUMBER_ID = previous.phone;
});
