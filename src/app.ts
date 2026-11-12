import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { Pool } from "pg";
import { syncNext, type CRM } from "./crm.js";

const slug = z.string().regex(/^[a-z0-9-]{1,60}$/);
const text = (n: number) => z.string().trim().min(1).max(n);
const campaign = z
  .strictObject(
    Object.fromEntries(
      [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
      ].map((key) => [key, text(100).optional()]),
    ),
  )
  .default({});
const intake = z.strictObject({
  propertySlug: slug,
  name: text(100),
  email: z
    .email()
    .max(254)
    .transform((x) => x.toLowerCase()),
  message: text(2000),
  campaign,
  requestKey: z.uuid(),
});
const stage = z.enum(["new", "contacted", "closed"]);
const followUp = z.strictObject({
  owner: text(100).nullable(),
  dueAt: z.iso.datetime({ offset: true }).nullable(),
});
const draft = z.strictObject({ headline: text(100), blurb: text(600) });
const hash = (x: string) => createHash("sha256").update(x).digest();
const validToken = (expected: string, actual: string) =>
  timingSafeEqual(hash(expected), hash(actual));
const escapeHTML = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export function makeApp(db: Pool, crm: CRM, token: string, mode = "demo") {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.use("/api/staff", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const actual = req.get("authorization") || "";
    if (!validToken("Bearer " + token, actual)) {
      res.status(401).json({ error: "Enter a valid staff token." });
      return;
    }
    next();
  });
  app.get("/api/properties", async (_req, res) => {
    res.json(
      (
        await db.query(
          "SELECT slug,name,category,city,headline,blurb FROM properties ORDER BY name",
        )
      ).rows,
    );
  });
  app.post("/api/inquiries", async (req, res) => {
    const { requestKey, propertySlug, name, email, message, campaign } =
      intake.parse(req.body);
    const fingerprint = hash(
      JSON.stringify([
        propertySlug,
        name,
        email,
        message,
        Object.entries(campaign).sort(),
      ]),
    ).toString("hex");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      if (
        !(
          await client.query("SELECT 1 FROM properties WHERE slug=$1", [
            propertySlug,
          ])
        ).rowCount
      ) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Property not found." });
        return;
      }
      const id = randomUUID();
      const insert = await client.query(
        `INSERT INTO inquiries(id,property_slug,name,email,message,campaign,request_key,request_hash,follow_up_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '24 hours') ON CONFLICT(request_key) DO NOTHING RETURNING id`,
        [
          id,
          propertySlug,
          name,
          email,
          message,
          JSON.stringify(campaign),
          requestKey,
          fingerprint,
        ],
      );
      if (insert.rowCount) {
        await client.query("INSERT INTO crm_jobs(inquiry_id) VALUES ($1)", [
          id,
        ]);
        await client.query(
          "INSERT INTO inquiry_events(inquiry_id,kind,details) VALUES ($1,'received',jsonb_build_object('property',$2::text))",
          [id, propertySlug],
        );
        await client.query("COMMIT");
        res.status(201).json({ id });
        return;
      }
      const existing = (
        await client.query(
          "SELECT id,request_hash FROM inquiries WHERE request_key=$1",
          [requestKey],
        )
      ).rows[0];
      await client.query("COMMIT");
      if (existing.request_hash !== fingerprint) {
        res.status(409).json({
          error: "Request key already used for different inquiry details.",
        });
        return;
      }
      res.json({ id: existing.id });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
  app.get("/api/staff/inquiries", async (req, res) => {
    const filter =
      req.query.property === undefined ? null : slug.parse(req.query.property);
    const view = z
      .enum(["all", "overdue", "unassigned"])
      .default("all")
      .parse(req.query.view);
    const rows = (
      await db.query(
        `SELECT i.id,i.property_slug,i.name,i.email,i.message,i.campaign,i.stage,i.created_at,i.owner,i.follow_up_at,
      coalesce(i.stage<>'closed' AND i.follow_up_at<=now(),false) AS overdue,
      j.status AS crm_status,j.last_error,j.deal_id FROM inquiries i JOIN crm_jobs j ON j.inquiry_id=i.id
      WHERE ($1::text IS NULL OR property_slug=$1)
      AND ($2='all' OR ($2='unassigned' AND i.owner IS NULL AND i.stage<>'closed')
        OR ($2='overdue' AND i.stage<>'closed' AND i.follow_up_at<=now()))
      ORDER BY overdue DESC,i.created_at DESC,i.id LIMIT 100`,
        [filter, view],
      )
    ).rows;
    res.json({ mode, inquiries: rows });
  });
  app.get("/api/staff/conversions", async (_req, res) => {
    res.json(
      (
        await db.query(`SELECT property_slug,coalesce(campaign->>'utm_source','direct') AS source,
      coalesce(campaign->>'utm_campaign','unattributed') AS campaign,count(*)::int AS submissions
      FROM inquiries GROUP BY 1,2,3 ORDER BY submissions DESC,1,2,3 LIMIT 100`)
      ).rows,
    );
  });
  app.patch("/api/staff/inquiries/:id", async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const next = stage.parse(req.body?.stage);
    const r = await db.query(
      `WITH changed AS (
        UPDATE inquiries SET stage=$2 WHERE id=$1 AND stage<>$2 RETURNING id,stage
      ), logged AS (
        INSERT INTO inquiry_events(inquiry_id,kind,details)
        SELECT id,'stage',jsonb_build_object('stage',stage) FROM changed
      ) SELECT stage FROM changed UNION ALL SELECT stage FROM inquiries
        WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM changed)`,
      [id, next],
    );
    res
      .status(r.rowCount ? 200 : 404)
      .json(r.rows[0] || { error: "Inquiry not found." });
  });
  app.put("/api/staff/inquiries/:id/follow-up", async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const { owner, dueAt } = followUp.parse(req.body);
    const r = await db.query(
      `WITH changed AS (
        UPDATE inquiries SET owner=$2,follow_up_at=$3 WHERE id=$1
          AND (owner IS DISTINCT FROM $2 OR follow_up_at IS DISTINCT FROM $3::timestamptz)
        RETURNING id,owner,follow_up_at
      ), logged AS (
        INSERT INTO inquiry_events(inquiry_id,kind,details)
        SELECT id,'follow_up',jsonb_build_object('owner',owner,'dueAt',follow_up_at) FROM changed
      ) SELECT owner,follow_up_at FROM changed UNION ALL SELECT owner,follow_up_at FROM inquiries
        WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM changed)`,
      [id, owner, dueAt],
    );
    res
      .status(r.rowCount ? 200 : 404)
      .json(r.rows[0] || { error: "Inquiry not found." });
  });
  app.get("/api/staff/inquiries/:id/activity", async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const result = await db.query(
      "SELECT id,kind,details,created_at FROM inquiry_events WHERE inquiry_id=$1 ORDER BY id DESC LIMIT 50",
      [id],
    );
    if (!result.rowCount) {
      res.status(404).json({ error: "Inquiry not found." });
      return;
    }
    res.json(result.rows);
  });
  app.post("/api/staff/inquiries/:id/retry", async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const r = await db.query(
      `UPDATE crm_jobs SET status='pending',attempts=0,next_attempt=now(),last_error=NULL
      WHERE inquiry_id=$1 AND status IN ('retry','failed')`,
      [id],
    );
    res
      .status(r.rowCount ? 200 : 409)
      .json(
        r.rowCount
          ? { ok: true }
          : { error: "Only failed or waiting jobs can be retried." },
      );
  });
  app.post("/api/staff/sync", async (_req, res) => {
    res.json({ status: (await syncNext(db, crm)) || "empty" });
  });
  app.get("/api/staff/content", async (_req, res) => {
    res.json(
      (
        await db.query(
          "SELECT slug,headline,blurb,draft_headline,draft_blurb FROM properties ORDER BY slug",
        )
      ).rows,
    );
  });
  app.put("/api/staff/content/:slug", async (req, res) => {
    const copy = draft.parse(req.body);
    const r = await db.query(
      "UPDATE properties SET draft_headline=$2,draft_blurb=$3 WHERE slug=$1",
      [slug.parse(req.params.slug), copy.headline, copy.blurb],
    );
    res
      .status(r.rowCount ? 200 : 404)
      .json(r.rowCount ? { ok: true } : { error: "Property not found." });
  });
  app.post("/api/staff/content/:slug/publish", async (req, res) => {
    const r = await db.query(
      `UPDATE properties SET headline=draft_headline,blurb=draft_blurb,
      draft_headline=NULL,draft_blurb=NULL WHERE slug=$1 AND draft_headline IS NOT NULL AND draft_blurb IS NOT NULL`,
      [slug.parse(req.params.slug)],
    );
    res
      .status(r.rowCount ? 200 : 409)
      .json(
        r.rowCount
          ? { ok: true }
          : { error: "Save a draft before publishing." },
      );
  });
  app.use("/api", ((_req, res) => {
    res.status(404).json({ error: "API route not found." });
  }) as RequestHandler);
  app.get("/", async (req, res) => {
    const html = await readFile(resolve("dist/index.html"), "utf8");
    const property = slug.safeParse(req.query.property);
    if (!property.success) {
      res.type("html").send(html);
      return;
    }
    const { rows } = await db.query(
      "SELECT name,category,city,headline,blurb FROM properties WHERE slug=$1",
      [property.data],
    );
    const item = rows[0];
    if (!item) {
      res.status(404).type("html").send(html);
      return;
    }
    const types: Record<string, string> = {
      Hotel: "Hotel",
      Restaurant: "Restaurant",
      Marina: "LocalBusiness",
    };
    const structured = JSON.stringify({
      "@context": "https://schema.org",
      "@type": types[item.category] || "LocalBusiness",
      name: item.name,
      description: item.blurb,
      address: { "@type": "PostalAddress", addressLocality: item.city },
    }).replace(/</g, "\\u003c");
    const meta =
      '<meta name="description" content="' + escapeHTML(item.blurb) + '">';
    res.type("html").send(
      html
        .replace(
          /<title>[^<]*<\/title>/,
          () =>
            "<title>" +
            escapeHTML(item.name) +
            " | Property Inquiry Hub</title>",
        )
        .replace(/<meta name="description" content="[^"]*">/, () => meta)
        .replace(
          "</head>",
          () =>
            '<script type="application/ld+json">' +
            structured +
            "</script></head>",
        ),
    );
  });
  app.use(express.static(resolve("dist"), { index: false }));
  const errors: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof z.ZodError || err.status === 400 || err.status === 413) {
      res
        .status(err.status === 413 ? 413 : 400)
        .json({ error: "Check the fields and try again." });
      return;
    }
    console.error("Request failed", err?.code || err?.name);
    res.status(500).json({ error: "Unable to complete this request." });
  };
  app.use(errors);
  return app;
}
