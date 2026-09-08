-- Seed reference data. Re-runnable: labels/order are refreshed, `active` is
-- left alone so an operator can retire an option without it coming back.

INSERT INTO ref_options (category, code, label, sort_order, meta) VALUES
  ('status', 'NEW_LEAD',          'New Lead',          10, '{"tone":"new"}'),
  ('status', 'CONTACTED',         'Contacted',         20, '{"tone":"progress"}'),
  ('status', 'QUOTED',            'Quoted',            30, '{"tone":"progress"}'),
  ('status', 'AWAITING_CUSTOMER', 'Awaiting Customer', 40, '{"tone":"waiting"}'),
  ('status', 'CONFIRMED',         'Confirmed',         50, '{"tone":"good"}'),
  ('status', 'GOING',             'Going',             60, '{"tone":"active"}'),
  ('status', 'COMPLETED',         'Completed',         70, '{"tone":"done"}'),
  ('status', 'CANCELLED',         'Cancelled',         80, '{"tone":"bad"}'),
  ('status', 'NO_SHOW',           'No Show',           90, '{"tone":"bad"}'),

  ('priority', 'LOW',    'Low',    10, '{}'),
  ('priority', 'NORMAL', 'Normal', 20, '{}'),
  ('priority', 'HIGH',   'High',   30, '{}'),
  ('priority', 'URGENT', 'Urgent', 40, '{}'),

  ('payment_status', 'UNPAID',         'Unpaid',         10, '{}'),
  ('payment_status', 'INVOICED',       'Invoiced',       20, '{}'),
  ('payment_status', 'PAID',           'Paid',           30, '{}'),
  ('payment_status', 'REFUNDED',       'Refunded',       40, '{}'),
  ('payment_status', 'NOT_APPLICABLE', 'Not applicable', 50, '{}'),

  ('journey_type', 'AIRPORT_TRANSFER', 'Airport Transfer',           10, '{}'),
  ('journey_type', 'EXECUTIVE',        'Executive / Point-to-Point', 20, '{}'),
  ('journey_type', 'HOURLY',           'Hourly / As Directed',       30, '{}'),
  ('journey_type', 'VIP',              'VIP & Artists',              40, '{}'),
  ('journey_type', 'WEDDING_EVENT',    'Wedding / Event',            50, '{}'),
  ('journey_type', 'LONG_DISTANCE',    'Long Distance / Nationwide', 60, '{}'),
  ('journey_type', 'OTHER',            'Other',                      70, '{}'),

  ('vehicle', 'ROLLS_ROYCE',       'Rolls-Royce',              10, '{}'),
  ('vehicle', 'MERCEDES_S_CLASS',  'Mercedes S-Class',         20, '{}'),
  ('vehicle', 'MERCEDES_V_CLASS',  'Mercedes V-Class',         30, '{}'),
  ('vehicle', 'RANGE_ROVER',       'Range Rover',              40, '{}'),
  ('vehicle', 'RECOMMEND',         'Not sure — recommend one', 50, '{}'),

  ('luggage', 'NONE',      'No luggage',           10, '{}'),
  ('luggage', 'ONE',       '1 bag',                20, '{}'),
  ('luggage', 'TWO',       '2 bags',               30, '{}'),
  ('luggage', 'THREE',     '3 bags',               40, '{}'),
  ('luggage', 'FOUR_PLUS', '4+ bags / oversized',  50, '{}')
ON CONFLICT (category, code) DO UPDATE
  SET label = EXCLUDED.label,
      sort_order = EXCLUDED.sort_order,
      meta = EXCLUDED.meta;
