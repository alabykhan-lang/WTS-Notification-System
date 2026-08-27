import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const require = createRequire(import.meta.url);

test("the portal exposes class-scoped parent groups and imports", async () => {
  const html = await read("index.html");
  const app = await read("app.js");
  const bulk = await read("bulk.js");
  const migration = await read("supabase/migrations/20260826090000_grouped_parent_notifications.sql");
  assert.match(html, /Import by class/);
  assert.match(html, /Parent groups by class/);
  assert.match(html, /All eligible parent groups/);
  assert.match(app, /classKey: \$\("#contactClass"\)\.value/);
  assert.match(app, /guardianImportWrite\("validateBatch"/);
  assert.match(bulk, /type: "guardian_group"/);
  assert.match(migration, /group_key/);
  assert.match(migration, /class_mismatch_rows/);
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
