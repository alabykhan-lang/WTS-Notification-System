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
  assert.match(html, /Home/);
  assert.match(html, /Send message/);
  assert.match(html, /Delivery reports/);
  assert.match(html, /Choose a message template/);
  assert.match(html, /Choose the class/);
  assert.match(html, /All ready parents in this class/);
  assert.match(html, /Only the parents I select/);
  assert.match(html, /Import or update class contacts/);
  assert.doesNotMatch(html, /Message details/);
  assert.doesNotMatch(html, /Prepare parent messages/);
  assert.match(app, /recipientRead\("recipients"/);
  assert.match(app, /guardianImportWrite\("validateBatch"/);
  assert.match(bulk, /type: "guardian_group"/);
  assert.match(bulk, /templateSend/);
  assert.match(app, /messageWrite\("deleteDrafts"/);
  assert.match(migration, /template_only/);
  assert.match(migration, /CLASS_REQUIRED/);
  assert.match(migration, /deleteDrafts/);
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
