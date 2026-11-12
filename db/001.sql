CREATE TABLE IF NOT EXISTS properties (
  slug text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  city text NOT NULL,
  headline text NOT NULL,
  blurb text NOT NULL,
  draft_headline text,
  draft_blurb text
);
CREATE TABLE IF NOT EXISTS inquiries (
  id uuid PRIMARY KEY,
  property_slug text NOT NULL REFERENCES properties(slug),
  name text NOT NULL,
  email text NOT NULL,
  message text NOT NULL,
  campaign jsonb NOT NULL DEFAULT '{}',
  request_key uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new','contacted','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inquiries_property_date ON inquiries(property_slug,created_at DESC);
CREATE TABLE IF NOT EXISTS crm_jobs (
  inquiry_id uuid PRIMARY KEY REFERENCES inquiries(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','retry','synced','failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_until timestamptz,
  last_error text,
  contact_id text,
  deal_id text
);
CREATE INDEX IF NOT EXISTS crm_job_queue ON crm_jobs(status,next_attempt);
INSERT INTO properties (slug,name,category,city,headline,blurb) VALUES
 ('harbor-inn','Harbor House Inn','Hotel','Falmouth, MA','A quieter stay on the harbor','Ask about group stays, meeting space, or a weekend on the coast.'),
 ('tidewater-marina','Tidewater Marina','Marina','Newport, RI','Make the harbor your next stop','Ask about short stays, seasonal slips, or dockside services.'),
 ('pine-room','The Pine Room','Restaurant','Lincoln, NH','Gather around a good table','Ask about a private dinner, a team gathering, or a family celebration.')
ON CONFLICT (slug) DO NOTHING;
