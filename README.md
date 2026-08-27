# WTS Parent Notification System

A focused parent communication service for Way to Success Standard Schools, Ejigbo.

## Product boundary

- Recipients are parents/guardians only.
- Staff use the unified Staff Portal to operate the module, but staff are never offered as message recipients.
- WhatsApp is the delivery channel.
- An explicit WhatsApp opt-in is mandatory. Number verification is enforced when enabled in notification configuration.
- Message types are general announcements, attendance, fees, results/performance and emergencies.

## Parent contact model

Guardian imports are performed one class at a time. The import validator matches each row to one active student in the selected class before applying it through the Central Registry. Applying a batch updates both the canonical guardian relationship and the notification contact used by attendance and messaging.

The database intentionally keeps one child-level contact link per student. The parent directory and bulk sender group those links by the normalized WhatsApp destination. A class-scoped message includes only that class's child links; an all-school message includes all eligible child links on the destination. A group is eligible only when all links in the current scope are explicitly opted in (and, when configured, verified). This prevents duplicate sends without widening consent.

The resulting message payload keeps `group_key`, `member_ids`, `student_ids`, `children` and `children_summary`, so delivery history can show which children were included in one parent message.

## Access

The module uses the unified Staff Portal PKCE handoff. There is no separate administrator code or secret. The signed-in identity needs the active `notifications` grant and `notifications.manage` permission.

## Bahasha delivery architecture

1. WTS creates parent-only message records in the shared Supabase database.
2. `/api/bahasha-dispatch` claims queued records through the existing protected notification worker contract.
3. The Vercel Function calls `POST https://api.bahasha.app/v1/whatsapp/send` with an approved template.
4. `/api/bahasha-webhook` accepts Bahasha verification and delivery/reply events.
5. API keys remain in Vercel environment variables and are never sent to the browser.

`/api/bahasha-contacts-sync` is a separate management action. It reads eligible grouped parents from WTS, matches Bahasha Contacts by normalized number, and creates or updates contacts with WTS class tags and child-count attributes. It never sends a WhatsApp message.

Required Vercel environment variables:

```text
BAHASHA_API_KEY=bh_test_...          # use a sandbox key first
BAHASHA_PHONE_NUMBER_ID=...
BAHASHA_WEBHOOK_VERIFY_TOKEN=...
BAHASHA_TEMPLATE_MAP={...}           # optional overrides
```

Recommended approved template names:

```text
wts_parent_notice
wts_attendance_notice
wts_fee_notice
wts_result_notice
wts_emergency_notice
```

Use `bh_test_*` until template mapping and recipient selection are verified. A sandbox request consumes no credits and sends no real WhatsApp message. Switch to a `bh_live_*` key only after the sandbox flow passes.

## Template alignment

WTS has one internal catalogue for message purpose, language and variable mapping. Bahasha is the delivery template catalogue and Meta approval authority. The exact Bahasha template name, language and `APPROVED` status are used at send time; WTS does not create a second approval decision. The composer can pin an approved Bahasha template, while automatic purpose mappings remain in `BAHASHA_TEMPLATE_MAP`.

The navigation follows the operating sequence: `Overview` → `Import by class` → `Parents` → `Send message` → `Templates` → `Delivery`.

Webhook URL:

```text
https://wts-notification-system.vercel.app/api/bahasha-webhook
```

The older Meta routes remain temporarily as a rollback path while Bahasha is being commissioned; the new interface does not use them. The repository contains a separate migration to replace the stale Meta cron job with the protected Bahasha worker; it should be applied only when production worker scheduling is explicitly approved.
