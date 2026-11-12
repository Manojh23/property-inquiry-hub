# Property Inquiry Hub

A full-stack demo for a company that operates several hospitality properties. A customer submits an inquiry from a property page. Staff see it in one inbox, assign follow-up, see overdue work, and can check whether it made it to the CRM. The app ships with a fictional hotel, marina, and restaurant. Use sample inquiries only.

## Try it

Requires Node.js 24 and PostgreSQL. With Docker:

```sh
docker compose up -d postgres
cp .env.example .env
npm ci
npm run build
npm start
```

Open http://127.0.0.1:3000/?property=harbor-inn&utm_source=newsletter&utm_campaign=summer. Use an address such as guest@example.test and submit an inquiry. In **Staff**, use the token in your local .env to filter the inbox, assign an owner and deadline, and open the activity history. Try setting a past deadline and switching the follow-up queue to **Overdue**. You can also review campaign counts and save or publish property copy. CRM mode is demo by default; it makes no external calls. The worker checks for queued jobs every three seconds. The staff view also offers **Run one sync** and **Refresh**.

## What it implements

- **React and TypeScript:** Responsive property landing pages, accessible inquiry forms, a staff inbox, campaign reporting, and draft/publish controls.
- **Follow-up queue:** New inquiries start with a 24-hour follow-up deadline. Staff can assign an owner, revise the deadline, and filter by property, overdue status, or unassigned status. The activity log records intake, stage changes, and follow-up changes. Closing an inquiry removes it from the overdue queue. Owner names are assignments, not user accounts.
- **Express and PostgreSQL:** A transaction saves the inquiry and its CRM job together. Repeating an identical request with the same ID returns the existing inquiry. Reusing that ID with changed details returns a conflict.
- **CRM integration:** A background worker claims jobs with row locks and time-limited leases. It retries transient failures, respects HubSpot's retry hint within a 24-hour cap, and lets staff requeue failed jobs. The adapter finds or creates a contact by email and a deal by inquiry UUID, then associates them. Existing CRM contact and deal fields are left intact on retry.
- **Campaign tracking:** Persists standard UTM fields on submission and groups inquiry counts by property, source, and campaign. It counts completed inquiries; it does not track visitors or calculate conversion rates.
- **Content management and SEO:** Staff save edits as drafts and publish them without restarting the app. Property landing URLs return a page title, a meta description, and Schema.org JSON-LD in the initial HTML.

## Connect a HubSpot test account

Create a custom **deal** property named property_hub_inquiry_id, of type string, and enable unique values. Set CRM_MODE=hubspot, HUBSPOT_TOKEN, HUBSPOT_PIPELINE_ID, and HUBSPOT_DEAL_STAGE_ID. Set HUBSPOT_DEAL_ID_PROPERTY only if you used a different internal name. The token needs read/write access to contacts and deals. The app performs CRM writes when this mode is enabled; use a test account and synthetic inquiries.

This is a local portfolio demo. The staff token controls access to one shared workspace, with no per-user or property permissions. Staff stage changes remain local and do not update the HubSpot deal stage. The live adapter is covered by simulated HTTP responses; it has not been run against a real HubSpot account.

## Verify

```sh
npm run build
TEST_DATABASE_URL=postgres://property:property@127.0.0.1:5432/property_hub npm test
```

The database tests use isolated schemas. They cover duplicate submissions, CRM retries, staff follow-up, content publishing, and upgrading an existing database without losing inquiries or CRM job data. Without TEST_DATABASE_URL, only the adapter tests run. The startup migration runner applies each numbered SQL file once and uses a transaction lock to serialize concurrent startups.
