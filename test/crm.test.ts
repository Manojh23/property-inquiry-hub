import test from "node:test";
import assert from "node:assert/strict";
import { hubspotCRM, CRMError } from "../src/crm.js";
const lead = {
  id: "00000000-0000-4000-8000-000000000001",
  property_slug: "harbor-inn",
  name: "Demo Guest",
  email: "guest@example.test",
  message: "Group stay",
  campaign: { utm_source: "newsletter" },
};
const config = {
  token: "local-fake-token",
  pipeline: "pipeline",
  stage: "stage",
  keyProperty: "property_hub_inquiry_id",
};
test("HubSpot adapter looks up unique IDs, creates missing records, then associates them", async () => {
  const calls: Array<{ url: string; method?: string; body: any }> = [];
  const replies = [
    new Response(null, { status: 404 }),
    Response.json({ id: "21" }),
    new Response(null, { status: 404 }),
    Response.json({ id: "39" }),
    new Response(null, { status: 204 }),
  ];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method,
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "Bearer local-fake-token",
    );
    return replies.shift()!;
  }) as typeof fetch;
  assert.deepEqual(await hubspotCRM(config, fake)(lead), {
    contactId: "21",
    dealId: "39",
  });
  assert.match(calls[0].url, /guest%40example.test\?idProperty=email/);
  assert.equal(calls[1].body.properties.email, lead.email);
  assert.equal(calls[3].body.properties.property_hub_inquiry_id, lead.id);
  assert.match(calls[3].body.properties.description, /utm_source=newsletter/);
  assert.equal(calls[4].method, "PUT");
  assert.match(calls[4].url, /deals\/39\/associations\/default\/contacts\/21$/);
});
test("retry reuses existing contacts and deals and preserves CRM-owned fields", async () => {
  const methods: string[] = [];
  const replies = [
    Response.json({ id: "21" }),
    Response.json({ id: "39" }),
    new Response(null, { status: 204 }),
  ];
  const fake = (async (_url: string, init: RequestInit) => {
    methods.push(init.method!);
    return replies.shift()!;
  }) as typeof fetch;
  assert.deepEqual(await hubspotCRM(config, fake)(lead), {
    contactId: "21",
    dealId: "39",
  });
  assert.deepEqual(methods, ["GET", "GET", "PUT"]);
});
test("adapter reports rate limits without leaking request data", async () => {
  const fake = (async () =>
    new Response(null, {
      status: 429,
      headers: { "retry-after": "30" },
    })) as typeof fetch;
  await assert.rejects(
    hubspotCRM(config, fake)(lead),
    (e) => e instanceof CRMError && e.status === 429 && e.retrySeconds === 30,
  );
});
