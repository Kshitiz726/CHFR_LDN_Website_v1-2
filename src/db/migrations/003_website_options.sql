-- Reference data for the options the public website actually offers.
--
-- The website is the source of truth for what a customer can pick; this file
-- makes the database agree with it. Labels match the site's own wording so a
-- booking reads the same in the dashboard as the customer saw it.
--
-- Re-runnable, like 002.

INSERT INTO ref_options (category, code, label, sort_order, meta) VALUES
  -- Luggage bands as grouped on the site, replacing the per-bag codes.
  ('luggage', 'NONE',        'None / hand luggage', 10, '{}'),
  ('luggage', 'BAGS_1_2',    '1-2 bags',            20, '{}'),
  ('luggage', 'BAGS_3_4',    '3-4 bags',            30, '{}'),
  ('luggage', 'BAGS_5_PLUS', '5+ bags',             40, '{}'),

  -- Journey types offered on the site but not previously seeded.
  ('journey_type', 'FULL_DAY',         'Full-Day Hire',    35, '{}'),
  ('journey_type', 'CORPORATE',        'Corporate',        55, '{}'),
  ('journey_type', 'PRIVATE_AVIATION', 'Private Aviation', 65, '{}')
ON CONFLICT (category, code) DO UPDATE
  SET label = EXCLUDED.label,
      sort_order = EXCLUDED.sort_order,
      meta = EXCLUDED.meta;

-- Retire the per-bag luggage codes. They are deactivated rather than deleted so
-- bookings already taken under them still render their original label.
UPDATE ref_options
   SET active = FALSE
 WHERE category = 'luggage'
   AND code IN ('ONE', 'TWO', 'THREE', 'FOUR_PLUS');
