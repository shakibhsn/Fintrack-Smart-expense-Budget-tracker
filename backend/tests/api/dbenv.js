// Points in-process service/Prisma usage at the same test database the API server uses.
const fs = require('fs');
const envPath = require('path').join(__dirname, '..', '..', '.env');
const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const m = env.match(/^DATABASE_URL="?([^"\r\n]+)"?/m) || [];
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || m[1].replace('/fintrack?', '/fintrack_test?');
// HARD SAFETY RULE: automated tests only ever run against a database whose NAME contains "test" (e.g. fintrack_test), never the real one.
if (!/\/[^/?]*test[^/?]*(\?|$)/i.test(process.env.DATABASE_URL)) throw new Error('Refusing to run tests: the database name must contain "test" (use fintrack_test).');
process.env.RECURRING_SCHEDULER = 'off';
module.exports = {
  prisma: require('../../src/config/prisma'),
  svc: require('../../src/services/recurringService'),
  scheduler: require('../../src/services/recurringScheduler'),
};
