import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { makeApp } from "../src/app.js";
import { CRMError, syncNext, type CRM } from "../src/crm.js";
import { migrate } from "../src/migrate.js";

test(
  "landing page inquiry reaches staff, conversion reports and retry-safe CRM queue",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = "test_" + randomUUID().replaceAll("-", "");
    const isolated = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: "-c search_path=" + schema,
    });
    await db.query("CREATE SCHEMA " + schema);
    let crmCalls = 0;
    const crm: CRM = async () => {
      crmCalls++;
      if (crmCalls === 1) throw new CRMError(429, 30);
      return { contactId: "101", dealId: "202" };
    };
    const server = makeApp(isolated, crm, "local-test-staff-token").listen(
      0,
      "127.0.0.1",
    );
    try {
      await migrate(isolated);
      await migrate(isolated);
      if (!server.listening) await once(server, "listening");
      const base =
        "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api";
      const req = (
        path: string,
        method = "GET",
        body?: unknown,
        staff = false,
      ) =>
        fetch(base + path, {
          method,
          headers: {
            "content-type": "application/json",
            ...(staff
              ? { authorization: "Bearer local-test-staff-token" }
              : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      assert.equal((await req("/staff/inquiries")).status, 401);
      const data = {
        propertySlug: "harbor-inn",
        name: "Demo Guest",
        email: "guest@example.test",
        message: "Group stay",
        campaign: { utm_source: "newsletter", utm_campaign: "summer" },
        requestKey: randomUUID(),
      };
      const responses = await Promise.all([
        req("/inquiries", "POST", data),
        req("/inquiries", "POST", data),
      ]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
      const ids = await Promise.all(responses.map((r) => r.json()));
      assert.equal(ids[0].id, ids[1].id);
      assert.equal(
        (
          await req("/inquiries", "POST", {
            ...data,
            message: "Changed request",
          })
        ).status,
        409,
      );
      const id = ids[0].id;
      const staff = async (path: string, method = "GET", body?: unknown) =>
        (await req("/staff" + path, method, body, true)).json();
      assert.equal(
        (await staff("/inquiries?property=harbor-inn")).inquiries.length,
        1,
      );
      assert.deepEqual(await staff("/conversions"), [
        {
          property_slug: "harbor-inn",
          source: "newsletter",
          campaign: "summer",
          submissions: 1,
        },
      ]);
      assert.equal(
        (await staff("/inquiries/" + id, "PATCH", { stage: "contacted" }))
          .stage,
        "contacted",
      );
      assert.equal(await syncNext(isolated, crm), "retry");
      assert.equal(await syncNext(isolated, crm), null);
      assert.equal(
        (await staff("/inquiries/" + id + "/retry", "POST")).ok,
        true,
      );
      const jobs = await Promise.all([
        syncNext(isolated, crm),
        syncNext(isolated, crm),
      ]);
      assert.deepEqual(jobs.sort(), [null, "synced"].sort());
      assert.equal(crmCalls, 2);
      const item = (await staff("/inquiries")).inquiries[0];
      assert.equal(item.crm_status, "synced");
      assert.equal(item.deal_id, "202");
      assert.equal(item.owner, null);
      assert.ok(item.follow_up_at);
      assert.equal(
        (await staff("/inquiries?view=unassigned")).inquiries.length,
        1,
      );
      assert.equal(
        (await staff("/inquiries?view=overdue")).inquiries.length,
        0,
      );
      const overdue = { owner: "Harbor sales", dueAt: "2025-05-12T13:00:00Z" };
      assert.equal(
        (await staff("/inquiries/" + id + "/follow-up", "PUT", overdue)).owner,
        "Harbor sales",
      );
      await staff("/inquiries/" + id + "/follow-up", "PUT", overdue);
      assert.equal(
        (await staff("/inquiries?view=unassigned")).inquiries.length,
        0,
      );
      assert.equal(
        (await staff("/inquiries?view=overdue")).inquiries[0].id,
        id,
      );
      let events = await staff("/inquiries/" + id + "/activity");
      assert.deepEqual(
        events.map((e: { kind: string }) => e.kind),
        ["follow_up", "stage", "received"],
      );
      assert.equal(events[0].details.owner, "Harbor sales");
      await staff("/inquiries/" + id, "PATCH", { stage: "closed" });
      assert.equal(
        (await staff("/inquiries?view=overdue")).inquiries.length,
        0,
      );
      events = await staff("/inquiries/" + id + "/activity");
      assert.equal(events[0].details.stage, "closed");
      const getHeadline = async () =>
        (
          (await (await req("/properties")).json()) as {
            slug: string;
            headline: string;
          }[]
        ).find((x) => x.slug === "harbor-inn")?.headline;
      const old = await getHeadline();
      assert.equal(
        (
          await staff("/content/harbor-inn", "PUT", {
            headline: "New waterfront copy",
            blurb: "A new welcome.",
          })
        ).ok,
        true,
      );
      assert.equal(await getHeadline(), old);
      assert.equal(
        (await staff("/content/harbor-inn/publish", "POST")).ok,
        true,
      );
      assert.equal(await getHeadline(), "New waterfront copy");
      const landing = await fetch(
        base.replace(/\/api$/, "") + "/?property=harbor-inn",
      );
      assert.equal(landing.status, 200);
      const html = await landing.text();
      assert.match(
        html,
        /<title>Harbor House Inn [|] Property Inquiry Hub<\/title>/,
      );
      assert.match(html, /"@type":"Hotel"/);
      const malicious = 'A </script><script>unsafe()</script> & quote " demo';
      await staff("/content/harbor-inn", "PUT", {
        headline: "New waterfront copy",
        blurb: malicious,
      });
      await staff("/content/harbor-inn/publish", "POST");
      const escaped = await (
        await fetch(base.replace(/\/api$/, "") + "/?property=harbor-inn")
      ).text();
      assert.doesNotMatch(escaped, /<script>unsafe/);
      assert.match(escaped, /&lt;\/script&gt;/);
    } finally {
      server.close();
      await once(server, "close");
      await isolated.end();
      await db.query("DROP SCHEMA " + schema + " CASCADE");
      await db.end();
    }
  },
);

test(
  "migrations preserve existing inquiries and CRM jobs when upgrading",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const conn = process.env.TEST_DATABASE_URL;
    const db = new pg.Pool({ connectionString: conn });
    const schema = "upgrade_" + randomUUID().replaceAll("-", "");
    await db.query("CREATE SCHEMA " + schema);
    const isolated = new pg.Pool({
      connectionString: conn,
      options: "-c search_path=" + schema,
    });
    try {
      await isolated.query(
        await readFile(new URL("../db/001.sql", import.meta.url), "utf8"),
      );
      const id = randomUUID();
      await isolated.query(
        `INSERT INTO inquiries(id,property_slug,name,email,message,request_key,request_hash)
      VALUES($1,'harbor-inn','Demo','demo@example.test','Original inquiry',$2,'original')`,
        [id, randomUUID()],
      );
      await isolated.query(
        "INSERT INTO crm_jobs(inquiry_id,status,deal_id) VALUES($1,'synced','301')",
        [id],
      );
      await Promise.all([migrate(isolated), migrate(isolated)]);
      const row = (
        await isolated.query(
          "SELECT i.message,i.follow_up_at,j.deal_id FROM inquiries i JOIN crm_jobs j ON j.inquiry_id=i.id WHERE i.id=$1",
          [id],
        )
      ).rows[0];
      assert.equal(row.message, "Original inquiry");
      assert.equal(row.deal_id, "301");
      assert.ok(row.follow_up_at);
      assert.equal(
        (
          await isolated.query(
            "SELECT 1 FROM inquiry_events WHERE inquiry_id=$1",
            [id],
          )
        ).rowCount,
        1,
      );
    } finally {
      await isolated.end();
      await db.query("DROP SCHEMA " + schema + " CASCADE");
      await db.end();
    }
  },
);
