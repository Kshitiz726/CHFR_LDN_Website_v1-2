// Every test runs against a real in-process PostgreSQL (PGlite), never a mock,
// so the SQL under test is the SQL that ships.
process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'pglite';
process.env.APP_URL = 'https://chfr.test';
process.env.ADMIN_EMAIL = 'CHFRLONDON@GMAIL.COM';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret-that-is-long-enough-000';
process.env.IP_HASH_SALT = 'test-ip-salt';
process.env.EMAIL_ENABLED = 'true';
process.env.WHATSAPP_ENABLED = 'false';
process.env.CHFR_WHATSAPP_NUMBER = '+447700900999';
process.env.SPREADSHEET_PROVIDER = 'none';
process.env.LOG_LEVEL = 'silent';
process.env.BOOKING_RATE_LIMIT_MAX = '1000';
process.env.LOGIN_RATE_LIMIT_MAX = '1000';
