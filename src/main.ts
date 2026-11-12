import pg from "pg";
import { makeApp } from "./app.js";
import { demoCRM, hubspotCRM, syncNext } from "./crm.js";
import { migrate } from "./migrate.js";
const { Pool } = pg;
function required(key: string) {
  const value = process.env[key];
  if (!value) throw new Error(key + " is required");
  return value;
}
const db = new Pool({ connectionString: required("DATABASE_URL") });
const staffToken = required("STAFF_API_TOKEN");
if (staffToken.length < 16)
  throw new Error("STAFF_API_TOKEN must contain at least 16 characters");
const mode = process.env.CRM_MODE || "demo";
if (mode !== "demo" && mode !== "hubspot")
  throw new Error("CRM_MODE must be demo or hubspot");
const crm =
  mode === "demo"
    ? demoCRM
    : hubspotCRM({
        token: required("HUBSPOT_TOKEN"),
        pipeline: required("HUBSPOT_PIPELINE_ID"),
        stage: required("HUBSPOT_DEAL_STAGE_ID"),
        keyProperty:
          process.env.HUBSPOT_DEAL_ID_PROPERTY || "property_hub_inquiry_id",
      });
await migrate(db);
const server = makeApp(db, crm, staffToken, mode).listen(
  Number(process.env.PORT || 3000),
  process.env.HOST || "127.0.0.1",
  () => {
    console.log("Property Inquiry Hub listening", server.address());
  },
);
let worker: Promise<unknown> | undefined;
const timer = setInterval(() => {
  if (!worker)
    worker = syncNext(db, crm)
      .catch((e) => console.error("Sync worker failed", e?.code || e?.name))
      .finally(() => {
        worker = undefined;
      });
}, 3000);
for (const event of ["SIGTERM", "SIGINT"])
  process.once(event, () => {
    clearInterval(timer);
    server.close(async () => {
      await worker;
      await db.end();
    });
  });
