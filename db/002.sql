ALTER TABLE inquiries ADD COLUMN follow_up_at timestamptz;
ALTER TABLE inquiries ADD COLUMN owner text;
UPDATE inquiries SET follow_up_at=created_at + interval '24 hours' WHERE stage='new';

CREATE TABLE inquiry_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inquiry_id uuid NOT NULL REFERENCES inquiries(id),
  kind text NOT NULL CHECK (kind IN ('received','stage','follow_up')),
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inquiry_events_recent ON inquiry_events(inquiry_id,id DESC);
CREATE INDEX inquiries_follow_up ON inquiries(follow_up_at) WHERE stage<>'closed' AND follow_up_at IS NOT NULL;
INSERT INTO inquiry_events (inquiry_id,kind,details,created_at)
SELECT id,'received',jsonb_build_object('property',property_slug),created_at FROM inquiries;
