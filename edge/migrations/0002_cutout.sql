-- Phase 3.5a: transparent-background cutouts of the FLUX species art.
-- The queue consumer chroma-keys the warm cream ground to alpha=0 and stores
-- the cutout PNG; these columns cache the R2 keys for the dashboard collage.

ALTER TABLE species ADD COLUMN flux_perched_cut_key TEXT;
ALTER TABLE species ADD COLUMN flux_flight_cut_key  TEXT;
