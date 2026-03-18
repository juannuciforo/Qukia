const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.user.findMany({
  select: { id:true, email:true, name:true, role:true, isActive:true, tenantId:true }
}).then(u => {
  console.table(u);
  p.$disconnect();
});