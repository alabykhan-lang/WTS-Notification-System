# WTS Parent Notification System

A focused parent communication service for Way to Success Standard Schools, Ejigbo.

## Product boundary

- Recipients are parents/guardians only.
- Staff use the unified Staff Portal to operate the module, but staff are never offered as message recipients.
- WhatsApp is the delivery channel.
- Parent consent and number verification remain mandatory.
- Message types are general announcements, attendance, fees, results/performance and emergencies.

## Access

The module uses the unified Staff Portal PKCE handoff. There is no separate administrator code or secret. The signed-in identity needs the active `notifications` grant and `notifications.manage` permission.

## Bahasha delivery architecture

1. WTS creates parent-only message records in the shared Supabase database.
2. `/api/bahasha-dispatch` claims queued records through the existing protected notification worker contract.
3. The Vercel Function calls `POST https://api.bahasha.app/v1/whatsapp/send` with an approved template.
4. `/api/bahasha-webhook` accepts Bahasha verification and delivery/reply events.
5. API keys remain in Vercel environment variables and are never sent to the browser.

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

Webhook URL:

```text
https://wts-notification-system.vercel.app/api/bahasha-webhook
```

The older Meta routes remain temporarily as a rollback path while Bahasha is being commissioned; the new interface does not use them.
