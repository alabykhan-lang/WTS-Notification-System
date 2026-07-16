# WTS Notification System

Standalone WhatsApp and SMS notification management for Way to Success Standard Schools, Ejigbo.

Production capabilities include:

- parent and guardian contacts from the Central Registry;
- explicit WhatsApp consent and number verification;
- automatic attendance alert drafts;
- bulk WhatsApp and SMS messaging;
- English, Yoruba and bilingual templates;
- message and delivery status tracking;
- one shared WTS Supabase database.

## Delivery architecture

Real WhatsApp delivery uses one controlled path:

1. message records and encrypted Meta credentials remain in Supabase;
2. credentials are read from Supabase Vault only by protected server functions;
3. the Vercel `/api/meta-dispatch` route claims and sends queued messages;
4. a Supabase scheduled job calls that route with a private worker token;
5. Meta webhook updates are recorded through `/api/meta-webhook`.

The older Supabase Edge Function is retained only as a compatibility proxy and no longer sends directly through Meta environment variables.

## Live activation safeguards

Live WhatsApp delivery remains blocked until all of the following are true:

- Meta phone, business account, access token and webhook secrets are configured;
- a real test message has passed;
- at least one internal WhatsApp template has been submitted and approved by Meta;
- at least one pilot parent or staff recipient is opted in and verified.

Automatic attendance draft creation remains a separate management setting and is not enabled merely by connecting Meta.
