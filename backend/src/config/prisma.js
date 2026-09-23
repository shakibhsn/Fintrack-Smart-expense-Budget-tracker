const { PrismaClient } = require('@prisma/client');

// Single shared Prisma Client instance for the whole app
const prisma = new PrismaClient();

module.exports = prisma;
