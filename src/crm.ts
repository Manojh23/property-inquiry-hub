import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type Lead = {
  id: string;
  property_slug: string;
  name: string;
  email: string;
  message: string;
  campaign: Record<string, string>;
};
export type CRM = (
  lead: Lead,
) => Promise<{ contactId: string; dealId: string }>;
export const demoCRM: CRM = async (lead) => ({
  contactId: "demo-" + lead.email,
  dealId: "demo-" + lead.id,
});
export class CRMError extends Error {
  constructor(
    public status: number,
    public retrySeconds = 0,
  ) {
    super("CRM HTTP " + status);
  }
}

export function hubspotCRM(
  config: {
    token: string;
    pipeline: string;
    stage: string;
    keyProperty: string;
  },
  send = fetch,
): CRM {
  async function request(path: string, method: string, body?: unknown) {
    const result = await send("https://api.hubapi.com" + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        authorization: "Bearer " + config.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!result.ok || result.status === 207) {
      const header = result.headers.get("retry-after");
      const delay = header === null ? 0 : Number(header);
      const seconds = Number.isFinite(delay)
        ? delay
        : Math.ceil((Date.parse(header || "") - Date.now()) / 1000);
      throw new CRMError(result.status, Math.max(0, seconds || 0));
    }
    return result.status === 204 ? null : result.json();
  }
  function idOf(payload: unknown) {
    const id = (payload as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !/^\d+$/.test(id))
      throw new Error("CRM did not return a record ID");
    return id;
  }
  async function findOrCreate(
    type: "contacts" | "deals",
    key: string,
    value: string,
    properties: Record<string, string>,
  ) {
    const base = "/crm/v3/objects/" + type;
    const lookup =
      base +
      "/" +
      encodeURIComponent(value) +
      "?idProperty=" +
      encodeURIComponent(key);
    try {
      return idOf(await request(lookup, "GET"));
    } catch (e) {
      if (!(e instanceof CRMError) || e.status !== 404) throw e;
    }
    try {
      return idOf(await request(base, "POST", { properties }));
    } catch (e) {
      if (!(e instanceof CRMError) || e.status !== 409) throw e;
      return idOf(await request(lookup, "GET"));
    }
  }
  return async (lead) => {
    const [firstname, ...rest] = lead.name.trim().split(/\s+/);
    const contactId = await findOrCreate("contacts", "email", lead.email, {
      email: lead.email,
      firstname,
      lastname: rest.join(" "),
    });
    const attribution = Object.entries(lead.campaign)
      .map(([k, v]) => k + "=" + v)
      .join(", ");
    const dealId = await findOrCreate("deals", config.keyProperty, lead.id, {
      [config.keyProperty]: lead.id,
      dealname: lead.property_slug + " inquiry • " + lead.id.slice(0, 8),
      pipeline: config.pipeline,
      dealstage: config.stage,
      description:
        lead.message + (attribution ? "\n\nCampaign: " + attribution : ""),
    });
    await request(
      "/crm/v4/objects/deals/" +
        dealId +
        "/associations/default/contacts/" +
        contactId,
      "PUT",
    );
    return { contactId, dealId };
  };
}

export async function syncNext(db: Pool, crm: CRM) {
  await db.query(`UPDATE crm_jobs SET status='failed', last_error='Worker lease expired', claim_token=NULL, lease_until=NULL
    WHERE status='sending' AND lease_until<=now() AND attempts>=5`);
  const claim = randomUUID();
  const found = await db.query<Lead & { attempts: number }>(
    `
    WITH candidate AS (
      SELECT inquiry_id FROM crm_jobs
      WHERE (status IN ('pending','retry') AND next_attempt<=now()) OR (status='sending' AND lease_until<=now() AND attempts<5)
      ORDER BY next_attempt,inquiry_id FOR UPDATE SKIP LOCKED LIMIT 1
    ), job AS (
      UPDATE crm_jobs j SET status='sending', attempts=attempts+1,
      claim_token=$1, lease_until=now()+interval '2 minutes'
      FROM candidate c WHERE j.inquiry_id=c.inquiry_id RETURNING j.inquiry_id,j.attempts
    ) SELECT i.*,job.attempts FROM job JOIN inquiries i ON i.id=job.inquiry_id`,
    [claim],
  );
  const lead = found.rows[0];
  if (!lead) return null;
  try {
    const result = await crm(lead);
    const completed = await db.query(
      `UPDATE crm_jobs SET status='synced',contact_id=$3,deal_id=$4,last_error=NULL,
      lease_until=NULL,claim_token=NULL WHERE inquiry_id=$1 AND claim_token=$2`,
      [lead.id, claim, result.contactId, result.dealId],
    );
    return completed.rowCount === 1 ? "synced" : "lease_lost";
  } catch (error) {
    const code = error instanceof CRMError ? error.status : 0;
    const transient = code === 0 || code === 408 || code === 429 || code >= 500;
    const status = transient && lead.attempts < 5 ? "retry" : "failed";
    const delay = Math.min(
      86400,
      Math.max(
        2 ** lead.attempts * 5,
        error instanceof CRMError ? error.retrySeconds : 0,
      ),
    );
    const completed = await db.query(
      `UPDATE crm_jobs SET status=$3,next_attempt=now()+($4 * interval '1 second'),
      last_error=$5,lease_until=NULL,claim_token=NULL WHERE inquiry_id=$1 AND claim_token=$2`,
      [
        lead.id,
        claim,
        status,
        delay,
        code ? "CRM HTTP " + code : "CRM response unavailable",
      ],
    );
    return completed.rowCount === 1 ? status : "lease_lost";
  }
}
